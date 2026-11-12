# Tinbit API — notes for AI assistants

Read `docs/ARCHITECTURE.md` first; `docs/graph/CODEMAP.md` lists every file with a one-line summary
(regenerate with `pnpm codemap` after adding files — keep a `/** … */` header comment on new files).

## Where things are
- Pricing math: `src/lmsr/lmsr.ts` (pure), rounding/fees: `src/lmsr/quote.ts`
- Trade execution & locking: `src/trading/trading.service.ts`
- Double-entry ledger: `src/ledger/ledger.service.ts`; DB constraints/triggers: `prisma/migrations/*_init/migration.sql`
- Market lifecycle, funding, risk numbers: `src/markets/markets.service.ts`
- Resolution, disputes, settlement, cancellation: `src/resolution/resolution.service.ts`
- Football adapters + auto-resolution: `src/sports/`
- Admin endpoints: `src/admin/`; permissions map: `src/auth/auth.types.ts`
- Scheduler (open/close markets, auto-propose, finalize): `src/scheduler/scheduler.service.ts`

## Invariants — never break
1. Money only moves through `LedgerService.post` inside `prisma.atomic`, and every entry sums to 0.
2. Lock order in a transaction: market row → position row → accounts (sorted by id).
3. Never use JS numbers for balances/shares — use `dec()` / Prisma Decimal / strings.
4. Rounding favours the pool (floor shares & proceeds, ceil costs & fees).
5. Escrow ≥ max(yesShares, noShares) for every funded, unsettled market.
6. Liquidity params (b, p0, fee) are immutable after publish.
7. Realtime events are emitted only after commit.

## Testing
`pnpm test` (needs Postgres with a `tinbit_test` database; suites run serially). `pnpm scenario` prints the
critical 1,000/20 scenario. E2E browser tests live in the frontend repo (`pnpm e2e`).

## Dev loop
`pnpm dev` compiles with `tsc` (not tsx — Nest DI needs decorator metadata). Scripts run with
`node -r ts-node/register/transpile-only` for the same reason.
