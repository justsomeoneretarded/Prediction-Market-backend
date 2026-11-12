import Decimal from 'decimal.js';
import { Ctx, setup, reset, user, market, buy, sell, balance, escrow, sys, resolve } from '../helpers';
import { AdminService } from '../../src/admin/admin.service';
import { SportsService, footballOutcome } from '../../src/sports/sports.service';

describe('Resolution, disputes and settlement', () => {
  let ctx: Ctx;
  beforeAll(async () => (ctx = await setup()));
  beforeEach(() => reset(ctx));
  afterAll(() => ctx.app.close());

  const recon = () => ctx.app.get(AdminService).reconciliation();

  async function staff() {
    return { resolver: await user(ctx, ['RESOLVER']), reviewer: await user(ctx, ['REVIEWER']), admin: await user(ctx, ['ADMIN']) };
  }

  test('cannot propose while open; four-eyes rule; cannot finalize during dispute window', async () => {
    const { resolver, reviewer } = await staff();
    const u = await user(ctx);
    const m = await market(ctx);
    await buy(ctx, u.id, m.id, 'YES', '100');
    await expect(ctx.resolution.propose(m.id, { outcome: 'YES', evidenceUrl: 'x://y', evidenceNotes: 'notes' }, resolver.id)).rejects.toThrow(/Close trading/);
    await ctx.markets.close(m.id, null);
    const p = await ctx.resolution.propose(m.id, { outcome: 'YES', evidenceUrl: 'x://y', evidenceNotes: 'notes' }, resolver.id);
    await expect(ctx.resolution.propose(m.id, { outcome: 'NO', evidenceUrl: 'x://y', evidenceNotes: 'n' }, resolver.id)).rejects.toThrow(/already has an active/);
    await expect(ctx.resolution.review(p.id, true, 'self', resolver.id)).rejects.toThrow(/second person/);
    await expect(ctx.resolution.finalize(p.id, reviewer.id)).rejects.toThrow(/only confirmed/);
    await ctx.resolution.review(p.id, true, 'checked', reviewer.id);
    await expect(ctx.resolution.finalize(p.id, reviewer.id)).rejects.toThrow(/dispute window is still open/);
    await ctx.clock.advance(23 * 3600_000);
    await expect(ctx.resolution.finalize(p.id, reviewer.id)).rejects.toThrow(/still open/);
    await ctx.clock.advance(2 * 3600_000);
    const s = await ctx.resolution.finalize(p.id, reviewer.id);
    expect(s.outcome).toBe('YES');
    // no market can be settled twice
    await expect(ctx.resolution.finalize(p.id, reviewer.id)).rejects.toThrow(/already settled/);
    expect(await ctx.prisma.settlement.count()).toBe(1);
    expect((await recon()).ok).toBe(true);
  });

  test('rejected proposal → new proposal; scheduler finalizes automatically after the window', async () => {
    const { resolver, reviewer } = await staff();
    const u = await user(ctx);
    const m = await market(ctx);
    await buy(ctx, u.id, m.id, 'NO', '200');
    await ctx.markets.close(m.id, null);
    const p1 = await ctx.resolution.propose(m.id, { outcome: 'YES', evidenceUrl: 'x://wrong', evidenceNotes: 'mistake' }, resolver.id);
    await ctx.resolution.review(p1.id, false, 'Evidence does not match', reviewer.id);
    const p2 = await ctx.resolution.propose(m.id, { outcome: 'NO', evidenceUrl: 'x://right', evidenceNotes: 'correct' }, resolver.id);
    await ctx.resolution.review(p2.id, true, 'ok', reviewer.id);
    await ctx.clock.advance(25 * 3600_000);
    expect(await ctx.resolution.finalizeDue()).toBe(1);
    const mk = await ctx.prisma.market.findUniqueOrThrow({ where: { id: m.id } });
    expect(mk.status).toBe('RESOLVED');
    expect(mk.resolvedOutcome).toBe('NO');
    const audit = await ctx.prisma.auditLog.findMany({ where: { entityId: m.id }, orderBy: { id: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['market.create', 'market.publish', 'market.close', 'resolution.propose', 'resolution.reject', 'resolution.confirm', 'resolution.finalize']));
  });

  test('dispute upheld overturns the proposal; dispute rejected lets it stand', async () => {
    const { resolver, reviewer, admin } = await staff();
    const trader = await user(ctx);
    const outsider = await user(ctx);
    const m = await market(ctx);
    await buy(ctx, trader.id, m.id, 'NO', '300');
    await ctx.markets.close(m.id, null);
    const p = await ctx.resolution.propose(m.id, { outcome: 'YES', evidenceUrl: 'x://a', evidenceNotes: 'claims yes' }, resolver.id);
    await ctx.resolution.review(p.id, true, 'looks fine', reviewer.id);
    await expect(ctx.resolution.dispute(p.id, outsider.id, 'I just want to complain')).rejects.toThrow(/Only traders/);
    const d = await ctx.resolution.dispute(p.id, trader.id, 'The official source says NO, see link.');
    expect((await ctx.prisma.market.findUniqueOrThrow({ where: { id: m.id } })).status).toBe('DISPUTED');
    await ctx.clock.advance(30 * 3600_000);
    await expect(ctx.resolution.finalize(p.id, admin.id)).rejects.toThrow(/disputed/);
    await expect(ctx.resolution.resolveDispute(d.id, true, 'proposer ruling', resolver.id)).rejects.toThrow(/proposer cannot/);
    await ctx.resolution.resolveDispute(d.id, true, 'Source confirms NO', admin.id);
    expect((await ctx.prisma.resolutionProposal.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('OVERTURNED');

    const p2 = await ctx.resolution.propose(m.id, { outcome: 'NO', evidenceUrl: 'x://b', evidenceNotes: 'correct' }, resolver.id);
    await ctx.resolution.review(p2.id, true, 'ok', reviewer.id);
    const d2 = await ctx.resolution.dispute(p2.id, trader.id, 'Second thoughts, no real evidence');
    await ctx.resolution.resolveDispute(d2.id, false, 'No evidence provided', admin.id);
    await ctx.clock.advance(25 * 3600_000);
    const s = await ctx.resolution.finalize(p2.id, admin.id);
    expect(s.outcome).toBe('NO');
    expect(Number(await balance(ctx, trader.id))).toBeGreaterThan(10000); // NO holder won
  });

  test('cancellation (REFUND_NET_COST) returns net contributions even after shares were traded and resold', async () => {
    const [a, b, c] = [await user(ctx), await user(ctx), await user(ctx)];
    const m = await market(ctx, { feeBps: 100 });
    await buy(ctx, a.id, m.id, 'YES', '1010');
    await buy(ctx, b.id, m.id, 'NO', '505');
    const r = await buy(ctx, c.id, m.id, 'YES', '202');
    await sell(ctx, c.id, m.id, 'YES', new Decimal(r.trade.shares).div(2).toFixed(6)); // partially resold
    const posC = await ctx.prisma.position.findFirstOrThrow({ where: { userId: c.id } });
    const reserveBefore = new Decimal(await sys(ctx, 'COMPANY_RESERVE'));
    const esc = new Decimal(await escrow(ctx, m.id));
    const s = await resolve(ctx, m.id, 'CANCELLED');
    expect(s.outcome).toBe('CANCELLED');
    expect(await balance(ctx, a.id)).toBe('9990.00'); // 10000 − 1010 + 1000 (fee not refunded)
    expect(await balance(ctx, b.id)).toBe('9995.00');
    const cBal = new Decimal(await balance(ctx, c.id));
    // c: 10000 − 202 + sale proceeds + refund of remaining net contribution
    expect(cBal.toFixed(2)).toBe(new Decimal(10000).minus(202).plus(posC.netContributed.toString()).plus((await ctx.prisma.trade.findFirstOrThrow({ where: { userId: c.id, side: 'SELL' } })).amount.toString()).minus((await ctx.prisma.trade.findFirstOrThrow({ where: { userId: c.id, side: 'SELL' } })).fee.toString()).toFixed(2));
    expect(await sys(ctx, 'COMPANY_RESERVE')).toBe(reserveBefore.plus(esc).minus(s.totalPayout).toFixed(2));
    expect((await ctx.prisma.market.findUniqueOrThrow({ where: { id: m.id } })).status).toBe('CANCELLED');
    expect((await recon()).ok).toBe(true);
  });

  test('cancellation (LAST_PRICE) pays shares at the closing price and stays solvent', async () => {
    const [a, b] = [await user(ctx), await user(ctx)];
    const m = await market(ctx, { cancellationPolicy: 'LAST_PRICE' });
    const ta = await buy(ctx, a.id, m.id, 'YES', '800');
    const tb = await buy(ctx, b.id, m.id, 'NO', '100');
    const p = new Decimal(tb.trade.yesPriceAfter);
    await resolve(ctx, m.id, 'CANCELLED');
    const mk = await ctx.prisma.market.findUniqueOrThrow({ where: { id: m.id } });
    const exactP = new Decimal(mk.closingYesPrice!.toString());
    expect(exactP.toFixed(4)).toBe(p.toFixed(4));
    expect(await balance(ctx, a.id)).toBe(new Decimal(9200).plus(new Decimal(ta.trade.shares).mul(exactP).toDecimalPlaces(2, Decimal.ROUND_DOWN)).toFixed(2));
    expect((await recon()).ok).toBe(true);
  });

  test('untraded markets can be cancelled directly and their collateral returns to the reserve', async () => {
    const { admin } = await staff();
    const before = await sys(ctx, 'COMPANY_RESERVE');
    const m = await market(ctx);
    expect(await sys(ctx, 'COMPANY_RESERVE')).not.toBe(before);
    await ctx.resolution.cancelUntraded(m.id, 'Event cancelled', admin.id);
    expect(await sys(ctx, 'COMPANY_RESERVE')).toBe(before);
    const traded = await market(ctx);
    await buy(ctx, admin.id, traded.id, 'YES', '10');
    await expect(ctx.resolution.cancelUntraded(traded.id, 'nope', admin.id)).rejects.toThrow(/has trades/);
  });

  test('football: outcome rules and automated resolution from the (demo) provider', async () => {
    expect(footballOutcome('FOOTBALL_HOME_WIN', 2, 1)).toBe('YES');
    expect(footballOutcome('FOOTBALL_HOME_WIN', 1, 1)).toBe('NO');
    expect(footballOutcome('FOOTBALL_AWAY_WIN', 0, 1)).toBe('YES');
    expect(footballOutcome('FOOTBALL_OVER_2_5', 2, 1)).toBe('YES');
    expect(footballOutcome('FOOTBALL_OVER_2_5', 1, 1)).toBe('NO');
    expect(footballOutcome('FOOTBALL_BTTS', 3, 0)).toBe('NO');

    const { admin } = await staff();
    const sports = ctx.app.get(SportsService);
    await sports.sync('EPL', admin.id);
    const f = await ctx.prisma.fixture.findFirstOrThrow({ where: { league: 'EPL' } });
    expect(f.isDemo).toBe(true);
    const ms = await sports.createMarkets(f.id, ['FOOTBALL_HOME_WIN', 'FOOTBALL_OVER_2_5', 'FOOTBALL_BTTS'], admin.id);
    expect(ms.every((m) => m.closesAt.getTime() === f.kickoffAt.getTime())).toBe(true);
    const u = await user(ctx);
    await buy(ctx, u.id, ms[0].id, 'YES', '100');
    await buy(ctx, u.id, ms[1].id, 'NO', '100');

    // match kicks off → trading closes; result 2–0
    await sports.setDemoResult(f.id, { status: 'FINISHED', homeGoals: 2, awayGoals: 0 }, admin.id);
    expect((await ctx.prisma.market.findUniqueOrThrow({ where: { id: ms[0].id } })).status).toBe('CLOSED');
    expect(await sports.autoResolve()).toBe(3);
    const props = await ctx.prisma.resolutionProposal.findMany({ where: { marketId: { in: ms.map((m) => m.id) } } });
    expect(props.every((p) => p.status === 'CONFIRMED' && p.source === 'AUTOMATED')).toBe(true);
    await ctx.clock.advance(25 * 3600_000);
    expect(await ctx.resolution.finalizeDue()).toBe(3);
    const outcomes = await ctx.prisma.market.findMany({ where: { id: { in: ms.map((m) => m.id) } }, select: { type: true, resolvedOutcome: true } });
    expect(Object.fromEntries(outcomes.map((o) => [o.type, o.resolvedOutcome]))).toEqual({ FOOTBALL_HOME_WIN: 'YES', FOOTBALL_OVER_2_5: 'NO', FOOTBALL_BTTS: 'NO' });
  });

  test('football: abandoned match needs human review before cancellation', async () => {
    const { admin, reviewer } = await staff();
    const sports = ctx.app.get(SportsService);
    await sports.sync('ETH_PL', admin.id);
    const f = await ctx.prisma.fixture.findFirstOrThrow();
    const [m] = await sports.createMarkets(f.id, ['FOOTBALL_HOME_WIN'], admin.id);
    await sports.setDemoResult(f.id, { status: 'ABANDONED' }, admin.id);
    await sports.autoResolve();
    const p = await ctx.prisma.resolutionProposal.findFirstOrThrow({ where: { marketId: m.id } });
    expect(p.status).toBe('PENDING_REVIEW');
    expect(p.outcome).toBe('CANCELLED');
    await ctx.resolution.review(p.id, true, 'Confirmed abandoned by federation', reviewer.id);
  });
});
