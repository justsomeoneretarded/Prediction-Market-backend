/**
 * Prints the spec's critical scenario using the production pricing code (src/lmsr):
 *   50/50 market → A spends 1,000 on YES → B spends 20 on NO.
 * Usage: pnpm scenario [b] [feeBps]      (defaults: b = 1000, fee = 0)
 * The same scenario is executed against the real database in test/integration/critical-scenario.spec.ts.
 */
import { D, ceilTo, floorTo, maxLoss, priceYes } from '../src/lmsr/lmsr';
import { quote } from '../src/lmsr/quote';

const b = Number(process.argv[2] ?? 1000);
const fee = Number(process.argv[3] ?? 0);
let s = { b, p0: '0.5', yesShares: new D(0), noShares: new D(0) };
const subsidy = ceilTo(maxLoss(s), 2);

const qa = quote(s, fee, { side: 'BUY', outcome: 'YES', mode: 'AMOUNT', value: '1000' });
s = { ...s, yesShares: s.yesShares.plus(qa.shares) };
const qb = quote(s, fee, { side: 'BUY', outcome: 'NO', mode: 'AMOUNT', value: '20' });
s = { ...s, noShares: s.noShares.plus(qb.shares) };

const escrow = subsidy.plus(qa.amount).plus(qb.amount);
const payYes = floorTo(qa.shares, 2);
const payNo = floorTo(qb.shares, 2);
const f = (x: InstanceType<typeof D>, dp = 2) => x.toFixed(dp);
const rows: [string, string][] = [
  ['Liquidity b / fee', `${b} / ${fee / 100}%`],
  ['Market-maker collateral b·ln2', f(subsidy)],
  ['1. A shares (YES)', f(qa.shares, 6)],
  ['1. B shares (NO)', f(qb.shares, 6)],
  ['2. A avg price', f(qa.avgPrice, 6)],
  ['2. B avg price', f(qb.avgPrice, 6)],
  ['3. YES price after A', f(qa.yesPriceAfter, 6)],
  ['3. YES / NO price after B', `${f(priceYes(s), 6)} / ${f(new D(1).minus(priceYes(s)), 6)}`],
  ['4. Escrow (collateral + trader cash)', f(escrow)],
  ['4. Operator exposure (worst case now)', f(D.max(payYes.minus(escrow.minus(subsidy)), 0))],
  ['5. If YES: A receives / B receives', `${f(payYes)} / 0.00`],
  ['5. If YES: operator P&L', f(escrow.minus(subsidy).minus(payYes))],
  ['6. If NO: A receives / B receives', `0.00 / ${f(payNo)}`],
  ['6. If NO: operator P&L', f(escrow.minus(subsidy).minus(payNo))],
  ['7. Reserve left in escrow if YES', f(escrow.minus(payYes))],
  ['7. Reserve left in escrow if NO', f(escrow.minus(payNo))],
  ['Fees collected', f(qa.fee.plus(qb.fee))],
];
const w = Math.max(...rows.map((r) => r[0].length));
for (const [k, v] of rows) console.log(`${k.padEnd(w)}  ${v}`);
