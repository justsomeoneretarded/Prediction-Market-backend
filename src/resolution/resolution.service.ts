import { Injectable, Logger } from '@nestjs/common';
import { FinalOutcome, Market, ProposalSource } from '@prisma/client';
import { PrismaService, Tx } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { AuditService } from '../common/audit.service';
import { LedgerService, LineInput } from '../ledger/ledger.service';
import { MarketsService } from '../markets/markets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { DomainError, forbidden, notFound } from '../common/errors';
import { D, Dec, dec, floorTo } from '../lmsr/lmsr';
import { money } from '../common/money';

const ACTIVE = ['PENDING_REVIEW', 'CONFIRMED', 'DISPUTED'] as const;

export interface ProposeInput {
  outcome: FinalOutcome;
  evidenceUrl: string;
  evidenceNotes: string;
}

/**
 * Resolution workflow:
 *   propose (resolver / automated provider) → review by a DIFFERENT reviewer → dispute window
 *   → (optional) disputes resolved by a reviewer/admin → finalize → settle (exactly once).
 */
@Injectable()
export class ResolutionService {
  private readonly log = new Logger('Resolution');
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly markets: MarketsService,
    private readonly notifications: NotificationsService,
    private readonly rt: RealtimeGateway,
  ) {}

  async propose(marketIdOrSlug: string, input: ProposeInput, actorId: string | null, source: ProposalSource = 'MANUAL', autoConfirm = false) {
    const m0 = await this.markets.getRaw(marketIdOrSlug);
    const result = await this.prisma.atomic(async (tx) => {
      const m = await this.markets.lockMarket(tx, m0.id);
      if (!['CLOSED', 'AWAITING_RESOLUTION'].includes(m.status)) {
        throw new DomainError(
          m.status === 'OPEN' ? 'Close trading on this market before proposing a result' : `Market is ${m.status.toLowerCase()} and cannot take a new proposal`,
          409,
        );
      }
      const active = await tx.resolutionProposal.findFirst({ where: { marketId: m.id, status: { in: [...ACTIVE] } } });
      if (active) throw new DomainError('This market already has an active resolution proposal', 409);
      const now = this.clock.now();
      const p = await tx.resolutionProposal.create({
        data: {
          marketId: m.id, outcome: input.outcome, source, evidenceUrl: input.evidenceUrl, evidenceNotes: input.evidenceNotes,
          proposedById: actorId, createdAt: now,
          ...(autoConfirm
            ? { status: 'CONFIRMED', reviewNote: 'Automatically confirmed: provider result is final and consistent', reviewedAt: now, disputeEndsAt: new Date(now.getTime() + m.disputeHours * 3600_000) }
            : {}),
        },
      });
      await tx.market.update({ where: { id: m.id }, data: { status: 'AWAITING_RESOLUTION' } });
      await this.audit.log({ actorId, action: 'resolution.propose', entityType: 'Market', entityId: m.id, data: { proposalId: p.id, outcome: p.outcome, source, evidenceUrl: p.evidenceUrl, autoConfirm } }, tx);
      return p;
    });
    await this.refresh(m0.id);
    return result;
  }

  async review(proposalId: string, approve: boolean, note: string, reviewerId: string) {
    const p0 = await this.prisma.resolutionProposal.findUnique({ where: { id: proposalId } });
    if (!p0) throw notFound('Proposal');
    if (p0.proposedById === reviewerId) throw forbidden('A second person must review this proposal (four-eyes rule)');
    const p = await this.prisma.atomic(async (tx) => {
      const m = await this.markets.lockMarket(tx, p0.marketId);
      const p = await tx.resolutionProposal.findUniqueOrThrow({ where: { id: proposalId } });
      if (p.status !== 'PENDING_REVIEW') throw new DomainError(`Proposal is ${p.status.toLowerCase()}, not awaiting review`, 409);
      const now = this.clock.now();
      const updated = await tx.resolutionProposal.update({
        where: { id: p.id },
        data: approve
          ? { status: 'CONFIRMED', reviewedById: reviewerId, reviewNote: note, reviewedAt: now, disputeEndsAt: new Date(now.getTime() + m.disputeHours * 3600_000) }
          : { status: 'REJECTED', reviewedById: reviewerId, reviewNote: note, reviewedAt: now },
      });
      await this.audit.log({ actorId: reviewerId, action: approve ? 'resolution.confirm' : 'resolution.reject', entityType: 'Market', entityId: m.id, reason: note, data: { proposalId } }, tx);
      return updated;
    });
    if (approve) await this.notifyHolders(p.marketId, 'RESOLUTION_PROPOSED', `Result proposed: ${p.outcome}`, `A result has been confirmed for review. You can dispute it until ${p.disputeEndsAt?.toISOString()}.`);
    await this.refresh(p.marketId);
    return p;
  }

  async dispute(proposalId: string, userId: string, reason: string, evidenceUrl?: string) {
    const p0 = await this.prisma.resolutionProposal.findUnique({ where: { id: proposalId } });
    if (!p0) throw notFound('Proposal');
    const traded = await this.prisma.trade.count({ where: { marketId: p0.marketId, userId } });
    if (!traded) throw forbidden('Only traders in this market can dispute its result');
    const d = await this.prisma.atomic(async (tx) => {
      const m = await this.markets.lockMarket(tx, p0.marketId);
      const p = await tx.resolutionProposal.findUniqueOrThrow({ where: { id: proposalId } });
      const now = this.clock.now();
      if (!['CONFIRMED', 'DISPUTED'].includes(p.status) || !p.disputeEndsAt || now >= p.disputeEndsAt) {
        throw new DomainError('The dispute window for this result is closed', 409);
      }
      const mine = await tx.dispute.findFirst({ where: { proposalId, userId, status: 'OPEN' } });
      if (mine) throw new DomainError('You already have an open dispute on this result', 409);
      const d = await tx.dispute.create({ data: { proposalId, userId, reason, evidenceUrl, createdAt: now } });
      await tx.resolutionProposal.update({ where: { id: p.id }, data: { status: 'DISPUTED' } });
      await tx.market.update({ where: { id: m.id }, data: { status: 'DISPUTED' } });
      await this.audit.log({ actorId: userId, action: 'resolution.dispute', entityType: 'Market', entityId: m.id, reason, data: { proposalId, disputeId: d.id } }, tx);
      return d;
    });
    await this.refresh(p0.marketId);
    return d;
  }

  /** uphold = the dispute is right → the proposal is overturned and a new one is needed. */
  async resolveDispute(disputeId: string, uphold: boolean, note: string, actorId: string) {
    const d0 = await this.prisma.dispute.findUnique({ where: { id: disputeId }, include: { proposal: true } });
    if (!d0) throw notFound('Dispute');
    if (d0.proposal.proposedById === actorId) throw forbidden('The original proposer cannot rule on disputes of their own proposal');
    await this.prisma.atomic(async (tx) => {
      const m = await this.markets.lockMarket(tx, d0.proposal.marketId);
      const d = await tx.dispute.findUniqueOrThrow({ where: { id: disputeId } });
      if (d.status !== 'OPEN') throw new DomainError('Dispute already resolved', 409);
      const now = this.clock.now();
      await tx.dispute.update({ where: { id: d.id }, data: { status: uphold ? 'UPHELD' : 'REJECTED', resolvedById: actorId, resolutionNote: note, resolvedAt: now } });
      if (uphold) {
        await tx.dispute.updateMany({
          where: { proposalId: d.proposalId, status: 'OPEN' },
          data: { status: 'UPHELD', resolvedById: actorId, resolutionNote: `Proposal overturned: ${note}`, resolvedAt: now },
        });
        await tx.resolutionProposal.update({ where: { id: d.proposalId }, data: { status: 'OVERTURNED' } });
        await tx.market.update({ where: { id: m.id }, data: { status: 'AWAITING_RESOLUTION' } });
      } else {
        const open = await tx.dispute.count({ where: { proposalId: d.proposalId, status: 'OPEN' } });
        if (open === 0) {
          await tx.resolutionProposal.update({ where: { id: d.proposalId }, data: { status: 'CONFIRMED' } });
          await tx.market.update({ where: { id: m.id }, data: { status: 'AWAITING_RESOLUTION' } });
        }
      }
      await this.audit.log({ actorId, action: uphold ? 'dispute.uphold' : 'dispute.reject', entityType: 'Market', entityId: m.id, reason: note, data: { disputeId } }, tx);
    });
    await this.notifications.notify(d0.userId, {
      type: 'DISPUTE', title: uphold ? 'Your dispute was upheld' : 'Your dispute was rejected', body: note, link: `/markets/${d0.proposal.marketId}`,
    });
    await this.refresh(d0.proposal.marketId);
    return { ok: true };
  }

  /** Finalize a confirmed proposal whose dispute window has ended, and settle the market. */
  async finalize(proposalId: string, actorId: string | null) {
    const p0 = await this.prisma.resolutionProposal.findUnique({ where: { id: proposalId } });
    if (!p0) throw notFound('Proposal');
    const summary = await this.prisma.atomic(async (tx) => {
      const m = await this.markets.lockMarket(tx, p0.marketId);
      const p = await tx.resolutionProposal.findUniqueOrThrow({ where: { id: proposalId } });
      if (m.settledAt || ['RESOLVED', 'CANCELLED'].includes(m.status)) throw new DomainError('Market is already settled', 409, 'ALREADY_SETTLED');
      if (p.status !== 'CONFIRMED') throw new DomainError(`Proposal is ${p.status.toLowerCase()}; only confirmed proposals can be finalized`, 409);
      const now = this.clock.now();
      if (!p.disputeEndsAt || now < p.disputeEndsAt) {
        throw new DomainError(`The dispute window is still open until ${p.disputeEndsAt?.toISOString()}`, 409, 'DISPUTE_WINDOW_OPEN');
      }
      await tx.resolutionProposal.update({ where: { id: p.id }, data: { status: 'FINALIZED', finalizedAt: now } });
      const s = await this.settle(tx, m, p.outcome, actorId);
      await this.audit.log({ actorId, action: 'resolution.finalize', entityType: 'Market', entityId: m.id, data: { proposalId, ...s } }, tx);
      return s;
    });
    await this.afterSettlement(p0.marketId, p0.outcome);
    return summary;
  }

  /**
   * Pay every position from the market escrow in one balanced journal entry, return the
   * remaining collateral to the company reserve, and mark the market settled.
   * The Settlement row's UNIQUE(marketId) makes double settlement impossible.
   */
  private async settle(tx: Tx, m: Market, outcome: FinalOutcome, actorId: string | null) {
    const positions = await tx.position.findMany({ where: { marketId: m.id } });
    const escrowId = await this.ledger.account(tx, 'MARKET_ESCROW', { marketId: m.id });
    const reserveId = await this.ledger.account(tx, 'COMPANY_RESERVE');
    const escrow = await this.ledger.balance(tx, escrowId);

    const payouts = new Map<string, Dec>();
    if (outcome === 'YES' || outcome === 'NO') {
      for (const p of positions) payouts.set(p.id, floorTo(dec(outcome === 'YES' ? p.yesShares : p.noShares), 2));
    } else if (m.cancellationPolicy === 'LAST_PRICE') {
      const yp = dec(m.closingYesPrice ?? m.lastYesPrice);
      for (const p of positions) payouts.set(p.id, floorTo(dec(p.yesShares).mul(yp).plus(dec(p.noShares).mul(new D(1).minus(yp))), 2));
    } else {
      // REFUND_NET_COST: give back what each trader net-paid into the pool (fees are not refunded).
      const claims = positions.map((p) => ({ id: p.id, claim: D.max(dec(p.netContributed), 0) }));
      const total = claims.reduce((s, c) => s.plus(c.claim), new D(0));
      const factor = total.gt(escrow) ? escrow.div(total) : new D(1); // pro-rata only if the pool can't cover everyone
      for (const c of claims) payouts.set(c.id, floorTo(c.claim.mul(factor), 2));
    }

    const totalPayout = [...payouts.values()].reduce((s, v) => s.plus(v), new D(0));
    if (totalPayout.gt(escrow)) throw new Error(`Settlement would overdraw escrow on ${m.id}`);
    const remainder = escrow.minus(totalPayout);

    const lines: LineInput[] = [{ accountId: escrowId, amount: escrow.neg() }];
    for (const p of positions) {
      const amt = payouts.get(p.id)!;
      if (amt.gt(0)) lines.push({ accountId: await this.ledger.account(tx, 'USER_AVAILABLE', { userId: p.userId }), amount: amt });
    }
    lines.push({ accountId: reserveId, amount: remainder });
    const entry = await this.ledger.post(tx, {
      kind: outcome === 'CANCELLED' ? 'CANCELLATION_REFUND' : 'SETTLEMENT_PAYOUT',
      memo: outcome === 'CANCELLED' ? `Market cancelled (${m.cancellationPolicy}): "${m.question.slice(0, 80)}"` : `Market resolved ${outcome}: "${m.question.slice(0, 80)}"`,
      marketId: m.id, actorId, referenceId: m.id, lines,
    });

    for (const p of positions) {
      const amt = payouts.get(p.id)!;
      const cost = dec(p.yesCost).plus(p.noCost);
      await tx.position.update({
        where: { id: p.id },
        data: { settledPayout: amt.toFixed(2), realizedPnl: dec(p.realizedPnl).plus(amt).minus(cost).toFixed(2), yesCost: 0, noCost: 0 },
      });
    }
    const now = this.clock.now();
    await tx.settlement.create({
      data: { marketId: m.id, outcome, totalPayout: money(totalPayout), returnedToReserve: money(remainder), positions: positions.length, journalEntryId: entry?.id ?? 'none' },
    });
    await tx.market.update({
      where: { id: m.id },
      data: {
        status: outcome === 'CANCELLED' ? 'CANCELLED' : 'RESOLVED', resolvedOutcome: outcome, resolvedAt: now, settledAt: now,
        lastYesPrice: outcome === 'YES' ? '0.99999900' : outcome === 'NO' ? '0.00000100' : m.lastYesPrice,
      },
    });
    for (const p of positions) {
      const amt = payouts.get(p.id)!;
      await this.notifications.notify(p.userId, {
        type: 'MARKET_RESOLVED',
        title: outcome === 'CANCELLED' ? 'Market cancelled' : `Market resolved ${outcome}`,
        body: `"${m.question}" — you received ${money(amt)} virtual birr.`,
        link: `/markets/${m.slug}`,
      }, tx);
    }
    return { outcome, escrow: money(escrow), totalPayout: money(totalPayout), returnedToReserve: money(remainder), positions: positions.length };
  }

  /** Cancel a market that has never traded (returns collateral). Traded markets go through a CANCELLED proposal. */
  async cancelUntraded(marketId: string, reason: string, actorId: string) {
    const m0 = await this.markets.getRaw(marketId);
    await this.prisma.atomic(async (tx) => {
      const m = await this.markets.lockMarket(tx, m0.id);
      if (m.tradesCount > 0) throw new DomainError('This market has trades — submit a CANCELLED resolution proposal so traders are refunded under the market rules', 409);
      if (['RESOLVED', 'CANCELLED'].includes(m.status)) throw new DomainError('Market already finished', 409);
      if (m.status === 'DRAFT') {
        await tx.market.update({ where: { id: m.id }, data: { status: 'CANCELLED', resolvedOutcome: 'CANCELLED', resolvedAt: this.clock.now() } });
      } else {
        await this.settle(tx, m, 'CANCELLED', actorId);
      }
      await this.audit.log({ actorId, action: 'market.cancel', entityType: 'Market', entityId: m.id, reason }, tx);
    });
    await this.refresh(m0.id);
  }

  /** Scheduler: finalize proposals whose dispute window has passed. */
  async finalizeDue() {
    const due = await this.prisma.resolutionProposal.findMany({ where: { status: 'CONFIRMED', disputeEndsAt: { lte: this.clock.now() } }, select: { id: true } });
    let n = 0;
    for (const { id } of due) {
      try {
        await this.finalize(id, null);
        n++;
      } catch (e) {
        this.log.warn(`finalize ${id}: ${(e as Error).message}`);
      }
    }
    return n;
  }

  listProposals(status?: string) {
    return this.prisma.resolutionProposal.findMany({
      where: status ? { status: status as never } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { market: { select: { id: true, slug: true, question: true, status: true } }, disputes: { include: { user: { select: { username: true } } } } },
    });
  }

  private async afterSettlement(marketId: string, outcome: FinalOutcome) {
    const m = await this.refresh(marketId);
    const holders = await this.prisma.position.findMany({ where: { marketId }, select: { userId: true } });
    for (const h of holders) {
      this.rt.emitUser(h.userId, 'portfolio:update', { marketId });
      this.notifications.push(h.userId, { type: 'MARKET_RESOLVED', marketId, outcome, slug: m.slug });
    }
  }

  private async notifyHolders(marketId: string, type: string, title: string, body: string) {
    const m = await this.prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    const holders = await this.prisma.position.findMany({ where: { marketId }, select: { userId: true } });
    for (const h of holders) await this.notifications.notify(h.userId, { type, title, body: `"${m.question}": ${body}`, link: `/markets/${m.slug}` });
  }

  private async refresh(marketId: string) {
    const m = await this.prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    this.markets.broadcast(m);
    return m;
  }
}
