# Build checklist

✅ done & tested · 🟡 done, limited/untested part noted · ⛔ not done / blocked

## Phase 1 — Foundation
- ✅ Two repos (API + web) instead of one monorepo — you supplied two repos; there's no shared package because the browser gets quotes from the API, so pricing logic exists in one place only
- ✅ NestJS API, Next.js web, PostgreSQL + Prisma migrations
- ✅ Session auth (Argon2, HttpOnly cookies, CSRF), RBAC (user / resolver / reviewer / admin), TOTP 2FA
- ✅ One-command dev (`pnpm dev:all`), Docker Compose with health-checked startup order

## Phase 2 — Core markets
- ✅ Market creation (draft / scheduled / publish), all required fields & statuses
- ✅ LMSR pricing (log-sum-exp, closed-form inverses, configurable initial probability)
- ✅ Buy/sell by amount or shares, previews with avg price, fee, impact, payout

## Phase 3 — Accounting & liquidity
- ✅ Double-entry ledger, available/reserved balances, append-only, balanced-entry trigger
- ✅ Company reserve → per-market escrow funding of the worst-case loss b·ln(1/p_min); risk budget check
- ✅ Exposure, P&L-per-outcome, reserve coverage per market; reconciliation endpoint
- ✅ Simulated deposits/withdrawals with approval workflow; payment-provider interface (real money disabled)

## Phase 4 — Trading interface
- ✅ Trade panel, portfolio (positions, P&L, trades, wallet history, performance chart)
- ✅ Live prices/trades/portfolio/notifications via Socket.IO
- ✅ English + Amharic (Noto Sans Ethiopic), light/dark, mobile tab bar

## Phase 5 — Resolution
- ✅ Propose with evidence → second-person review → dispute window → dispute handling → finalize → settle
- ✅ YES/NO settlement, cancellation (net-cost refund or last price), exactly-once settlement
- ✅ Simulated clock for testing dispute windows (demo mode)

## Phase 6 — Sports & entertainment
- ✅ Provider adapter interface, mock provider (labelled demo), four football market templates, trading closes at kickoff
- ✅ Auto-resolution from provider results; cancelled/abandoned/postponed → human review
- 🟡 API-Football adapter written but **not exercised** (no credentials); confirm league IDs (esp. Ethiopian PL)
- ✅ Manual-evidence markets for music/TV/culture (seeded demo examples)

## Phase 7 — Admin
- ✅ Overview, markets, risk, resolution queue, disputes, users (roles, suspend, adjustments with reasons), payments, sports, trades, ledger, audit log, health, reconciliation, demo clock

## Phase 8 — Reliability
- ✅ 52 API tests (unit + integration: concurrency, idempotency, rollback, RBAC, settlement, critical scenario)
- ✅ 3 Playwright E2E tests (full acceptance flow in the browser + mobile)
- ✅ Docker images build; compose stack verified healthy; backup → restore round trip verified
- ⛔ Independent security audit / financial review (required before real money)
- ⛔ Limit orders (architecture allows adding an `Order` table later)
- ⛔ Email verification & password reset
