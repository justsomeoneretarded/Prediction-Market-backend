import { Injectable, Logger } from '@nestjs/common';
import { Market, Position, Prisma, Trade } from '@prisma/client';
import { z } from 'zod';
import { PrismaService, Tx } from '../common/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { MarketsService, stateOf } from '../markets/markets.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ClockService } from '../common/clock.service';
import { DomainError } from '../common/errors';
import { decimalString, idempotencyKey } from '../common/validate';
import { D, Dec, clampPrice, dec } from '../lmsr/lmsr';
import { Quote, QuoteError, quote, serializeQuote } from '../lmsr/quote';
import { money, shares } from '../common/money';
import { PortfolioService } from '../portfolio/portfolio.service';

export const quoteSchema = z.object({
  side: z.enum(['BUY', 'SELL']),
  outcome: z.enum(['YES', 'NO']),
  mode: z.enum(['AMOUNT', 'SHARES']).default('AMOUNT'),
  value: decimalString(6),
});

export const tradeSchema = quoteSchema.extend({
  idempotencyKey,
  /** Slippage guard: reject if the YES price moved beyond this many probability points from the preview (default 5 pts). */
  maxSlippage: z.coerce.number().min(0).max(1).default(0.05),
  expectedYesPrice: decimalString(8).optional(),
});

export type TradeInput = z.infer<typeof tradeSchema>;

