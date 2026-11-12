# API reference

Base path `/api`. JSON in/out. Money is returned as **decimal strings** (`"1000.00"`), shares with 6 dp.

**Auth:** session cookie `tb_session` (HttpOnly, SameSite=Lax) set by `/auth/login` or `/auth/register`.
**CSRF:** every non-GET request must send header `X-CSRF-Token` equal to the `tb_csrf` cookie
(issued on any request). **Errors:** `{ "error": "CODE", "message": "human readable" }`.
**Rate limits:** per IP + target account; stricter on auth, trading and wallet routes.

## Public

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | liveness + DB check |
| GET | `/markets` | `?category=&q=&sort=volume\|trending\|new\|closing&status=open\|closed\|resolved\|all&limit=` (`category=FOOTBALL` / `ENTERTAINMENT_ALL` are groups) |
| GET | `/markets/home` | featured, trending, top, fresh, closing, football, entertainment |
| GET | `/markets/:idOrSlug` | market + `liquidity`, `recentTrades`, `related`, latest `proposal` |
| GET | `/markets/:idOrSlug/history` | `?range=1h\|1d\|1w\|1m\|all` → `[{t, p}]` (≤300 points) |
| GET | `/markets/:idOrSlug/trades` | last 50 trades |
| POST | `/markets/:idOrSlug/quote` | `{side: BUY\|SELL, outcome: YES\|NO, mode: AMOUNT\|SHARES, value}` → shares, amount, fee, total, avgPrice, yesPriceBefore/After, priceImpact, maxPayout, warnings |

## Account

| Method | Path | Body |
|---|---|---|
| POST | `/auth/register` | `{email, username, password, dateOfBirth: YYYY-MM-DD, country: ISO2, locale: en\|am, acceptTerms: true}` — 18+ and `BLOCKED_COUNTRIES` enforced |
| POST | `/auth/login` | `{login (email or username), password}` |
| POST | `/auth/logout` | – |
| GET | `/auth/me` | `{user, balances, unreadNotifications, requires2fa}` |
| PATCH | `/auth/me` | `{displayName?, locale?}` |
| POST | `/auth/2fa/setup` · `/auth/2fa/verify` | TOTP enrolment `{code}` |

## Trading & portfolio (logged in)

| Method | Path | Body / notes |
|---|---|---|
| POST | `/markets/:id/trade` | quote fields + `idempotencyKey` (8–100 chars, required), optional `expectedYesPrice` + `maxSlippage` (default 0.05). Replays return `{replayed: true}` |
| GET | `/portfolio` | cash, positions value, P&L, open/settled positions |
| GET | `/portfolio/trades` | trade history |
| GET | `/portfolio/performance` | `[{t, v}]` portfolio value snapshots |
| GET | `/wallet` · `/wallet/transactions` | balances, payments, ledger lines |
| POST | `/wallet/deposit` · `/wallet/withdraw` | `{amount, idempotencyKey}` — **simulated** |
| POST | `/proposals/:id/dispute` | `{reason, evidenceUrl?}` — traders only, during the window |
| GET | `/notifications` · POST `/notifications/read` | |

## Admin (`/admin/*`, role-gated)

| Permission | Roles | Endpoints |
|---|---|---|
| `admin:read` | ADMIN, RESOLVER, REVIEWER | GET `overview`, `health`, `risk`, `reconciliation`, `ledger`, `trades`, `audit`, `markets`, `markets/:id`, `markets/:id/risk`, `proposals`, `users`, `users/:id`, `payments`, `sports`, `clock` |
| `market:manage` | ADMIN | POST `markets`, PATCH `markets/:id`, POST `markets/:id/publish\|halt\|close\|cancel`, `sports/sync`, `sports/fixtures/:id/markets`, `sports/fixtures/:id/demo-result`, `jobs/run` |
| `market:resolve:propose` | ADMIN, RESOLVER | POST `markets/:id/propose` `{outcome: YES\|NO\|CANCELLED, evidenceUrl, evidenceNotes}` |
| `market:resolve:review` | ADMIN, REVIEWER | POST `proposals/:id/review` `{approve, note}`, `proposals/:id/finalize` |
| `dispute:resolve` | ADMIN, REVIEWER | POST `disputes/:id/resolve` `{uphold, note}` |
| `wallet:adjust` | ADMIN | POST `users/:id/adjust` `{amount: "±123.45", reason (≥10 chars)}`, `reserve/topup` |
| `payments:approve` | ADMIN | POST `payments/:id/review` `{approve, note}` |
| `users:manage` | ADMIN | POST `users/:id/roles`, `users/:id/suspend` |
| `system:clock` | ADMIN | POST `clock/advance` `{hours}` (demo mode only), `clock/reset` |

With `ADMIN_REQUIRE_2FA=true`, every permission-gated route also requires a TOTP-verified session.

## WebSocket (`/socket.io`)

Client → server: `subscribe {markets: [ids]}`, `subscribe:all`.
Server → client: `market:update {id, status, yesPrice, volume, tradesCount, tradingHalted}`,
`trade {marketId, side, outcome, shares, …}`, `portfolio:update`, `notification`.
