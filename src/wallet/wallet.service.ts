import { Injectable } from '@nestjs/common';
import { PaymentIntent } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuditService } from '../common/audit.service';
import { DomainError, notFound } from '../common/errors';
import { config } from '../config';
import { dec } from '../lmsr/lmsr';
import { money } from '../common/money';
import { DisabledPaymentProvider, PaymentProvider, SimulatedPaymentProvider, screenPayment } from '../payments/payment-provider';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class WalletService {
  readonly provider: PaymentProvider =
    config().PAYMENTS_PROVIDER === 'simulated' ? new SimulatedPaymentProvider() : new DisabledPaymentProvider();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async balances(userId: string) {
    const accs = await this.prisma.account.findMany({ where: { userId }, select: { type: true, balance: true } });
    const get = (t: string) => dec(accs.find((a) => a.type === t)?.balance ?? 0);
    return { available: money(get('USER_AVAILABLE')), reserved: money(get('USER_RESERVED')), currency: 'ETB', virtual: true };
  }

  async transactions(userId: string, take = 50, cursor?: string) {
    const accs = await this.prisma.account.findMany({ where: { userId }, select: { id: true, type: true } });
    const lines = await this.prisma.journalLine.findMany({
      where: { accountId: { in: accs.map((a) => a.id) } },
      include: { entry: true, account: { select: { type: true } } },
      orderBy: [{ entry: { createdAt: 'desc' } }, { id: 'desc' }],
      take: Math.min(take, 200),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    return lines.map((l) => ({
      id: l.id,
      entryId: l.entryId,
      kind: l.entry.kind,
      memo: l.entry.memo,
      account: l.account.type,
      amount: money(l.amount),
      balanceAfter: money(l.balanceAfter),
      marketId: l.entry.marketId,
      createdAt: l.entry.createdAt,
    }));
  }

  /** Simulated deposit: intent → provider → confirmation (as a webhook would) → ledger credit. */
  async deposit(userId: string, amount: string, idempotencyKey: string) {
    if (!this.provider.realMoney && config().PAYMENTS_PROVIDER !== 'simulated') throw new DomainError('Deposits are disabled', 403);
    if (dec(amount).lte(0)) throw new DomainError('Amount must be greater than zero');
    if (dec(amount).gt(100_000)) throw new DomainError('Maximum simulated deposit is 100,000 virtual birr');
    const existing = await this.prisma.paymentIntent.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
    if (existing) return this.view(existing);
    const intent = await this.prisma.paymentIntent.create({
      data: { userId, kind: 'DEPOSIT', provider: this.provider.name, amount, idempotencyKey },
    });
    const { externalRef } = await this.provider.initiateDeposit({ intentId: intent.id, amount, userId });
    await this.prisma.paymentIntent.update({ where: { id: intent.id }, data: { externalRef } });
    // Simulated provider confirms instantly. A real provider would call /payments/webhook/:provider.
    return this.view(await this.confirmDeposit(intent.id, 'COMPLETED'));
  }

  /** Idempotent: only a PENDING intent can transition. Shared by webhook handlers. */
  async confirmDeposit(intentId: string, status: 'COMPLETED' | 'FAILED', failureReason?: string) {
    return this.prisma.atomic(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "PaymentIntent" WHERE id = ${intentId} FOR UPDATE`;
      if (!row) throw notFound('Payment');
      const intent = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
      if (intent.status !== 'PENDING') return intent; // already processed — safe to retry
      if (status === 'FAILED') {
        return tx.paymentIntent.update({ where: { id: intentId }, data: { status: 'FAILED', failureReason } });
      }
      const wallet = await this.ledger.account(tx, 'USER_AVAILABLE', { userId: intent.userId });
      const clearing = await this.ledger.account(tx, 'PAYMENT_CLEARING');
      await this.ledger.post(tx, {
        kind: 'DEPOSIT', memo: `Simulated deposit (${intent.provider})`, referenceId: intent.id,
        lines: [{ accountId: clearing, amount: money(dec(intent.amount).neg()) }, { accountId: wallet, amount: money(intent.amount) }],
      });
      await this.audit.log({ actorId: intent.userId, action: 'payment.deposit_completed', entityType: 'PaymentIntent', entityId: intent.id, data: { amount: money(intent.amount) } }, tx);
      return tx.paymentIntent.update({ where: { id: intentId }, data: { status: 'COMPLETED' } });
    });
  }

  /** Withdrawal request: funds move available → reserved and wait for approval. */
  async requestWithdrawal(userId: string, amount: string, idempotencyKey: string) {
    if (dec(amount).lte(0)) throw new DomainError('Amount must be greater than zero');
    const existing = await this.prisma.paymentIntent.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
    if (existing) return this.view(existing);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const recentCount = await this.prisma.paymentIntent.count({ where: { userId, createdAt: { gte: new Date(Date.now() - 86400_000) } } });
    const flags = screenPayment('WITHDRAWAL', Number(amount), { accountAgeHours: (Date.now() - user.createdAt.getTime()) / 3600_000, recentCount });
    const intent = await this.prisma.atomic(async (tx) => {
      const created = await tx.paymentIntent.create({
        data: { userId, kind: 'WITHDRAWAL', provider: this.provider.name, amount, idempotencyKey, status: 'REQUIRES_APPROVAL', riskFlags: flags },
      });
      const avail = await this.ledger.account(tx, 'USER_AVAILABLE', { userId });
      const reserved = await this.ledger.account(tx, 'USER_RESERVED', { userId });
      await this.ledger.post(tx, {
        kind: 'WITHDRAWAL_HOLD', memo: 'Withdrawal requested — funds on hold pending review', referenceId: created.id,
        lines: [{ accountId: avail, amount: money(dec(amount).neg()) }, { accountId: reserved, amount: money(amount) }],
      });
      await this.audit.log({ actorId: userId, action: 'payment.withdrawal_requested', entityType: 'PaymentIntent', entityId: created.id, data: { amount, flags } }, tx);
      return created;
    });
    if (dec(amount).lte(config().WITHDRAWAL_APPROVAL_THRESHOLD) && flags.length === 0) {
      return this.view(await this.reviewWithdrawal(intent.id, null, true, 'Auto-approved below threshold'));
    }
    return this.view(intent);
  }

  async reviewWithdrawal(intentId: string, reviewerId: string | null, approve: boolean, note: string) {
    const result = await this.prisma.atomic(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "PaymentIntent" WHERE id = ${intentId} FOR UPDATE`;
      if (!row) throw notFound('Withdrawal');
      const intent = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
      if (intent.kind !== 'WITHDRAWAL' || intent.status !== 'REQUIRES_APPROVAL') throw new DomainError('This withdrawal is not awaiting approval', 409);
      const avail = await this.ledger.account(tx, 'USER_AVAILABLE', { userId: intent.userId });
      const reserved = await this.ledger.account(tx, 'USER_RESERVED', { userId: intent.userId });
      const clearing = await this.ledger.account(tx, 'PAYMENT_CLEARING');
      const amt = money(intent.amount);
      if (approve) {
        await this.ledger.post(tx, {
          kind: 'WITHDRAWAL_PAYOUT', memo: 'Simulated withdrawal paid out', referenceId: intent.id, actorId: reviewerId,
          lines: [{ accountId: reserved, amount: money(dec(amt).neg()) }, { accountId: clearing, amount: amt }],
        });
      } else {
        await this.ledger.post(tx, {
          kind: 'WITHDRAWAL_RELEASE', memo: `Withdrawal rejected: ${note}`, referenceId: intent.id, actorId: reviewerId,
          lines: [{ accountId: reserved, amount: money(dec(amt).neg()) }, { accountId: avail, amount: amt }],
        });
      }
      await this.audit.log({ actorId: reviewerId, action: approve ? 'payment.withdrawal_approved' : 'payment.withdrawal_rejected', entityType: 'PaymentIntent', entityId: intent.id, reason: note }, tx);
      return tx.paymentIntent.update({
        where: { id: intent.id },
        data: { status: approve ? 'COMPLETED' : 'REJECTED', reviewedById: reviewerId, failureReason: approve ? null : note },
      });
    });
    if (approve) {
      const { externalRef } = await this.provider.sendPayout({ intentId: result.id, amount: money(result.amount), userId: result.userId });
      await this.prisma.paymentIntent.update({ where: { id: result.id }, data: { externalRef } });
    }
    await this.notifications.notify(result.userId, {
      type: 'WITHDRAWAL', title: approve ? 'Withdrawal completed' : 'Withdrawal rejected',
      body: approve ? `${money(result.amount)} virtual birr withdrawn (simulation).` : `Your withdrawal was rejected: ${note}`,
      link: '/portfolio?tab=wallet',
    });
    return result;
  }

  async payments(userId?: string, status?: string) {
    const rows = await this.prisma.paymentIntent.findMany({
      where: { ...(userId ? { userId } : {}), ...(status ? { status: status as PaymentIntent['status'] } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { username: true } } },
    });
    return rows.map((r) => ({ ...this.view(r), username: r.user.username }));
  }

  view(p: PaymentIntent) {
    return {
      id: p.id, kind: p.kind, provider: p.provider, amount: money(p.amount), status: p.status,
      riskFlags: p.riskFlags, failureReason: p.failureReason, createdAt: p.createdAt, simulated: p.provider === 'simulated',
    };
  }
}
