/**
 * Logarithmic Market Scoring Rule (LMSR) for binary YES/NO markets.
 *
 *   C(qY, qN) = b · ln(e^(qY/b) + e^(qN/b))
 *   p_YES     = ∂C/∂qY = e^(qY/b) / (e^(qY/b) + e^(qN/b)) = 1 / (1 + e^((qN − qY)/b))
 *
 * Pure functions on decimal.js values (40 significant digits) — no JS floats.
 *
 * Non-50/50 starts: the market maker begins at the internal state
 *   q0 = (b·ln p0, b·ln(1 − p0))
 * which prices YES at exactly p0 and has C(q0) = b·ln(p0 + 1 − p0) = 0.
 * Trader-held shares (sY, sN) are tracked separately; the internal state is
 * q = q0 + s. With this offset the market maker's worst-case loss is
 *   L_max = b · ln(1 / min(p0, 1 − p0))          (= b·ln 2 at 50/50)
 * because for any final state and winning outcome i:
 *   loss_i = s_i − (C(q) − C(q0)) = s_i + q0_i − C(q) − q0_i ≤ −q0_i = −b·ln p0_i.
 */
import Decimal from 'decimal.js';

export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export type Dec = InstanceType<typeof D>;
export type DecLike = Dec | Decimal | string | number;

export const SHARE_DP = 6;
export const MONEY_DP = 2;

export const dec = (v: DecLike): Dec => new D(v.toString());

export type Side = 'YES' | 'NO';

export interface LmsrParams {
  b: DecLike;           // liquidity parameter
  p0: DecLike;          // initial YES probability
}

export interface MarketState extends LmsrParams {
  yesShares: DecLike;   // trader-held YES shares outstanding
  noShares: DecLike;    // trader-held NO shares outstanding
}

/** ln(e^x + e^y), computed without overflow. */
export function logSumExp(x: Dec, y: Dec): Dec {
  const m = D.max(x, y);
  return m.plus(D.exp(x.minus(m)).plus(D.exp(y.minus(m))).ln());
}

function internalQ(s: MarketState): { qY: Dec; qN: Dec; b: Dec } {
  const b = dec(s.b);
  const p0 = dec(s.p0);
  return {
    b,
    qY: b.mul(p0.ln()).plus(dec(s.yesShares)),
    qN: b.mul(new D(1).minus(p0).ln()).plus(dec(s.noShares)),
  };
}

/** Cost function C(q) on the internal state. */
export function cost(s: MarketState): Dec {
  const { qY, qN, b } = internalQ(s);
  return b.mul(logSumExp(qY.div(b), qN.div(b)));
}

/** Marginal (instantaneous) price of YES, strictly inside (0, 1). */
export function priceYes(s: MarketState): Dec {
  const { qY, qN, b } = internalQ(s);
  // 1 / (1 + e^((qN − qY)/b)) — stable for large |qN − qY|
  const z = qN.minus(qY).div(b);
  if (z.gt(0)) {
    const e = D.exp(z.neg());
    return e.div(new D(1).plus(e));
  }
  return new D(1).div(new D(1).plus(D.exp(z)));
}

export function prices(s: MarketState): { yes: Dec; no: Dec } {
  const yes = priceYes(s);
  return { yes, no: new D(1).minus(yes) };
}

/** Worst-case market-maker loss for these parameters. */
export function maxLoss({ b, p0 }: LmsrParams): Dec {
  const p = dec(p0);
  const pMin = D.min(p, new D(1).minus(p));
  return dec(b).mul(new D(1).div(pMin).ln());
}

function withShares(s: MarketState, side: Side, delta: Dec): MarketState {
  return side === 'YES'
    ? { ...s, yesShares: dec(s.yesShares).plus(delta) }
    : { ...s, noShares: dec(s.noShares).plus(delta) };
}

/** Exact LMSR cost of buying `shares` of `side` (C(q + Δ) − C(q)). */
export function costToBuy(s: MarketState, side: Side, shares: DecLike): Dec {
  return cost(withShares(s, side, dec(shares))).minus(cost(s));
}

/** Exact LMSR proceeds from selling `shares` of `side` (C(q) − C(q − Δ)). */
export function proceedsFromSell(s: MarketState, side: Side, shares: DecLike): Dec {
  return cost(s).minus(cost(withShares(s, side, dec(shares).neg())));
}

/**
 * Shares received for spending `amount` (net of fees) on `side`. Closed form:
 *   e^(q'_i/b) = e^((C + m)/b) − e^(q_j/b)
 *   q'_i = (C + m) + b·ln(1 − e^((q_j − C − m)/b))
 */
export function sharesForAmount(s: MarketState, side: Side, amount: DecLike): Dec {
  const m = dec(amount);
  if (m.lte(0)) return new D(0);
  const { qY, qN, b } = internalQ(s);
  const c = cost(s);
  const target = c.plus(m);
  const qi = side === 'YES' ? qY : qN;
  const qj = side === 'YES' ? qN : qY;
  const inner = new D(1).minus(D.exp(qj.minus(target).div(b)));
  const qiNew = target.plus(b.mul(inner.ln()));
  return qiNew.minus(qi);
}

/** Shares that must be sold of `side` to receive exactly `amount` gross proceeds. */
export function sharesToSellForAmount(s: MarketState, side: Side, amount: DecLike): Dec {
  const m = dec(amount);
  if (m.lte(0)) return new D(0);
  const { qY, qN, b } = internalQ(s);
  const target = cost(s).minus(m);
  const qi = side === 'YES' ? qY : qN;
  const qj = side === 'YES' ? qN : qY;
  // e^(q'_i/b) = e^(target/b) − e^(q_j/b) must be > 0, i.e. target > q_j
  if (target.lte(qj)) return new D(Infinity);
  const inner = new D(1).minus(D.exp(qj.minus(target).div(b)));
  const qiNew = target.plus(b.mul(inner.ln()));
  return qi.minus(qiNew);
}

export const floorTo = (x: Dec, dp: number) => x.toDecimalPlaces(dp, D.ROUND_DOWN);
export const ceilTo = (x: Dec, dp: number) => x.toDecimalPlaces(dp, D.ROUND_UP);

/** Price clamped for storage/display (DB requires 0 < p < 1 with 8 dp). */
export const PRICE_FLOOR = new D('0.000001');
export function clampPrice(p: Dec): Dec {
  return D.min(D.max(p, PRICE_FLOOR), new D(1).minus(PRICE_FLOOR));
}
