import { Injectable } from '@nestjs/common';
import { AccountType, EntryKind, Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../common/prisma.service';
import { DomainError } from '../common/errors';
import { D, Dec, dec } from '../lmsr/lmsr';

export interface LineInput {
  accountId: string;
  amount: Dec | string; // + credit, − debit
}

export interface PostInput {
  kind: EntryKind;
  memo: string;
  lines: LineInput[];
  actorId?: string | null;
  marketId?: string | null;
  referenceId?: string | null;
}

const NEGATIVE_OK: AccountType[] = ['EQUITY', 'PROMOTIONS', 'PAYMENT_CLEARING', 'ADJUSTMENTS'];

/**
 * Double-entry ledger. All balance changes go through `post`, inside the caller's
 * transaction. Accounts are row-locked (in id order, to avoid deadlocks) before any
 * balance is read or written.
 */
@Injectable()
export class LedgerService {
  private systemIds = new Map<AccountType, string>();
  constructor(private readonly prisma: PrismaService) {}

  clearCache() {
    this.systemIds.clear();
  }

  /** Get-or-create an account. Uses ON CONFLICT on the (type, user, market) expression index. */
  async account(tx: Tx | PrismaService, type: AccountType, opts: { userId?: string; marketId?: string } = {}): Promise<string> {
    const userId = opts.userId ?? null;
    const marketId = opts.marketId ?? null;
    if (!userId && !marketId && this.systemIds.has(type)) return this.systemIds.get(type)!;
    const allowNegative = NEGATIVE_OK.includes(type);
    await tx.$executeRaw`
      INSERT INTO "Account" ("id","type","userId","marketId","balance","allowNegative","createdAt")
      VALUES (${'acc_' + cryptoRandom()}, ${type}::"AccountType", ${userId}, ${marketId}, 0, ${allowNegative}, now())
      ON CONFLICT ("type", COALESCE("userId", ''), COALESCE("marketId", '')) DO NOTHING`;
    const row = await tx.account.findFirst({ where: { type, userId, marketId }, select: { id: true } });
    if (!row) throw new Error(`could not create account ${type}`);
    if (!userId && !marketId) this.systemIds.set(type, row.id);
    return row.id;
  }

  async balance(tx: Tx | PrismaService, accountId: string): Promise<Dec> {
    const a = await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: { balance: true } });
    return dec(a.balance);
  }

  /** Lock accounts FOR UPDATE in a deterministic order and return their balances. */
  async lock(tx: Tx, accountIds: string[]): Promise<Map<string, { balance: Dec; allowNegative: boolean; type: AccountType }>> {
    const ids = [...new Set(accountIds)].sort();
    const rows = await tx.$queryRaw<{ id: string; balance: Prisma.Decimal; allowNegative: boolean; type: AccountType }[]>`
      SELECT "id","balance","allowNegative","type" FROM "Account" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
    return new Map(rows.map((r) => [r.id, { balance: dec(r.balance), allowNegative: r.allowNegative, type: r.type }]));
  }

  async post(tx: Tx, input: PostInput) {
    const lines = input.lines
      .map((l) => ({ accountId: l.accountId, amount: dec(l.amount).toDecimalPlaces(2) }))
      .filter((l) => !l.amount.isZero());
    if (lines.length === 0) return null;
    const sum = lines.reduce((s, l) => s.plus(l.amount), new D(0));
    if (!sum.isZero()) throw new Error(`Unbalanced journal entry (${sum.toString()})`);

    const locked = await this.lock(tx, lines.map((l) => l.accountId));
    const next = new Map<string, Dec>();
    for (const l of lines) {
      const acc = locked.get(l.accountId);
      if (!acc) throw new Error(`Unknown account ${l.accountId}`);
      const after = (next.get(l.accountId) ?? acc.balance).plus(l.amount);
      if (after.isNegative() && !acc.allowNegative) {
        throw new DomainError(
          acc.type === 'COMPANY_RESERVE'
            ? 'Company liquidity reserve is insufficient for this operation'
            : acc.type === 'MARKET_ESCROW'
              ? 'Market escrow cannot cover this payout'
              : 'Insufficient balance',
          400,
          'INSUFFICIENT_FUNDS',
        );
      }
      next.set(l.accountId, after);
    }

    const entry = await tx.journalEntry.create({
      data: {
        kind: input.kind,
        memo: input.memo,
        actorId: input.actorId ?? null,
        marketId: input.marketId ?? null,
        referenceId: input.referenceId ?? null,
      },
    });
    const running = new Map<string, Dec>();
    for (const l of lines) {
      const after = (running.get(l.accountId) ?? locked.get(l.accountId)!.balance).plus(l.amount);
      running.set(l.accountId, after);
      await tx.journalLine.create({
        data: { entryId: entry.id, accountId: l.accountId, amount: l.amount.toFixed(2), balanceAfter: after.toFixed(2) },
      });
    }
    for (const [id, bal] of next) {
      await tx.account.update({ where: { id }, data: { balance: bal.toFixed(2) } });
    }
    return entry;
  }

  /** Global check: sum of all account balances must be zero (closed system). */
  async trialBalance() {
    const r = await this.prisma.$queryRaw<{ total: Prisma.Decimal; lines: Prisma.Decimal; unbalanced: bigint; drift: bigint }[]>`
      SELECT
        (SELECT COALESCE(SUM(balance),0) FROM "Account") AS total,
        (SELECT COALESCE(SUM(amount),0) FROM "JournalLine") AS lines,
        (SELECT COUNT(*) FROM (SELECT "entryId" FROM "JournalLine" GROUP BY "entryId" HAVING SUM(amount) <> 0) x) AS unbalanced,
        (SELECT COUNT(*) FROM "Account" a WHERE a.balance <> COALESCE((SELECT SUM(amount) FROM "JournalLine" l WHERE l."accountId" = a.id),0)) AS drift`;
    const row = r[0];
    return {
      sumOfBalances: dec(row.total).toFixed(2),
      sumOfLines: dec(row.lines).toFixed(2),
      unbalancedEntries: Number(row.unbalanced),
      accountsWithDrift: Number(row.drift),
      ok: dec(row.total).isZero() && Number(row.unbalanced) === 0 && Number(row.drift) === 0,
    };
  }
}

function cryptoRandom() {
  return require('crypto').randomBytes(12).toString('hex');
}
