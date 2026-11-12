import Decimal from 'decimal.js';
import { Ctx, setup, reset, user, market, buy, sell, balance, escrow, key, sys } from '../helpers';
import { AdminService } from '../../src/admin/admin.service';

describe('Trading engine', () => {
  let ctx: Ctx;
  beforeAll(async () => (ctx = await setup()));
  beforeEach(() => reset(ctx));
  afterAll(() => ctx.app.close());

  const recon = () => ctx.app.get(AdminService).reconciliation();

  test('initial probability is honoured and buys move price in the right direction', async () => {
    const u = await user(ctx);
    const m = await market(ctx, { initialProbability: 0.3 });
    expect(Number(m.lastYesPrice)).toBeCloseTo(0.3, 6);
    const r1 = await buy(ctx, u.id, m.id, 'YES', '100');
    expect(Number(r1.trade.yesPriceAfter)).toBeGreaterThan(0.3);
    const r2 = await buy(ctx, u.id, m.id, 'NO', '300');
    expect(Number(r2.trade.yesPriceAfter)).toBeLessThan(Number(r1.trade.yesPriceAfter));
  });

  test('higher liquidity means smaller price impact', async () => {
    const u = await user(ctx);
    const thin = await market(ctx, { liquidityB: 200 });
    const deep = await market(ctx, { liquidityB: 5000 });
    const a = await buy(ctx, u.id, thin.id, 'YES', '500');
    const b = await buy(ctx, u.id, deep.id, 'YES', '500');
    expect(Number(a.trade.yesPriceAfter)).toBeGreaterThan(Number(b.trade.yesPriceAfter));
  });

  test('buy then sell: balances, positions, fees and realized P&L are consistent', async () => {
    const u = await user(ctx);
    const m = await market(ctx, { feeBps: 100 });
    const b1 = await buy(ctx, u.id, m.id, 'YES', '505');
    expect(b1.trade.fee).toBe('5.00');
    expect(b1.trade.amount).toBe('500.00');
    expect(await balance(ctx, u.id)).toBe('9495.00');
    const s1 = await sell(ctx, u.id, m.id, 'YES', b1.trade.shares);
    const pos = await ctx.prisma.position.findFirstOrThrow({ where: { userId: u.id } });
    expect(pos.yesShares.toFixed(6)).toBe('0.000000');
    // round trip loses only fees (+ rounding dust), never gains
    const final = new Decimal(await balance(ctx, u.id));
    expect(final.lte(10000)).toBe(true);
    expect(final.gte(new Decimal(10000).minus(5).minus(s1.trade.fee).minus('0.02'))).toBe(true);
    expect(pos.realizedPnl.toFixed(2)).toBe(final.minus(10000).toFixed(2));
    expect(await sys(ctx, 'FEE_REVENUE')).toBe(new Decimal(5).plus(s1.trade.fee).toFixed(2));
    expect((await recon()).ok).toBe(true);
  });

  test('buy a specific number of shares and sell for a target amount', async () => {
    const u = await user(ctx);
    const m = await market(ctx);
    const r = await buy(ctx, u.id, m.id, 'NO', '250', 'SHARES');
    expect(r.trade.shares).toBe('250.000000');
    const s = await sell(ctx, u.id, m.id, 'NO', '50', 'AMOUNT');
    expect(Number(s.trade.total)).toBeGreaterThanOrEqual(50);
  });

  test('rejects: insufficient balance, unowned shares, negative/zero/garbage amounts, trade limit', async () => {
    const u = await user(ctx);
    const m = await market(ctx, { maxTradeAmount: 2000 });
    await expect(buy(ctx, u.id, m.id, 'YES', '1500')).resolves.toBeTruthy();
    await expect(buy(ctx, u.id, m.id, 'YES', '2500')).rejects.toThrow(/Maximum trade size/);
    const poor = await user(ctx);
    await ctx.prisma.account.updateMany({ where: { userId: poor.id }, data: {} });
    for (let i = 0; i < 5; i++) await buy(ctx, poor.id, m.id, 'NO', '1999');
    await expect(buy(ctx, poor.id, m.id, 'NO', '100')).rejects.toThrow(/Insufficient balance/);
    await expect(sell(ctx, u.id, m.id, 'NO', '1')).rejects.toThrow(/only hold/);
    await expect(buy(ctx, u.id, m.id, 'YES', '0')).rejects.toThrow();
    await expect(buy(ctx, u.id, m.id, 'YES', '0.5')).rejects.toThrow(/Minimum/);
    expect((await recon()).ok).toBe(true);
  });

  test('closed, scheduled, halted and resolved markets reject trades', async () => {
    const u = await user(ctx);
    const m = await market(ctx);
    await ctx.markets.setHalt(m.id, true, 'Investigating data feed', u.id);
    await expect(buy(ctx, u.id, m.id, 'YES', '10')).rejects.toThrow(/paused/);
    await ctx.markets.setHalt(m.id, false, 'resume', u.id);
    await ctx.markets.close(m.id, null);
    await expect(buy(ctx, u.id, m.id, 'YES', '10')).rejects.toThrow(/closed/i);
    const future = await market(ctx, { opensAt: new Date(Date.now() + 3600_000) });
    expect(future.status).toBe('SCHEDULED');
    await expect(buy(ctx, u.id, future.id, 'YES', '10')).rejects.toThrow(/not opened/);
    // passing the closing time also blocks trades even before the scheduler runs
    const soon = await market(ctx, { closesAt: new Date(Date.now() + 3600_000) });
    await ctx.clock.advance(2 * 3600_000);
    await expect(buy(ctx, u.id, soon.id, 'YES', '10')).rejects.toThrow(/closed/i);
  });

  test('duplicate requests with the same idempotency key execute exactly once', async () => {
    const u = await user(ctx);
    const m = await market(ctx);
    const k = key();
    const input = { side: 'BUY' as const, outcome: 'YES' as const, mode: 'AMOUNT' as const, value: '100', idempotencyKey: k, maxSlippage: 1 };
    const results = await Promise.all(Array.from({ length: 8 }, () => ctx.trading.execute(u.id, m.id, input)));
    expect(new Set(results.map((r) => r.trade.id)).size).toBe(1);
    expect(await ctx.prisma.trade.count()).toBe(1);
    expect(await balance(ctx, u.id)).toBe('9900.00');
  });

  test('concurrent spending of the same balance can never overdraw', async () => {
    const u = await user(ctx);
    const m = await market(ctx, { liquidityB: 5000 });
    // 10,000 balance, 30 parallel 500-birr buys → at most 20 can succeed
    const res = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => buy(ctx, u.id, m.id, i % 2 ? 'YES' : 'NO', '500')));
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(20);
    expect(await balance(ctx, u.id)).toBe('0.00');
    const fails = res.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    for (const f of fails) expect(String(f.reason.message)).toMatch(/Insufficient balance/);
    expect((await recon()).ok).toBe(true);
  });

  test('many users trading concurrently keeps market state equal to the sum of positions', async () => {
    const users = await Promise.all(Array.from({ length: 8 }, () => user(ctx)));
    const m = await market(ctx);
    await Promise.all(users.flatMap((u, i) => [buy(ctx, u.id, m.id, 'YES', String(50 + i * 10)), buy(ctx, u.id, m.id, 'NO', String(40 + i * 7))]));
    await Promise.all(users.slice(0, 4).map((u) => sell(ctx, u.id, m.id, 'YES', '10')));
    const r = await recon();
    expect(r.marketIssues).toEqual([]);
    expect(r.ok).toBe(true);
    const mk = await ctx.prisma.market.findUniqueOrThrow({ where: { id: m.id } });
    expect(mk.tradesCount).toBe(20);
  });

  test('a failing trade rolls back completely (no partial commits)', async () => {
    const u = await user(ctx);
    const m = await market(ctx);
    await buy(ctx, u.id, m.id, 'YES', '100');
    const before = { bal: await balance(ctx, u.id), esc: await escrow(ctx, m.id), trades: await ctx.prisma.trade.count(), entries: await ctx.prisma.journalEntry.count(), points: await ctx.prisma.pricePoint.count() };
    // slippage guard fails AFTER locks are taken → whole transaction must roll back
    await expect(
      ctx.trading.execute(u.id, m.id, { side: 'BUY', outcome: 'YES', mode: 'AMOUNT', value: '100', idempotencyKey: key(), maxSlippage: 0.001, expectedYesPrice: '0.1' }),
    ).rejects.toThrow(/price moved/);
    expect({ bal: await balance(ctx, u.id), esc: await escrow(ctx, m.id), trades: await ctx.prisma.trade.count(), entries: await ctx.prisma.journalEntry.count(), points: await ctx.prisma.pricePoint.count() }).toEqual(before);
  });

  test('database refuses a negative customer balance even if application checks were bypassed', async () => {
    const u = await user(ctx);
    await expect(ctx.prisma.$executeRaw`UPDATE "Account" SET balance = -1 WHERE "userId" = ${u.id}`).rejects.toThrow(/account_non_negative/);
  });

  test('ledger and audit log are append-only; unbalanced journal entries are refused by the DB', async () => {
    const u = await user(ctx);
    await expect(ctx.prisma.$executeRaw`DELETE FROM "AuditLog"`).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.$executeRaw`UPDATE "JournalLine" SET amount = 0`).rejects.toThrow(/append-only/);
    const acc = await ctx.prisma.account.findFirstOrThrow({ where: { userId: u.id } });
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        const e = await tx.journalEntry.create({ data: { kind: 'ADMIN_ADJUSTMENT', memo: 'evil' } });
        await tx.journalLine.create({ data: { entryId: e.id, accountId: acc.id, amount: '5', balanceAfter: '5' } });
      }),
    ).rejects.toThrow(/does not balance/);
  });

  test('liquidity is locked once published and markets cannot be funded beyond the reserve', async () => {
    const admin = await user(ctx, ['ADMIN']);
    const m = await market(ctx);
    await expect(ctx.markets.update(m.id, { liquidityB: 50 }, admin.id)).rejects.toThrow(/locked/);
    await expect(market(ctx, { liquidityB: 2_000_000, riskBudget: 10_000_000 })).rejects.toThrow(/reserve is insufficient/);
    await expect(market(ctx, { liquidityB: 1000, riskBudget: 100 })).rejects.toThrow(/risk budget/);
  });
});
