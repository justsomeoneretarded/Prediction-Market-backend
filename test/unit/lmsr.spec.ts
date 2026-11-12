import {
  D, dec, cost, priceYes, maxLoss, costToBuy, proceedsFromSell, sharesForAmount,
  sharesToSellForAmount, logSumExp, MarketState, clampPrice,
} from '../../src/lmsr/lmsr';
import { quote, QuoteError } from '../../src/lmsr/quote';

const m = (b: number, p0: string, y = '0', n = '0'): MarketState => ({ b, p0, yesShares: y, noShares: n });
const close = (a: InstanceType<typeof D>, b: string | number, tol = '1e-12') =>
  expect(a.minus(b).abs().lte(tol)).toBe(true);

describe('LMSR math', () => {
  test('a fresh 50/50 market prices YES at exactly 0.5', () => {
    close(priceYes(m(1000, '0.5')), '0.5');
    close(cost(m(1000, '0.5')), 0); // C(q0) = 0 by construction
  });

  test.each(['0.01', '0.2', '0.35', '0.5', '0.73', '0.99'])('initial probability %s is honoured', (p) => {
    close(priceYes(m(500, p)), p);
  });

  test('buying YES raises YES price; buying NO lowers it', () => {
    const s = m(1000, '0.5');
    expect(priceYes({ ...s, yesShares: 100 }).gt('0.5')).toBe(true);
    expect(priceYes({ ...s, noShares: 100 }).lt('0.5')).toBe(true);
  });

  test('larger trades move price more; higher liquidity moves it less', () => {
    const small = priceYes(m(1000, '0.5', '100'));
    const big = priceYes(m(1000, '0.5', '1000'));
    expect(big.gt(small)).toBe(true);
    const deep = priceYes(m(10000, '0.5', '1000'));
    expect(deep.lt(big)).toBe(true);
  });

  test('execution cost exceeds shares × starting marginal price (slippage)', () => {
    const s = m(1000, '0.5');
    const c = costToBuy(s, 'YES', 1000);
    expect(c.gt(dec(1000).mul('0.5'))).toBe(true);
    expect(c.lt(1000)).toBe(true); // but never more than the max payout
  });

  test('sharesForAmount is the exact inverse of costToBuy', () => {
    for (const p of ['0.5', '0.2', '0.9']) {
      for (const amt of ['1', '20', '1000', '25000']) {
        const s = m(1000, p, '123.45', '67.8');
        for (const side of ['YES', 'NO'] as const) {
          const sh = sharesForAmount(s, side, amt);
          close(costToBuy(s, side, sh), amt, '1e-20');
        }
      }
    }
  });

  test('sharesToSellForAmount inverts proceedsFromSell', () => {
    const s = m(1000, '0.5', '2000', '500');
    const sh = sharesToSellForAmount(s, 'YES', '700');
    close(proceedsFromSell(s, 'YES', sh), '700', '1e-20');
  });

  test('buy then sell the same shares is a round trip (no free money)', () => {
    const s = m(800, '0.4', '50', '10');
    const c = costToBuy(s, 'NO', 333);
    const after = { ...s, noShares: dec(s.noShares).plus(333) };
    close(proceedsFromSell(after, 'NO', 333), c.toString(), '1e-25');
  });

  test('prices stay within [0,1] for extreme states and clamp strictly inside for storage', () => {
    const p = priceYes(m(10, '0.5', '1000000', '0'));
    expect(p.lte(1)).toBe(true);
    expect(clampPrice(p).lt(1)).toBe(true);
    const q = priceYes(m(10, '0.5', '0', '1000000'));
    expect(q.gte(0)).toBe(true);
    expect(clampPrice(q).gt(0)).toBe(true);
    const mid = priceYes(m(1000, '0.5', '5000', '0'));
    expect(mid.lt(1)).toBe(true);
  });

  test('log-sum-exp does not overflow', () => {
    const r = logSumExp(dec('1e6'), dec('1e6'));
    close(r, dec('1e6').plus(dec(2).ln()).toString(), '1e-20');
  });

  test('worst-case loss = b·ln(1/p_min) and is never exceeded', () => {
    close(maxLoss({ b: 1000, p0: '0.5' }), dec(1000).mul(dec(2).ln()).toString());
    close(maxLoss({ b: 1000, p0: '0.8' }), dec(1000).mul(dec(5).ln()).toString());
    // simulate a whale buying almost all YES: loss approaches but never exceeds the bound
    for (const p0 of ['0.5', '0.8', '0.1']) {
      const s = m(1000, p0);
      const bound = maxLoss({ b: 1000, p0 });
      for (const sh of [10, 1000, 10000, 100000]) {
        for (const side of ['YES', 'NO'] as const) {
          const collected = costToBuy(s, side, sh);
          const loss = dec(sh).minus(collected);
          expect(loss.lte(bound.plus('1e-25'))).toBe(true);
        }
      }
    }
  });
});

describe('quote()', () => {
  test('buy by amount: fee, shares, avg price and impact are consistent', () => {
    const q = quote(m(1000, '0.5'), 100, { side: 'BUY', outcome: 'YES', mode: 'AMOUNT', value: '101' });
    expect(q.total.toFixed(2)).toBe('101.00');
    expect(q.fee.toFixed(2)).toBe('1.00');
    expect(q.amount.toFixed(2)).toBe('100.00');
    expect(q.avgPrice.gt('0.5')).toBe(true);
    expect(q.priceImpact.gt(0)).toBe(true);
    // floor-rounded shares never cost more than what was collected
    expect(costToBuy(m(1000, '0.5'), 'YES', q.shares).lte(q.amount)).toBe(true);
  });

  test('buy by shares charges the full LMSR integral, rounded up', () => {
    const s = m(1000, '0.5');
    const q = quote(s, 0, { side: 'BUY', outcome: 'NO', mode: 'SHARES', value: '250' });
    expect(q.amount.gte(costToBuy(s, 'NO', 250))).toBe(true);
    expect(q.yesPriceAfter.lt('0.5')).toBe(true);
  });

  test('sell by amount delivers at least the requested cash', () => {
    const s = m(1000, '0.5', '3000', '0');
    const q = quote(s, 100, { side: 'SELL', outcome: 'YES', mode: 'AMOUNT', value: '500' });
    expect(q.total.gte(500)).toBe(true);
    expect(q.yesPriceAfter.lt(q.yesPriceBefore)).toBe(true);
  });

  test('rejects invalid inputs', () => {
    const s = m(1000, '0.5');
    expect(() => quote(s, 100, { side: 'BUY', outcome: 'YES', mode: 'AMOUNT', value: '0' })).toThrow(QuoteError);
    expect(() => quote(s, 100, { side: 'BUY', outcome: 'YES', mode: 'AMOUNT', value: '-5' })).toThrow(QuoteError);
    expect(() => quote(s, 100, { side: 'BUY', outcome: 'YES', mode: 'AMOUNT', value: '0.5' })).toThrow(QuoteError);
    expect(() => quote(s, 100, { side: 'BUY', outcome: 'YES', mode: 'AMOUNT', value: 'NaN' })).toThrow();
    expect(() => quote(s, 100, { side: 'SELL', outcome: 'YES', mode: 'SHARES', value: '0.001' })).toThrow(QuoteError);
  });
});
