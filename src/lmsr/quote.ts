/**
 * Turns an LMSR state + a trade request into an exact, rounded execution plan.
 *
 * Rounding always favours the market's solvency (never the trader, never the house's
 * books in a way that could break the escrow invariant):
 *   - buys:  shares are floored to 6 dp, costs are ceiled to 2 dp
 *   - sells: proceeds are floored to 2 dp
 * so the escrow always holds ≥ C(q) − C(q0) + subsidy ≥ max possible payout.
 */
import {
  D, Dec, DecLike, MarketState, Side, dec, priceYes, costToBuy, proceedsFromSell,
  sharesForAmount, sharesToSellForAmount, floorTo, ceilTo, SHARE_DP, MONEY_DP,
} from './lmsr';

export type TradeSide = 'BUY' | 'SELL';
export type QuoteMode = 'AMOUNT' | 'SHARES';

export interface QuoteRequest {
  side: TradeSide;
  outcome: Side;
  mode: QuoteMode;
  /** birr when mode = AMOUNT (BUY: total to spend incl. fee; SELL: cash to receive after fee), shares when mode = SHARES */
  value: DecLike;
}

export interface Quote {
  side: TradeSide;
  outcome: Side;
  shares: Dec;          // shares bought or sold
  amount: Dec;          // cash into (BUY) / out of (SELL) the market escrow, excl. fee
  fee: Dec;
  total: Dec;           // BUY: what the user pays (amount + fee). SELL: what the user receives (amount − fee)
  avgPrice: Dec;        // amount / shares (pure LMSR execution price)
  yesPriceBefore: Dec;
  yesPriceAfter: Dec;
  priceImpact: Dec;     // change in the traded outcome's price, in probability points (0..1)
  maxPayout: Dec;       // BUY: what these shares pay if the outcome wins
}

export class QuoteError extends Error {}

export const MIN_TRADE = new D('1');
export const MIN_SHARES = new D('0.01');

const feeOf = (x: Dec, feeBps: number) => ceilTo(x.mul(feeBps).div(10000), MONEY_DP);

export function quote(state: MarketState, feeBps: number, req: QuoteRequest): Quote {
  const value = dec(req.value);
  if (!value.isFinite() || value.lte(0)) throw new QuoteError('Amount must be greater than zero');
  const before = priceYes(state);
  let shares: Dec;
  let amount: Dec;
  let fee: Dec;
  let total: Dec;

  if (req.side === 'BUY') {
    if (req.mode === 'AMOUNT') {
      total = floorTo(value, MONEY_DP);
      if (total.lt(MIN_TRADE)) throw new QuoteError(`Minimum trade is ${MIN_TRADE} birr`);
      // fee is a share of the total spend: total = amount + fee
      fee = ceilTo(total.mul(feeBps).div(10000 + feeBps), MONEY_DP);
      amount = total.minus(fee);
      shares = floorTo(sharesForAmount(state, req.outcome, amount), SHARE_DP);
    } else {
      shares = floorTo(value, SHARE_DP);
      if (shares.lt(MIN_SHARES)) throw new QuoteError(`Minimum is ${MIN_SHARES} shares`);
      amount = ceilTo(costToBuy(state, req.outcome, shares), MONEY_DP);
      fee = feeOf(amount, feeBps);
      total = amount.plus(fee);
      if (total.lt(MIN_TRADE)) throw new QuoteError(`Minimum trade is ${MIN_TRADE} birr`);
    }
  } else {
    if (req.mode === 'AMOUNT') {
      const want = floorTo(value, MONEY_DP);
      if (want.lt(MIN_TRADE)) throw new QuoteError(`Minimum trade is ${MIN_TRADE} birr`);
      // gross g such that g − fee(g) ≥ want; solve then re-price from whole shares
      const gross = ceilTo(want.mul(10000).div(10000 - feeBps), MONEY_DP).plus('0.01');
      const needed = sharesToSellForAmount(state, req.outcome, gross);
      if (!needed.isFinite()) throw new QuoteError('Not enough liquidity to pay that amount');
      shares = ceilTo(needed, SHARE_DP);
    } else {
      shares = floorTo(value, SHARE_DP);
    }
    if (shares.lt(MIN_SHARES)) throw new QuoteError(`Minimum is ${MIN_SHARES} shares`);
    amount = floorTo(proceedsFromSell(state, req.outcome, shares), MONEY_DP);
    fee = feeOf(amount, feeBps);
    total = amount.minus(fee);
    if (total.lte(0)) throw new QuoteError('Trade too small to cover fees');
  }

  if (shares.lte(0)) throw new QuoteError('Trade too small');

  const delta = req.side === 'BUY' ? shares : shares.neg();
  const after = priceYes(
    req.outcome === 'YES'
      ? { ...state, yesShares: dec(state.yesShares).plus(delta) }
      : { ...state, noShares: dec(state.noShares).plus(delta) },
  );
  const sideBefore = req.outcome === 'YES' ? before : new D(1).minus(before);
  const sideAfter = req.outcome === 'YES' ? after : new D(1).minus(after);

  return {
    side: req.side,
    outcome: req.outcome,
    shares,
    amount,
    fee,
    total,
    avgPrice: amount.div(shares),
    yesPriceBefore: before,
    yesPriceAfter: after,
    priceImpact: sideAfter.minus(sideBefore),
    maxPayout: req.side === 'BUY' ? shares : new D(0),
  };
}

export function serializeQuote(q: Quote) {
  return {
    side: q.side,
    outcome: q.outcome,
    shares: q.shares.toFixed(SHARE_DP),
    amount: q.amount.toFixed(MONEY_DP),
    fee: q.fee.toFixed(MONEY_DP),
    total: q.total.toFixed(MONEY_DP),
    avgPrice: q.avgPrice.toFixed(6),
    yesPriceBefore: q.yesPriceBefore.toFixed(6),
    yesPriceAfter: q.yesPriceAfter.toFixed(6),
    priceImpact: q.priceImpact.toFixed(6),
    maxPayout: q.maxPayout.toFixed(MONEY_DP),
  };
}
