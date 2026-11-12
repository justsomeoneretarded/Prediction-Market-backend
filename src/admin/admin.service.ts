import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuditService } from '../common/audit.service';
import { MarketsService } from '../markets/markets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ClockService } from '../common/clock.service';
import { DomainError, notFound } from '../common/errors';
import { D, dec } from '../lmsr/lmsr';
import { money } from '../common/money';
import { config } from '../config';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly markets: MarketsService,
    private readonly notifications: NotificationsService,
    private readonly clock: ClockService,
  ) {}

  private async sysBalance(type: 'COMPANY_RESERVE' | 'FEE_REVENUE' | 'PROMOTIONS' | 'PAYMENT_CLEARING' | 'EQUITY' | 'ADJUSTMENTS') {
    return this.ledger.balance(this.prisma, await this.ledger.account(this.prisma, type));
  }

  async overview() {
    const since = new Date(this.clock.now().getTime() - 86400_000);
    const [users, byStatus, volume, trades24, pendingProposals, openDisputes, pendingWithdrawals, customer] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.market.groupBy({ by: ['status'], _count: true }),
      this.prisma.market.aggregate({ _sum: { volume: true } }),
      this.prisma.trade.aggregate({ where: { createdAt: { gte: since } }, _count: true, _sum: { amount: true } }),
      this.prisma.resolutionProposal.count({ where: { status: 'PENDING_REVIEW' } }),
      this.prisma.dispute.count({ where: { status: 'OPEN' } }),
      this.prisma.paymentIntent.count({ where: { status: 'REQUIRES_APPROVAL' } }),
      this.prisma.account.aggregate({ where: { type: { in: ['USER_AVAILABLE', 'USER_RESERVED'] } }, _sum: { balance: true } }),
    ]);
    const risk = await this.riskAll();
    return {
      users,
      markets: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
      totalVolume: money(volume._sum.volume ?? 0),
      trades24h: trades24._count,
      volume24h: money(trades24._sum.amount ?? 0),
      queues: { pendingProposals, openDisputes, pendingWithdrawals },
      funds: {
        customerFunds: money(customer._sum.balance ?? 0),
        companyReserve: money(await this.sysBalance('COMPANY_RESERVE')),
        marketEscrow: risk.totals.escrow,
        feeRevenue: money(await this.sysBalance('FEE_REVENUE')),
        promotionsIssued: money((await this.sysBalance('PROMOTIONS')).neg()),
      },
      risk: risk.totals,
      clock: { now: this.clock.now(), offsetMs: this.clock.offset, demoMode: config().DEMO_MODE },
    };
  }

  /** Market-maker risk across all funded, unsettled markets. */
  async riskAll() {
    const ms = await this.prisma.market.findMany({ where: { liquidityFundedAt: { not: null }, settledAt: null }, orderBy: { volume: 'desc' } });
    const escrows = await this.prisma.account.findMany({ where: { type: 'MARKET_ESCROW', marketId: { in: ms.map((m) => m.id) } } });
    const byMarket = new Map(escrows.map((e) => [e.marketId, dec(e.balance)]));
    const rows = ms.map((m) => ({ id: m.id, slug: m.slug, question: m.question, status: m.status, tradingHalted: m.tradingHalted, volume: money(m.volume), yesPrice: dec(m.lastYesPrice).toFixed(4), ...this.markets.liquiditySummary(m, byMarket.get(m.id) ?? new D(0)) }));
    const sum = (k: 'escrow' | 'subsidy' | 'maxLossBound' | 'currentExposure') => money(rows.reduce((s, r) => s.plus(r[k] ?? 0), new D(0)));
    return { markets: rows, totals: { escrow: sum('escrow'), collateral: sum('subsidy'), worstCaseLoss: sum('maxLossBound'), currentExposure: sum('currentExposure') } };
  }

  /** Reconciliation: global trial balance + per-market escrow/position invariants. */
  async reconciliation() {
    const trial = await this.ledger.trialBalance();
    const issues: string[] = [];
    const ms = await this.prisma.market.findMany({ where: { liquidityFundedAt: { not: null } } });
    for (const m of ms) {
      const agg = await this.prisma.position.aggregate({ where: { marketId: m.id }, _sum: { yesShares: true, noShares: true } });
      if (!m.settledAt) {
        if (!dec(agg._sum.yesShares ?? 0).eq(dec(m.yesShares)) || !dec(agg._sum.noShares ?? 0).eq(dec(m.noShares))) issues.push(`${m.slug}: positions do not sum to market shares`);
        const esc = await this.prisma.account.findFirst({ where: { type: 'MARKET_ESCROW', marketId: m.id } });
        if (dec(esc?.balance ?? 0).lt(D.max(dec(m.yesShares), dec(m.noShares)))) issues.push(`${m.slug}: escrow below worst-case payout`);
      }
    }
    return { ...trial, marketIssues: issues, ok: trial.ok && issues.length === 0, checkedAt: new Date() };
  }

  async ledgerEntries(take = 100) {
    const rows = await this.prisma.journalEntry.findMany({
      orderBy: { createdAt: 'desc' }, take: Math.min(take, 500),
      include: { lines: { include: { account: { select: { type: true, userId: true, marketId: true } } } } },
    });
    return rows.map((e) => ({
      id: e.id, kind: e.kind, memo: e.memo, createdAt: e.createdAt, actorId: e.actorId, marketId: e.marketId,
      lines: e.lines.map((l) => ({ account: l.account.type, userId: l.account.userId, marketId: l.account.marketId, amount: money(l.amount) })),
    }));
  }

  async trades(take = 100) {
    const rows = await this.prisma.trade.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(take, 500), include: { user: { select: { username: true } }, market: { select: { slug: true, question: true } } } });
    return rows.map((t) => ({ id: t.id, username: t.user.username, slug: t.market.slug, question: t.market.question, side: t.side, outcome: t.outcome, shares: dec(t.shares).toFixed(2), amount: money(t.amount), fee: money(t.fee), avgPrice: dec(t.avgPrice).toFixed(4), createdAt: t.createdAt }));
  }

  async users(search?: string) {
    const rows = await this.prisma.user.findMany({
      where: search ? { OR: [{ email: { contains: search, mode: 'insensitive' } }, { username: { contains: search, mode: 'insensitive' } }] } : {},
      orderBy: { createdAt: 'desc' }, take: 100,
      include: { accounts: { where: { type: 'USER_AVAILABLE' } }, _count: { select: { trades: true } } },
    });
    return rows.map((u) => ({ id: u.id, email: u.email, username: u.username, roles: u.roles, country: u.country, isSuspended: u.isSuspended, totpEnabled: u.totpEnabled, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, balance: money(u.accounts[0]?.balance ?? 0), trades: u._count.trades }));
  }

  async userDetail(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id }, select: { id: true, email: true, username: true, displayName: true, roles: true, country: true, isSuspended: true, createdAt: true, lastLoginAt: true } });
    if (!u) throw notFound('User');
    const [audit, trades] = await Promise.all([
      this.prisma.auditLog.findMany({ where: { OR: [{ actorId: id }, { entityId: id }] }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.trade.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 50, include: { market: { select: { question: true } } } }),
    ]);
    return { user: u, audit: audit.map((a) => ({ ...a, id: a.id.toString() })), trades };
  }

  async setRoles(id: string, roles: Role[], actorId: string, reason: string) {
    if (id === actorId && !roles.includes('ADMIN')) throw new DomainError('You cannot remove your own admin role');
    const u = await this.prisma.user.update({ where: { id }, data: { roles: [...new Set<Role>(['USER', ...roles])] } });
    await this.prisma.session.updateMany({ where: { userId: id }, data: { twoFactorVerified: false } });
    await this.audit.log({ actorId, action: 'user.roles', entityType: 'User', entityId: id, reason, data: { roles: u.roles } });
    return { id: u.id, roles: u.roles };
  }

  async setSuspended(id: string, suspended: boolean, actorId: string, reason: string) {
    if (id === actorId) throw new DomainError('You cannot suspend yourself');
    await this.prisma.user.update({ where: { id }, data: { isSuspended: suspended } });
    if (suspended) await this.prisma.session.deleteMany({ where: { userId: id } });
    await this.audit.log({ actorId, action: suspended ? 'user.suspend' : 'user.unsuspend', entityType: 'User', entityId: id, reason });
    return { ok: true };
  }

  /** Audited manual balance adjustment. A reason is mandatory and recorded in the ledger and audit log. */
  async adjust(userId: string, amount: string, reason: string, actorId: string) {
    const amt = dec(amount);
    if (amt.isZero()) throw new DomainError('Amount cannot be zero');
    if (amt.abs().gt(1_000_000)) throw new DomainError('Adjustments above 1,000,000 require a database migration with sign-off');
    await this.prisma.atomic(async (tx) => {
      const wallet = await this.ledger.account(tx, 'USER_AVAILABLE', { userId });
      const adj = await this.ledger.account(tx, 'ADJUSTMENTS');
      await this.ledger.post(tx, {
        kind: 'ADMIN_ADJUSTMENT', memo: `Admin adjustment: ${reason}`, actorId, referenceId: userId,
        lines: [{ accountId: adj, amount: amt.neg() }, { accountId: wallet, amount: amt }],
      });
      await this.audit.log({ actorId, action: 'wallet.adjust', entityType: 'User', entityId: userId, reason, data: { amount: money(amt) } }, tx);
    });
    await this.notifications.notify(userId, { type: 'ADJUSTMENT', title: 'Balance adjusted', body: `${amt.gt(0) ? '+' : ''}${money(amt)} virtual birr — ${reason}`, link: '/portfolio?tab=wallet' });
    return { ok: true };
  }

  async topUpReserve(amount: string, reason: string, actorId: string) {
    const amt = dec(amount);
    if (amt.lte(0)) throw new DomainError('Amount must be positive');
    await this.prisma.atomic(async (tx) => {
      const eq = await this.ledger.account(tx, 'EQUITY');
      const res = await this.ledger.account(tx, 'COMPANY_RESERVE');
      await this.ledger.post(tx, { kind: 'RESERVE_TOPUP', memo: `Reserve top-up: ${reason}`, actorId, lines: [{ accountId: eq, amount: amt.neg() }, { accountId: res, amount: amt }] });
      await this.audit.log({ actorId, action: 'reserve.topup', entityType: 'Account', reason, data: { amount: money(amt) } }, tx);
    });
    return { ok: true };
  }

  async auditLogs(q: { entityType?: string; entityId?: string; action?: string; take?: number }) {
    const rows = await this.prisma.auditLog.findMany({
      where: { ...(q.entityType ? { entityType: q.entityType } : {}), ...(q.entityId ? { entityId: q.entityId } : {}), ...(q.action ? { action: { startsWith: q.action } } : {}) },
      orderBy: { createdAt: 'desc' }, take: Math.min(q.take ?? 100, 500),
    });
    return rows.map((r) => ({ ...r, id: r.id.toString() }));
  }

  async health() {
    const t0 = Date.now();
    await this.prisma.$queryRaw`SELECT 1`;
    const dbMs = Date.now() - t0;
    const mem = process.memoryUsage();
    return {
      status: 'ok', db: { ok: true, latencyMs: dbMs }, uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(mem.rss / 1048576), node: process.version, demoMode: config().DEMO_MODE,
      payments: config().PAYMENTS_PROVIDER, football: config().FOOTBALL_PROVIDER, realMoney: false,
    };
  }

  allMarkets(status?: string) {
    return this.prisma.market
      .findMany({ where: status ? { status: status as Prisma.EnumMarketStatusFilter['equals'] } : {}, orderBy: { createdAt: 'desc' }, take: 200 })
      .then((rows) => rows.map((m) => this.markets.view(m)));
  }
}
