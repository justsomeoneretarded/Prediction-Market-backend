# Pricing: the LMSR market maker

Implementation: [`src/lmsr/lmsr.ts`](../src/lmsr/lmsr.ts) (math) and [`src/lmsr/quote.ts`](../src/lmsr/quote.ts) (rounding & fees).
All arithmetic uses `decimal.js` at 40 significant digits.

## Formulas

```
C(qY, qN) = b · ln(e^(qY/b) + e^(qN/b))                     cost function (log-sum-exp, overflow-safe)
p_YES     = ∂C/∂qY = 1 / (1 + e^((qN − qY)/b))              marginal price, always in (0,1)
cost(Δ)   = C(q + Δ) − C(q)                                  what a buyer pays (NOT shares × price)
```

**Initial probability p₀.** The market maker starts at internal state `q₀ = (b·ln p₀, b·ln(1−p₀))`,
which prices YES at exactly p₀ and has `C(q₀) = 0`. Trader shares are tracked separately (`yesShares`,
`noShares`) and added to q₀.

**Worst-case loss.** For any final state and winner i: `loss ≤ −q₀ᵢ = b·ln(1/p₀ᵢ)`, so
`L_max = b · ln(1 / min(p₀, 1−p₀))` (= b·ln 2 ≈ 0.693·b at 50/50). This amount is moved from the company
reserve into the market's escrow when the market is published — the market can never be insolvent.

**Closed-form inverses** (no iterative solvers):
- shares for a spend m: `q'ᵢ = (C+m) + b·ln(1 − e^((qⱼ − C − m)/b))`
- shares to sell for proceeds m: same with `C − m`.

## Rounding (always in favour of the pool)

| Action | Rounding |
|---|---|
| Buy by amount | fee = ⌈total·f/(1+f)⌉ (2 dp); shares = ⌊…⌋ (6 dp) |
| Buy by shares | cost = ⌈C(q+Δ) − C(q)⌉, fee = ⌈cost·f⌉ |
| Sell | proceeds = ⌊C(q) − C(q−Δ)⌋, fee = ⌈proceeds·f⌉ |
| Settlement payout | ⌊shares⌋ to 2 dp |

## The critical scenario (b = 1000, 50/50, no fee)

`pnpm scenario` — computed by the production code; the same flow is executed against Postgres in
`test/integration/critical-scenario.spec.ts` and through the browser in the web repo's `e2e/acceptance.spec.ts`.

```
Market-maker collateral b·ln2          693.15
1. A shares (YES)                      1489.880125
1. B shares (NO)                       104.203130
2. A avg price                         0.671195
2. B avg price                         0.191933
3. YES price after A                   0.816060
3. YES / NO price after B              0.799901 / 0.200099
4. Escrow (collateral + trader cash)   1713.15
4. Operator exposure (worst case now)  469.88
5. If YES: A receives / B receives     1489.88 / 0.00
5. If YES: operator P&L                -469.88
6. If NO: A receives / B receives      0.00 / 104.20
6. If NO: operator P&L                 915.80
7. Reserve left in escrow if YES       223.27
7. Reserve left in escrow if NO        1608.95
```

Reading it: A pushed YES from 50% to 81.6% and paid an average of 67.1¢ (slippage). B bought NO cheaply
at ~19.2¢. If YES wins, the operator pays 1,489.88 from an escrow of 1,713.15 and loses 469.88 — less
than the 693.15 it pre-funded. The leftover 223.27 returns to the company reserve.
Note that the 1,020 birr traders paid in is **not** enough to pay YES holders on its own — the
market-maker collateral is what makes the payout safe.

## Choosing b (for operators)

| b | 50/50 collateral | Price after a 1,000 Br YES buy |
|---:|---:|---:|
| 500 | 346.57 | ~93% |
| 1,000 | 693.15 | ~82% |
| 3,000 | 2,079.44 | ~64% |
| 10,000 | 6,931.47 | ~55% |

Rule of thumb: pick b ≈ the typical single trade size you expect × 2–3. Bigger b = deeper market,
more collateral at risk.
