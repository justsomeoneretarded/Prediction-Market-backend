/**
 * The acceptance scenario from the spec:
 *   50/50 market (b = 1000, no fee) → User A spends 1,000 on YES → User B spends 20 on NO.
 * Every expected number is derived here from the LMSR closed form, independently of the
 * engine, then compared with what the engine + ledger actually did.
 */
import Decimal from 'decimal.js';
import { Ctx, setup, user, market, buy, balance, escrow, sys, resolve } from '../helpers';

const D = Decimal.clone({ precision: 40 });
const b = new D(1000);
// x_A = b·ln(2e^{m/b} − 1)  (from b·ln(½e^{x/b} + ½) = m)
const xA = b.mul(new D(2).mul(D.exp(new D(1000).div(b))).minus(1).ln()).toDecimalPlaces(6, Decimal.ROUND_DOWN);
// y_B = b·ln(2e^{(1000+20)/b} − e^{x_A/b})  (exact cost after A)
const costAfterA = b.mul(D.exp(xA.div(b)).mul(0.5).plus(0.5).ln()); // ≤ 1000 because x_A was floored
const yB = b.mul(new D(2).mul(D.exp(costAfterA.plus(20).div(b))).minus(D.exp(xA.div(b))).ln()).toDecimalPlaces(6, Decimal.ROUND_DOWN);
const priceYes = (y: Decimal, n: Decimal) => new D(1).div(new D(1).plus(D.exp(n.minus(y).div(b))));

describe('Critical scenario: A buys 1,000 YES, B buys 20 NO', () => {
  let ctx: Ctx;
  let A: { id: string };
  let B: { id: string };
  let marketId: string;

  const run = async () => {
    A = await user(ctx);
    B = await user(ctx);
    const m = await market(ctx, { initialProbability: 0.5, liquidityB: 1000, feeBps: 0 });
    marketId = m.id;
    const ta = await buy(ctx, A.id, m.id, 'YES', '1000');
    const tb = await buy(ctx, B.id, m.id, 'NO', '20');
    return { ta: ta.trade, tb: tb.trade };
  };

  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(() => ctx.app.close());

  test('shares, average prices, new prices, exposure and both settlements', async () => {
    const { ta, tb } = await run();
    const subsidy = b.mul(new D(2).ln()).toDecimalPlaces(2, Decimal.ROUND_UP); // b·ln2 = 693.15

    // 1. shares received
    expect(ta.shares).toBe(xA.toFixed(6));
    expect(tb.shares).toBe(yB.toFixed(6));
    // 2. average execution prices
    expect(Number(ta.avgPrice)).toBeCloseTo(1000 / xA.toNumber(), 6);
    expect(Number(tb.avgPrice)).toBeCloseTo(20 / yB.toNumber(), 6);
    expect(Number(ta.avgPrice)).toBeGreaterThan(0.5); // paid more than the starting 50% → slippage
    // 3. new prices
    const pAfterA = priceYes(xA, new D(0));
    const pAfterB = priceYes(xA, yB);
    expect(Number(ta.yesPriceAfter)).toBeCloseTo(pAfterA.toNumber(), 4);
    expect(Number(tb.yesPriceAfter)).toBeCloseTo(pAfterB.toNumber(), 4);
    expect(pAfterA.gt(0.5)).toBe(true);
    expect(pAfterB.lt(pAfterA)).toBe(true);

    // 4. market-maker exposure from the risk endpoint
    const risk = await ctx.markets.risk(marketId);
    expect(risk.escrow).toBe(subsidy.plus(1020).toFixed(2));
    expect(risk.payoutIfYes).toBe(xA.toFixed(2));
    expect(risk.payoutIfNo).toBe(yB.toFixed(2));
    const pnlIfYes = new D(1020).minus(xA); // operator keeps trader cash, pays YES holders
    expect(Number(risk.operatorPnlIfYes)).toBeCloseTo(pnlIfYes.toNumber(), 2);
    expect(Number(risk.operatorPnlIfNo)).toBeCloseTo(new D(1020).minus(yB).toNumber(), 2);
    expect(Number(risk.currentExposure)).toBeCloseTo(D.max(pnlIfYes.neg(), 0).toNumber(), 2);
    expect(new D(risk.currentExposure!).lte(subsidy)).toBe(true); // never beyond the funded worst case
    // 7. remaining liquidity reserve after worst case
    expect(Number(risk.reserveCoverage)).toBeCloseTo(subsidy.plus(1020).minus(D.max(xA, yB)).toNumber(), 2);

    console.log(
      [
        '── Critical scenario (b=1000, fee 0) ──',
        `A: 1000 birr → ${ta.shares} YES @ avg ${ta.avgPrice}`,
        `B:   20 birr → ${tb.shares} NO  @ avg ${tb.avgPrice}`,
        `YES price: 0.5000 → ${ta.yesPriceAfter} → ${tb.yesPriceAfter}`,
        `Escrow ${risk.escrow} (collateral ${risk.subsidy} + trader cash 1020.00)`,
        `If YES: pay ${risk.payoutIfYes}, operator P&L ${risk.operatorPnlIfYes}`,
        `If NO:  pay ${risk.payoutIfNo}, operator P&L ${risk.operatorPnlIfNo}`,
        `Worst-case bound b·ln2 = ${subsidy.toFixed(2)}`,
      ].join('\n'),
    );
  });

  test('YES wins: A is paid 1 birr per share, B gets nothing, remainder returns to reserve', async () => {
    ctx = ctx; // fresh state
    const { reset } = await import('../helpers');
    await reset(ctx);
    await run();
    const reserveBefore = new D(await sys(ctx, 'COMPANY_RESERVE'));
    const esc = new D(await escrow(ctx, marketId));
    const s = await resolve(ctx, marketId, 'YES');
    const payA = xA.toDecimalPlaces(2, Decimal.ROUND_DOWN);
    expect(s.totalPayout).toBe(payA.toFixed(2));
    expect(await balance(ctx, A.id)).toBe(new D(10000).minus(1000).plus(payA).toFixed(2));
    expect(await balance(ctx, B.id)).toBe('9980.00');
    expect(await escrow(ctx, marketId)).toBe('0.00');
    expect(await sys(ctx, 'COMPANY_RESERVE')).toBe(reserveBefore.plus(esc).minus(payA).toFixed(2));
    const recon = await ctx.app.get((await import('../../src/admin/admin.service')).AdminService).reconciliation();
    expect(recon.ok).toBe(true);
  });

  test('NO wins: B is paid 1 birr per share, A gets nothing', async () => {
    const { reset } = await import('../helpers');
    await reset(ctx);
    await run();
    const reserveBefore = new D(await sys(ctx, 'COMPANY_RESERVE'));
    const s = await resolve(ctx, marketId, 'NO');
    const payB = yB.toDecimalPlaces(2, Decimal.ROUND_DOWN);
    expect(s.totalPayout).toBe(payB.toFixed(2));
    expect(await balance(ctx, A.id)).toBe('9000.00');
    expect(await balance(ctx, B.id)).toBe(new D(9980).plus(payB).toFixed(2));
    // operator: got back collateral + 1020 trader cash − B's payout
    const subsidy = b.mul(new D(2).ln()).toDecimalPlaces(2, Decimal.ROUND_UP);
    expect(await sys(ctx, 'COMPANY_RESERVE')).toBe(reserveBefore.plus(subsidy).plus(1020).minus(payB).toFixed(2));
  });
});
