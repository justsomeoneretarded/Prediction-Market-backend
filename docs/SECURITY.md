# Security & financial-integrity notes

> **Tinbit is not production-secure just because the tests pass.** Before any real-money operation it
> needs: a licence/regulatory approval for each jurisdiction, an independent security penetration test,
> an independent review of the pricing/settlement/accounting logic, KYC/AML processes, and a real
> payment provider integration reviewed on its own.

## What is implemented

| Area | Implementation |
|---|---|
| Passwords | Argon2id (`@node-rs/argon2`, 19 MiB, t=2); constant-ish timing for unknown users |
| Sessions | Random 256-bit token in an HttpOnly, SameSite=Lax cookie (`Secure` via `COOKIE_SECURE`); only its SHA-256 is stored; server-side expiry & revocation on suspend |
| CSRF | Double-submit token (`tb_csrf` cookie ↔ `X-CSRF-Token` header) on every mutating request |
| Rate limiting | `@nestjs/throttler`, keyed by IP + target account; tighter on login/register/trade/wallet |
| Input validation | Zod schemas on every body; money/shares as decimal strings with bounded precision |
| Authorization | Permission → role map (`src/auth/auth.types.ts`); four-eyes rule on resolution & disputes |
| Admin auth | TOTP 2FA; `ADMIN_REQUIRE_2FA=true` makes it mandatory for every privileged route |
| Headers | Helmet on the API (CSP `default-src 'none'`), frame/nosniff/referrer/permissions headers on the web |
| Double spending | Market + position + account row locks in one transaction; DB CHECK `balance >= 0` |
| Idempotency | `Trade(userId, idempotencyKey)` and `PaymentIntent(userId, idempotencyKey)` unique |
| Atomicity | Every money movement in a single DB transaction; retried on deadlock/serialization errors |
| Ledger integrity | Deferred trigger rejects unbalanced entries; ledger + audit tables are append-only (triggers) |
| Audit | `AuditLog` for logins, market changes, resolution steps, adjustments (reason required), payments |
| Settlement | Exactly once (`Settlement.marketId` unique + status check under lock), idempotent retries |
| Age / jurisdiction | 18+ (`MIN_AGE`) at registration; `BLOCKED_COUNTRIES` list |
| Secrets | Only via environment variables; `.env` is git-ignored; no credentials in the repo |
| Real money | Disabled. Only `SimulatedPaymentProvider`; webhook route refuses all providers |

## Known limitations / to do before a real launch

- Country is self-declared; add IP geolocation and KYC before any regulated launch.
- Rate-limit storage is in-memory (per instance) — use Redis when running several instances.
- No email verification / password reset flow yet.
- Mock football data is for demonstration only; API-Football adapter is written but untested without credentials (verify league ids).
- No automated anomaly detection on trading (wash trading, collusion); admin can halt markets manually.
- Dispute resolution is by staff; there is no external arbitration.
- The demo clock (`/admin/clock/advance`) must stay disabled in production (`DEMO_MODE=false`).
- Dependencies should be scanned (`pnpm audit`) and pinned/updated on a schedule.

## Review checklist for auditors

1. `src/lmsr/*` — pricing, inverses, rounding direction (`test/unit/lmsr.spec.ts`).
2. `src/trading/trading.service.ts` — lock order (market → position → accounts sorted), solvency check.
3. `src/ledger/ledger.service.ts` + migration SQL — balanced entries, non-negative constraints, append-only.
4. `src/resolution/resolution.service.ts` — settlement maths for YES/NO/CANCELLED policies.
5. `src/admin/admin.service.ts#reconciliation` — invariants checked in production.
6. `test/integration/*` — concurrency, idempotency, rollback, RBAC.
