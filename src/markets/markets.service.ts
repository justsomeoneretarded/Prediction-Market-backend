import { Injectable, Logger } from '@nestjs/common';
import { Category, Market, MarketStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService, Tx } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { AuditService } from '../common/audit.service';
import { LedgerService } from '../ledger/ledger.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { DomainError, notFound } from '../common/errors';
import { D, Dec, MarketState, ceilTo, clampPrice, dec, maxLoss, priceYes } from '../lmsr/lmsr';
import { money, shares } from '../common/money';

export const CATEGORIES = Object.values(Category);

const marketFields = {
  question: z.string().trim().min(10).max(200),
  questionAm: z.string().trim().max(300).optional().nullable(),
  description: z.string().trim().min(10).max(4000),
  category: z.enum(Category),
  yesLabel: z.string().trim().min(1).max(40).default('Yes'),
  noLabel: z.string().trim().min(1).max(40).default('No'),
  imageEmoji: z.string().max(8).optional().nullable(),
  featured: z.boolean().default(false),
  isDemo: z.boolean().default(false),
  opensAt: z.coerce.date(),
  closesAt: z.coerce.date(),
  resolvesAt: z.coerce.date(),
  resolutionRules: z.string().trim().min(10).max(4000),
  sourcePrimary: z.string().trim().min(3).max(500),
  sourceBackup: z.string().trim().max(500).optional().nullable(),
  cancellationRules: z.string().trim().min(10).max(2000),
  cancellationPolicy: z.enum(['REFUND_NET_COST', 'LAST_PRICE']).default('REFUND_NET_COST'),
  disputeHours: z.number().int().min(0).max(24 * 14).default(24),
  // liquidity
  initialProbability: z.coerce.number().min(0.01).max(0.99).default(0.5),
  liquidityB: z.coerce.number().min(10).max(1_000_000).default(1000),
  feeBps: z.number().int().min(0).max(1000).default(100),
  riskBudget: z.coerce.number().min(1).max(10_000_000).optional(),
  maxTradeAmount: z.coerce.number().min(1).max(10_000_000).default(50_000),
};

export const createMarketSchema = z
  .object({ ...marketFields, publish: z.boolean().default(false) })
  .refine((m) => m.opensAt < m.closesAt, { message: 'opensAt must be before closesAt', path: ['closesAt'] })
  .refine((m) => m.closesAt <= m.resolvesAt, { message: 'resolvesAt must be on/after closesAt', path: ['resolvesAt'] });

export const updateMarketSchema = z.object(marketFields).partial();

const LIQUIDITY_FIELDS = ['initialProbability', 'liquidityB', 'feeBps', 'riskBudget'] as const;
const TRADABLE: MarketStatus[] = ['OPEN'];

export const stateOf = (m: Pick<Market, 'liquidityB' | 'initialProbability' | 'yesShares' | 'noShares'>): MarketState => ({
  b: dec(m.liquidityB),
  p0: dec(m.initialProbability),
  yesShares: dec(m.yesShares),
  noShares: dec(m.noShares),
});