@Injectable()
export class TradingService {
  private readonly log = new Logger('Trading');
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly markets: MarketsService,
    private readonly rt: RealtimeGateway,
    private readonly clock: ClockService,
    private readonly portfolio: PortfolioService,
  ) {}

  private computeQuote(m: Market, input: z.infer<typeof quoteSchema>): Quote {
    try {
      const q = quote(stateOf(m), m.feeBps, input);
      if (input.side === 'BUY' && q.total.gt(dec(m.maxTradeAmount))) {
        throw new DomainError(`Maximum trade size on this market is ${money(m.maxTradeAmount)} birr`, 400, 'TRADE_LIMIT');
      }
      return q;
    } catch (e) {
      if (e instanceof QuoteError) throw new DomainError(e.message, 400, 'INVALID_TRADE');
      throw e;
    }
  }

  /** Preview — read-only, nothing is reserved. */
  async preview(marketIdOrSlug: string, input: z.infer<typeof quoteSchema>, userId?: string) {
    const m = await this.markets.getRaw(marketIdOrSlug);
    this.markets.assertTradable(m);
    const q = this.computeQuote(m, input);
    const warnings: string[] = [];
    if (userId) {
      if (input.side === 'BUY') {
        const acc = await this.prisma.account.findFirst({ where: { type: 'USER_AVAILABLE', userId } });
        if (dec(acc?.balance ?? 0).lt(q.total)) warnings.push('INSUFFICIENT_BALANCE');
      } else {
        const pos = await this.prisma.position.findUnique({ where: { userId_marketId: { userId, marketId: m.id } } });
        const held = dec(input.outcome === 'YES' ? pos?.yesShares ?? 0 : pos?.noShares ?? 0);
        if (held.lt(q.shares)) warnings.push('INSUFFICIENT_SHARES');
      }
    }
    if (q.priceImpact.abs().gte('0.1')) warnings.push('HIGH_PRICE_IMPACT');
    return { ...serializeQuote(q), feeBps: m.feeBps, warnings };
  }

  /**
   * Execute a trade atomically:
   *   lock market → lock position → re-quote from locked state → ledger post (locks accounts)
   *   → update position/market/price history → solvency check → commit.
   * Replays with the same idempotency key return the original trade without re-executing.
   */
  async execute(userId: string, marketIdOrSlug: string, input: TradeInput) {
    const prior = await this.prisma.trade.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } } });
    if (prior) return { trade: this.viewTrade(prior), replayed: true };

    const marketId = (await this.markets.getRaw(marketIdOrSlug)).id;
    let result: { trade: Trade; market: Market; position: Position };
    try {
      result = await this.prisma.atomic((tx) => this.executeInTx(tx, userId, marketId, input));
    } catch (e) {
      // a concurrent request with the same key won the race → return its result
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const won = await this.prisma.trade.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } } });
        if (won) return { trade: this.viewTrade(won), replayed: true };
      }
      throw e;
    }

    // ── after commit: side effects only (DB is already authoritative) ──
    const { trade, market, position } = result;
    this.markets.broadcast(market);
    this.rt.emitMarket(market.id, 'trade', {
      ...this.viewTrade(trade), username: (await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true } }))?.username,
    });
    this.rt.emitUser(userId, 'portfolio:update', { marketId: market.id });
    this.portfolio.snapshot(userId).catch((e) => this.log.warn(`snapshot failed: ${e.message}`));
    return { trade: this.viewTrade(trade), position: this.portfolio.viewPositionRaw(position, market), replayed: false };
  }

  private async executeInTx(tx: Tx, userId: string, marketId: string, input: TradeInput) {
    const m = await this.markets.lockMarket(tx, marketId);
    this.markets.assertTradable(m);

    await tx.position.upsert({ where: { userId_marketId: { userId, marketId } }, create: { userId, marketId }, update: {} });
    await tx.$queryRaw`SELECT id FROM "Position" WHERE "userId" = ${userId} AND "marketId" = ${marketId} FOR UPDATE`;
    const pos = await tx.position.findUniqueOrThrow({ where: { userId_marketId: { userId, marketId } } });

    const q = this.computeQuote(m, input);

    if (input.expectedYesPrice) {
      const moved = dec(m.lastYesPrice).minus(input.expectedYesPrice).abs();
      if (moved.gt(input.maxSlippage)) {
        throw new DomainError('The price moved since your preview. Review the new price and try again.', 409, 'PRICE_MOVED');
      }
    }

    const isYes = input.outcome === 'YES';
    const held = dec(isYes ? pos.yesShares : pos.noShares);
    const heldCost = dec(isYes ? pos.yesCost : pos.noCost);

    const wallet = await this.ledger.account(tx, 'USER_AVAILABLE', { userId });
    const escrow = await this.ledger.account(tx, 'MARKET_ESCROW', { marketId });
    const fees = await this.ledger.account(tx, 'FEE_REVENUE');

    let posUpdate: Prisma.PositionUpdateInput;
    let realized = new D(0);
    let entry: { id: string } | null;
    if (input.side === 'BUY') {
      entry = await this.ledger.post(tx, {
        kind: 'TRADE_BUY',
        memo: `Bought ${q.shares.toFixed(2)} ${input.outcome} @ ${q.avgPrice.toFixed(4)}`,
        marketId, referenceId: input.idempotencyKey, actorId: userId,
        lines: [
          { accountId: wallet, amount: q.total.neg() },
          { accountId: escrow, amount: q.amount },
          { accountId: fees, amount: q.fee },
        ],
      });
      posUpdate = {
        [isYes ? 'yesShares' : 'noShares']: held.plus(q.shares).toFixed(6),
        [isYes ? 'yesCost' : 'noCost']: heldCost.plus(q.total).toFixed(6),
        netContributed: dec(pos.netContributed).plus(q.amount).toFixed(2),
      };
    } else {
      if (held.lt(q.shares)) {
        throw new DomainError(`You only hold ${held.toFixed(2)} ${input.outcome} shares`, 400, 'INSUFFICIENT_SHARES');
      }
      entry = await this.ledger.post(tx, {
        kind: 'TRADE_SELL',
        memo: `Sold ${q.shares.toFixed(2)} ${input.outcome} @ ${q.avgPrice.toFixed(4)}`,
        marketId, referenceId: input.idempotencyKey, actorId: userId,
        lines: [
          { accountId: escrow, amount: q.amount.neg() },
          { accountId: wallet, amount: q.total },
          { accountId: fees, amount: q.fee },
        ],
      });
      const remaining = held.minus(q.shares);
      // average-cost method: the sold fraction carries its share of the cost basis
      const costOut = remaining.isZero() ? heldCost : heldCost.mul(q.shares).div(held);
      realized = q.total.minus(costOut);
      posUpdate = {
        [isYes ? 'yesShares' : 'noShares']: remaining.toFixed(6),
        [isYes ? 'yesCost' : 'noCost']: D.max(heldCost.minus(costOut), 0).toFixed(6),
        realizedPnl: dec(pos.realizedPnl).plus(realized).toFixed(2),
        netContributed: dec(pos.netContributed).minus(q.amount).toFixed(2),
      };
    }
    const position = await tx.position.update({ where: { id: pos.id }, data: posUpdate });

    const delta = input.side === 'BUY' ? q.shares : q.shares.neg();
    const newYes = dec(m.yesShares).plus(isYes ? delta : 0);
    const newNo = dec(m.noShares).plus(isYes ? 0 : delta);
    const newPrice = clampPrice(q.yesPriceAfter);
    const now = this.clock.now();
    const market = await tx.market.update({
      where: { id: m.id },
      data: {
        yesShares: newYes.toFixed(6),
        noShares: newNo.toFixed(6),
        volume: dec(m.volume).plus(q.amount).toFixed(2),
        tradesCount: { increment: 1 },
        lastYesPrice: newPrice.toFixed(8),
      },
    });

    // Solvency invariant: escrow must always cover the worst-case payout.
    const escrowBal = await this.ledger.balance(tx, escrow);
    if (escrowBal.lt(D.max(newYes, newNo))) {
      this.log.error(`solvency check failed on ${m.id}: escrow=${escrowBal} yes=${newYes} no=${newNo}`);
      throw new DomainError('This trade cannot be safely supported by the market reserve right now', 409, 'RESERVE_LIMIT');
    }

    await tx.pricePoint.create({ data: { marketId: m.id, yesPrice: newPrice.toFixed(8), at: now } });
    if (!entry) throw new Error('trade produced no ledger entry');
    const trade = await tx.trade.create({
      data: {
        marketId: m.id, userId, side: input.side, outcome: input.outcome,
        shares: q.shares.toFixed(6), amount: q.amount.toFixed(2), fee: q.fee.toFixed(2),
        avgPrice: q.avgPrice.toFixed(8), yesPriceBefore: clampPrice(q.yesPriceBefore).toFixed(8), yesPriceAfter: newPrice.toFixed(8),
        idempotencyKey: input.idempotencyKey, journalEntryId: entry.id, createdAt: now,
      },
    });
    return { trade, market, position };
  }

  viewTrade(t: Trade) {
    const total = t.side === 'BUY' ? dec(t.amount).plus(t.fee) : dec(t.amount).minus(t.fee);
    return {
      id: t.id, marketId: t.marketId, side: t.side, outcome: t.outcome, shares: shares(t.shares),
      amount: money(t.amount), fee: money(t.fee), total: money(total), avgPrice: dec(t.avgPrice).toFixed(6),
      yesPriceBefore: dec(t.yesPriceBefore).toFixed(4), yesPriceAfter: dec(t.yesPriceAfter).toFixed(4), createdAt: t.createdAt,
    };
  }
}

export type { Dec };