@Injectable()
export class MarketsService {
  private readonly log = new Logger('Markets');
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly rt: RealtimeGateway,
  ) {}

  // ─────────────────────────── read ───────────────────────────

  view(m: Market & { fixture?: unknown }) {
    const yes = dec(m.lastYesPrice);
    return {
      id: m.id,
      slug: m.slug,
      question: m.question,
      questionAm: m.questionAm,
      description: m.description,
      category: m.category,
      type: m.type,
      yesLabel: m.yesLabel,
      noLabel: m.noLabel,
      imageEmoji: m.imageEmoji,
      isDemo: m.isDemo,
      featured: m.featured,
      opensAt: m.opensAt,
      closesAt: m.closesAt,
      resolvesAt: m.resolvesAt,
      status: m.status,
      tradingHalted: m.tradingHalted,
      haltReason: m.haltReason,
      yesPrice: yes.toFixed(4),
      noPrice: new D(1).minus(yes).toFixed(4),
      volume: money(m.volume),
      tradesCount: m.tradesCount,
      liquidityB: dec(m.liquidityB).toFixed(2),
      initialProbability: dec(m.initialProbability).toFixed(4),
      feeBps: m.feeBps,
      subsidy: money(m.subsidy),
      maxTradeAmount: money(m.maxTradeAmount),
      yesShares: shares(m.yesShares),
      noShares: shares(m.noShares),
      resolutionRules: m.resolutionRules,
      sourcePrimary: m.sourcePrimary,
      sourceBackup: m.sourceBackup,
      cancellationRules: m.cancellationRules,
      cancellationPolicy: m.cancellationPolicy,
      disputeHours: m.disputeHours,
      resolvedOutcome: m.resolvedOutcome,
      resolvedAt: m.resolvedAt,
      settledAt: m.settledAt,
      fixture: m.fixture ?? null,
      createdAt: m.createdAt,
    };
  }

  async list(q: { category?: string; search?: string; sort?: string; status?: string; limit?: number; featured?: boolean; ids?: string[] }) {
    const now = this.clock.now();
    const where: Prisma.MarketWhereInput = {
      status: q.status === 'all'
        ? { not: 'DRAFT' }
        : q.status === 'resolved'
          ? { in: ['RESOLVED', 'CANCELLED'] }
          : q.status === 'closed'
            ? { in: ['CLOSED', 'AWAITING_RESOLUTION', 'DISPUTED'] }
            : 'OPEN',
      ...(q.category && CATEGORIES.includes(q.category as Category) ? { category: q.category as Category } : {}),
      ...(q.category === 'FOOTBALL' ? { category: { in: ['ETHIOPIAN_FOOTBALL', 'PREMIER_LEAGUE', 'CHAMPIONS_LEAGUE', 'INTERNATIONAL_FOOTBALL'] } } : {}),
      ...(q.category === 'ENTERTAINMENT_ALL' ? { category: { in: ['MUSIC', 'TELEVISION', 'ENTERTAINMENT', 'CULTURE'] } } : {}),
      ...(q.featured ? { featured: true } : {}),
      ...(q.ids ? { id: { in: q.ids } } : {}),
      ...(q.search
        ? { OR: [{ question: { contains: q.search, mode: 'insensitive' } }, { questionAm: { contains: q.search } }, { description: { contains: q.search, mode: 'insensitive' } }] }
        : {}),
    };
    const take = Math.min(q.limit ?? 24, 100);
    let orderBy: Prisma.MarketOrderByWithRelationInput[] = [{ volume: 'desc' }];
    if (q.sort === 'new') orderBy = [{ createdAt: 'desc' }];
    if (q.sort === 'closing') {
      orderBy = [{ closesAt: 'asc' }];
      if (where.status === 'OPEN') where.closesAt = { gt: now };
    }

    if (q.sort === 'trending') {
      // trending = traded volume in the last 24h
      const since = new Date(now.getTime() - 24 * 3600_000);
      const hot = await this.prisma.trade.groupBy({
        by: ['marketId'], where: { createdAt: { gte: since } }, _sum: { amount: true }, orderBy: { _sum: { amount: 'desc' } }, take: 50,
      });
      const ids = hot.map((h) => h.marketId);
      const rows = await this.prisma.market.findMany({ where: { ...where, id: { in: ids } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as Market[];
      if (ordered.length < take) {
        const rest = await this.prisma.market.findMany({ where: { ...where, id: { notIn: ids } }, orderBy: [{ tradesCount: 'desc' }], take: take - ordered.length });
        ordered.push(...rest);
      }
      return ordered.slice(0, take).map((m) => this.view(m));
    }
    const rows = await this.prisma.market.findMany({ where, orderBy, take });
    return rows.map((m) => this.view(m));
  }

  async getRaw(idOrSlug: string) {
    const m = await this.prisma.market.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] }, include: { fixture: true } });
    if (!m) throw notFound('Market');
    return m;
  }

  async get(idOrSlug: string, opts: { includeDraft?: boolean } = {}) {
    const m = await this.getRaw(idOrSlug);
    if (m.status === 'DRAFT' && !opts.includeDraft) throw notFound('Market');
    const [recentTrades, related, proposal] = await Promise.all([
      this.recentTrades(m.id, 20),
      this.prisma.market.findMany({ where: { category: m.category, id: { not: m.id }, status: 'OPEN' }, orderBy: { volume: 'desc' }, take: 4 }),
      this.prisma.resolutionProposal.findFirst({
        where: { marketId: m.id, status: { in: ['PENDING_REVIEW', 'CONFIRMED', 'DISPUTED', 'FINALIZED'] } },
        orderBy: { createdAt: 'desc' },
        include: { disputes: { select: { id: true, status: true, reason: true, createdAt: true } } },
      }),
    ]);
    return {
      ...this.view(m),
      liquidity: this.liquiditySummary(m),
      recentTrades,
      related: related.map((r) => this.view(r)),
      proposal,
      now: this.clock.now(),
    };
  }

  async recentTrades(marketId: string, take = 20) {
    const trades = await this.prisma.trade.findMany({
      where: { marketId }, orderBy: { createdAt: 'desc' }, take, include: { user: { select: { username: true } } },
    });
    return trades.map((t) => ({
      id: t.id, side: t.side, outcome: t.outcome, shares: shares(t.shares), amount: money(t.amount),
      avgPrice: dec(t.avgPrice).toFixed(4), yesPriceAfter: dec(t.yesPriceAfter).toFixed(4), username: t.user.username, createdAt: t.createdAt,
    }));
  }

  async priceHistory(idOrSlug: string, range: string) {
    const m = await this.getRaw(idOrSlug);
    const now = this.clock.now().getTime();
    const ms = { '1h': 3600e3, '1d': 86400e3, '1w': 7 * 86400e3, '1m': 30 * 86400e3 }[range] ?? null;
    const points = await this.prisma.pricePoint.findMany({
      where: { marketId: m.id, ...(ms ? { at: { gte: new Date(now - ms) } } : {}) },
      orderBy: { at: 'asc' },
      select: { yesPrice: true, at: true },
      take: 5000,
    });
    // carry the last known price into the window so the chart starts at the right level
    if (ms) {
      const before = await this.prisma.pricePoint.findFirst({ where: { marketId: m.id, at: { lt: new Date(now - ms) } }, orderBy: { at: 'desc' } });
      if (before) points.unshift({ yesPrice: before.yesPrice, at: new Date(now - ms) });
    }
    return downsample(points.map((p) => ({ t: p.at.getTime(), p: Number(dec(p.yesPrice).toFixed(4)) })), 300);
  }

  /** Market-maker economics for one market (all derived from authoritative state). */
  liquiditySummary(m: Market, escrowBalance?: Dec) {
    const st = stateOf(m);
    const bound = maxLoss(st);
    const y = dec(m.yesShares);
    const n = dec(m.noShares);
    const subsidy = dec(m.subsidy);
    const escrow = escrowBalance ?? null;
    const traderCash = escrow ? escrow.minus(subsidy) : null; // net cash traders have paid in
    const pnlIfYes = traderCash ? traderCash.minus(y) : null;   // operator P&L if YES wins
    const pnlIfNo = traderCash ? traderCash.minus(n) : null;
    const worst = pnlIfYes && pnlIfNo ? D.min(pnlIfYes, pnlIfNo) : null;
    return {
      liquidityB: dec(m.liquidityB).toFixed(2),
      subsidy: money(subsidy),
      maxLossBound: money(bound),
      riskBudget: money(m.riskBudget),
      escrow: escrow ? money(escrow) : null,
      traderNetCash: traderCash ? money(traderCash) : null,
      payoutIfYes: money(y),
      payoutIfNo: money(n),
      operatorPnlIfYes: pnlIfYes ? money(pnlIfYes) : null,
      operatorPnlIfNo: pnlIfNo ? money(pnlIfNo) : null,
      currentExposure: worst ? money(D.max(worst.neg(), 0)) : null,
      reserveCoverage: escrow ? money(escrow.minus(D.max(y, n))) : null, // escrow left after the worst payout
    };
  }

  async risk(idOrSlug: string) {
    const m = await this.getRaw(idOrSlug);
    const escrowId = await this.ledger.account(this.prisma, 'MARKET_ESCROW', { marketId: m.id });
    const escrow = await this.ledger.balance(this.prisma, escrowId);
    return { market: this.view(m), ...this.liquiditySummary(m, escrow) };
  }

  // ─────────────────────────── admin ───────────────────────────

  async create(input: z.infer<typeof createMarketSchema>, actorId: string | null, extra: Partial<Prisma.MarketUncheckedCreateInput> = {}) {
    const p0 = dec(input.initialProbability).toDecimalPlaces(4);
    const b = dec(input.liquidityB);
    const required = ceilTo(maxLoss({ b, p0 }), 2);
    const riskBudget = input.riskBudget ? dec(input.riskBudget) : required;
    if (riskBudget.lt(required)) {
      throw new DomainError(
        `Liquidity b=${b} at ${p0.mul(100)}% needs up to ${money(required)} birr of market-maker collateral, above the risk budget of ${money(riskBudget)}. Lower b or raise the budget.`,
      );
    }
    const { publish, ...fields } = input;
    const market = await this.prisma.market.create({
      data: {
        ...fields,
        ...extra,
        slug: await this.uniqueSlug(input.question),
        initialProbability: p0.toFixed(6),
        liquidityB: b.toFixed(6),
        riskBudget: money(riskBudget),
        maxTradeAmount: money(input.maxTradeAmount),
        lastYesPrice: p0.toFixed(8),
        status: 'DRAFT',
        createdById: actorId,
      },
    });
    await this.audit.log({ actorId, action: 'market.create', entityType: 'Market', entityId: market.id, data: { question: market.question } });
    if (publish) return this.publish(market.id, actorId);
    return market;
  }

  async update(id: string, input: z.infer<typeof updateMarketSchema>, actorId: string) {
    const m = await this.getRaw(id);
    const touchesLiquidity = LIQUIDITY_FIELDS.some((f) => input[f] !== undefined);
    if (touchesLiquidity && m.status !== 'DRAFT') {
      throw new DomainError('Liquidity settings are locked once a market is published. Cancel and recreate the market instead.', 409);
    }
    if (['RESOLVED', 'CANCELLED'].includes(m.status)) throw new DomainError('Finished markets cannot be edited', 409);
    if ((input.closesAt || input.opensAt) && m.tradesCount > 0 && input.opensAt) throw new DomainError('Opening time cannot change after trading started', 409);
    const data: Prisma.MarketUpdateInput = { ...input } as Prisma.MarketUpdateInput;
    if (input.initialProbability !== undefined) {
      data.initialProbability = dec(input.initialProbability).toFixed(6);
      data.lastYesPrice = dec(input.initialProbability).toFixed(8);
    }
    const updated = await this.prisma.market.update({ where: { id: m.id }, data });
    if (updated.opensAt >= updated.closesAt || updated.closesAt > updated.resolvesAt) throw new DomainError('Invalid dates');
    await this.audit.log({ actorId, action: 'market.update', entityType: 'Market', entityId: m.id, data: input });
    this.broadcast(updated);
    return updated;
  }

  /**
   * Publish: fund the worst-case LMSR loss from the company reserve into the market's
   * escrow, then schedule or open the market. After this, b/p0/fee are locked.
   */
  async publish(id: string, actorId: string | null) {
    const m = await this.prisma.atomic(async (tx) => {
      const m = await this.lockMarket(tx, id);
      if (m.status !== 'DRAFT') throw new DomainError('Only draft markets can be published', 409);
      const now = this.clock.now();
      if (m.closesAt <= now) throw new DomainError('Closing time is in the past');
      const subsidy = ceilTo(maxLoss(stateOf(m)), 2);
      if (subsidy.gt(dec(m.riskBudget))) throw new DomainError('Required collateral exceeds the market risk budget');
      const reserve = await this.ledger.account(tx, 'COMPANY_RESERVE');
      const escrow = await this.ledger.account(tx, 'MARKET_ESCROW', { marketId: m.id });
      await this.ledger.post(tx, {
        kind: 'LIQUIDITY_FUNDING',
        memo: `Market-maker collateral for "${m.question.slice(0, 80)}" (b=${dec(m.liquidityB).toFixed(0)})`,
        marketId: m.id,
        actorId,
        lines: [{ accountId: reserve, amount: money(subsidy.neg()) }, { accountId: escrow, amount: money(subsidy) }],
      });
      const status: MarketStatus = m.opensAt <= now ? 'OPEN' : 'SCHEDULED';
      const updated = await tx.market.update({ where: { id: m.id }, data: { status, subsidy: money(subsidy), liquidityFundedAt: now } });
      await tx.pricePoint.create({ data: { marketId: m.id, yesPrice: m.lastYesPrice, at: now } });
      await this.audit.log({ actorId, action: 'market.publish', entityType: 'Market', entityId: m.id, data: { subsidy: money(subsidy), status } }, tx);
      return updated;
    });
    this.broadcast(m);
    return m;
  }

  async setHalt(id: string, halted: boolean, reason: string, actorId: string) {
    const m = await this.prisma.market.update({ where: { id }, data: { tradingHalted: halted, haltReason: halted ? reason : null } });
    await this.audit.log({ actorId, action: halted ? 'market.suspend' : 'market.resume', entityType: 'Market', entityId: id, reason });
    this.broadcast(m);
    return m;
  }

  /** Close trading now (admin) or when closesAt passes (scheduler). */
  async close(id: string, actorId: string | null, reason = 'Closing time reached') {
    const m = await this.prisma.atomic(async (tx) => {
      const m = await this.lockMarket(tx, id);
      if (!['OPEN', 'SCHEDULED'].includes(m.status)) throw new DomainError(`Market is ${m.status.toLowerCase()}, not open`, 409);
      const now = this.clock.now();
      const updated = await tx.market.update({
        where: { id: m.id },
        data: { status: 'CLOSED', closingYesPrice: m.lastYesPrice, ...(m.closesAt > now ? { closesAt: now } : {}) },
      });
      await this.audit.log({ actorId, action: 'market.close', entityType: 'Market', entityId: m.id, reason }, tx);
      return updated;
    });
    this.broadcast(m);
    return m;
  }

  /** Scheduler tick: open scheduled markets and close expired ones. */
  async lifecycleTick() {
    const now = this.clock.now();
    const toOpen = await this.prisma.market.findMany({ where: { status: 'SCHEDULED', opensAt: { lte: now } }, select: { id: true } });
    for (const { id } of toOpen) {
      const m = await this.prisma.market.update({ where: { id }, data: { status: 'OPEN' } });
      await this.audit.log({ action: 'market.open', entityType: 'Market', entityId: id, reason: 'Opening time reached' });
      this.broadcast(m);
    }
    const toClose = await this.prisma.market.findMany({ where: { status: { in: ['OPEN', 'SCHEDULED'] }, closesAt: { lte: now } }, select: { id: true } });
    for (const { id } of toClose) {
      await this.close(id, null).catch((e) => this.log.warn(`close ${id}: ${e.message}`));
    }
    return { opened: toOpen.length, closed: toClose.length };
  }

  // ─────────────────────────── helpers ───────────────────────────

  async lockMarket(tx: Tx, id: string): Promise<Market> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Market" WHERE id = ${id} FOR UPDATE`;
    if (!rows.length) throw notFound('Market');
    return tx.market.findUniqueOrThrow({ where: { id } });
  }

  assertTradable(m: Market) {
    const now = this.clock.now();
    if (!TRADABLE.includes(m.status)) {
      throw new DomainError(
        m.status === 'SCHEDULED' ? 'This market has not opened yet' : `Trading is closed — this market is ${m.status.replace('_', ' ').toLowerCase()}`,
        409, 'MARKET_NOT_OPEN',
      );
    }
    if (m.tradingHalted) throw new DomainError(`Trading is paused: ${m.haltReason ?? 'under review'}`, 409, 'MARKET_HALTED');
    if (now >= m.closesAt) throw new DomainError('Trading has closed for this market', 409, 'MARKET_NOT_OPEN');
    if (now < m.opensAt) throw new DomainError('This market has not opened yet', 409, 'MARKET_NOT_OPEN');
  }

  broadcast(m: Market) {
    this.rt.emitMarket(m.id, 'market:update', {
      id: m.id, status: m.status, tradingHalted: m.tradingHalted,
      yesPrice: dec(m.lastYesPrice).toFixed(4), volume: money(m.volume), tradesCount: m.tradesCount,
    });
  }

  currentPrice(m: Market): Dec {
    return clampPrice(priceYes(stateOf(m)));
  }

  private async uniqueSlug(q: string) {
    const base = q.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'market';
    for (let i = 0; ; i++) {
      const slug = i === 0 ? base : `${base}-${i + 1}`;
      if (!(await this.prisma.market.findUnique({ where: { slug } }))) return slug;
    }
  }
}

function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}
