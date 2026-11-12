# Tinbit architecture

Tinbit (ትንቢት, "prophecy") is a YES/NO prediction market for Ethiopian and international events,
running on **virtual birr**. It is built to be cheap and simple to run for a small team:

| Piece | Choice | Why (for a beginner startup) |
|---|---|---|
| Web | Next.js 15 (App Router), Tailwind v4, SWR, socket.io-client | One small app, mobile-first, ~130–150 kB first load |
| API | NestJS 11 modular monolith | One deployable; modules can be split later if ever needed |
| DB | PostgreSQL 16 + Prisma 6 | The database is the source of truth for money; constraints & triggers enforce invariants |
| Real-time | Socket.IO inside the API | No extra service. Events are hints; clients re-fetch from the API |
| Jobs | In-process scheduler (`@nestjs/schedule`) | Replaces BullMQ/Redis for now — every job is idempotent and row-locked, so it is safe to move to a queue later |
| Money math | `decimal.js` (40 significant digits), `NUMERIC` columns | No JS floats anywhere near balances |

> **Deliberate simplification:** the original brief asked for Redis + BullMQ. At Tinbit's size they add a
> service to run, monitor and pay for without adding safety (the DB already serialises trades). Add
> Redis when you run >1 API instance (Socket.IO adapter + shared rate-limit store) — see "Scaling" below.

## System

```mermaid
flowchart LR
  U[Phone / browser] -->|HTTPS| W[Next.js web :3000]
  W -->|/api/* rewrite| A[NestJS API :4000]
  W -->|/socket.io| A
  A -->|Prisma, row locks| P[(PostgreSQL)]
  A -.->|adapter| F[Football data provider<br/>mock or API-Football]
  A -.->|adapter, DISABLED| M[Payment provider<br/>simulated only]
  S[Scheduler 15s tick] --> A
  B[backup container<br/>daily pg_dump] --> P
```

## API modules (`src/`)

```mermaid
flowchart TB
  auth[auth<br/>sessions, CSRF, RBAC, TOTP] --> wallet
  trading[trading<br/>quote + execute] --> markets & ledger & portfolio
  markets[markets<br/>create, publish, lifecycle, risk] --> ledger
  resolution[resolution<br/>propose → review → dispute → finalize → settle] --> markets & ledger
  sports[sports<br/>provider adapters, football templates, auto-resolve] --> resolution & markets
  scheduler --> markets & resolution & sports & portfolio
  admin --> markets & resolution & sports & wallet & ledger
  wallet[wallet<br/>balances, simulated deposits/withdrawals] --> ledger
  ledger[ledger<br/>double-entry, account locks] --> db[(Postgres)]
  lmsr[lmsr<br/>pure pricing math] -.-> trading & markets
```

Generated file-level map: [`docs/graph/CODEMAP.md`](graph/CODEMAP.md) (`pnpm codemap` to refresh).

## Where money lives (ledger accounts)

Every movement is a balanced `JournalEntry` (lines sum to 0 — enforced by a deferred DB trigger).

```mermaid
flowchart LR
  EQ[EQUITY<br/>virtual capital] -->|genesis / top-up| R[COMPANY_RESERVE]
  PR[PROMOTIONS] -->|signup bonus| UA[USER_AVAILABLE]
  R -->|publish: fund b·ln 1/p| E[MARKET_ESCROW per market]
  UA -->|buy: amount| E
  UA -->|buy/sell fee| FEE[FEE_REVENUE]
  E -->|sell proceeds| UA
  E -->|settlement: 1 Br per winning share| UA
  E -->|leftover after settlement| R
  UA <-->|withdraw hold / release| UR[USER_RESERVED]
  UR -->|withdrawal paid| PC[PAYMENT_CLEARING]
  PC -->|deposit| UA
  ADJ[ADJUSTMENTS] <-->|audited admin adjustment| UA
```

Customer funds (`USER_*`), per-market escrow, company reserve and fee revenue are separate accounts,
so the admin overview can always answer "whose money is this?".

**Solvency invariant** (checked inside every trade transaction and by reconciliation):
`escrow ≥ max(outstanding YES shares, outstanding NO shares)`. It always holds because the escrow is
pre-funded with the LMSR worst-case loss and rounding always favours the pool.

## A trade, step by step

```mermaid
sequenceDiagram
  participant UI as Trade panel
  participant API as TradingService
  participant DB as Postgres (one transaction)
  UI->>API: POST /markets/:id/quote (debounced preview)
  API-->>UI: shares, avg price, fee, impact, payout
  UI->>API: POST /markets/:id/trade {idempotencyKey, expectedYesPrice}
  API->>DB: idempotency key seen? → return original trade
  API->>DB: SELECT market FOR UPDATE (serialises trades per market)
  API->>DB: SELECT position FOR UPDATE
  API->>API: re-quote from LOCKED state, check slippage, limits, status
  API->>DB: ledger.post → locks accounts (sorted), checks balances
  API->>DB: update position, market q, volume, price point, trade row
  API->>DB: check escrow ≥ worst payout (else rollback)
  DB-->>API: COMMIT (all or nothing)
  API-->>UI: trade
  API-)UI: socket "market:update" / "trade" / "portfolio:update" (after commit)
```

Duplicate clicks or network retries reuse the same `idempotencyKey` → the unique index
`Trade(userId, idempotencyKey)` guarantees exactly-once execution.

## Market lifecycle & resolution

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> SCHEDULED: publish (opens later)
  DRAFT --> OPEN: publish (collateral funded)
  SCHEDULED --> OPEN: opensAt reached
  OPEN --> CLOSED: closesAt / kickoff / admin
  CLOSED --> AWAITING_RESOLUTION: proposal (resolver or provider)
  AWAITING_RESOLUTION --> AWAITING_RESOLUTION: reviewer rejects → new proposal
  AWAITING_RESOLUTION --> DISPUTED: trader disputes in window
  DISPUTED --> AWAITING_RESOLUTION: dispute upheld (overturned) / rejected
  AWAITING_RESOLUTION --> RESOLVED: window over → finalize + settle YES/NO
  AWAITING_RESOLUTION --> CANCELLED: finalize CANCELLED → refunds
  OPEN --> CANCELLED: no trades yet → collateral returned
```

Rules enforced in `resolution.service.ts`:
- **Four-eyes:** the reviewer must be a different person from the proposer (also for disputes).
- **Dispute window** per market (`disputeHours`); only traders in that market may dispute.
- **Settle exactly once:** market row lock + `Settlement.marketId UNIQUE` + status check.
- **Cancellation** (`cancellationPolicy`): `REFUND_NET_COST` — each trader gets back
  max(0, Σbuys − Σsells) excl. fees (pro-rata if the pool can't cover); or `LAST_PRICE` — shares pay the
  pre-close price. Naive "refund what you paid" is wrong after resales; both policies are solvent.
- **Football:** trading closes at kickoff; finished matches with a regular-time score are auto-proposed and
  auto-confirmed (dispute window still applies); cancelled/abandoned/long-postponed or inconsistent data
  produce a proposal that **requires human review**.

## Data model (core)

```mermaid
erDiagram
  User ||--o{ Session : has
  User ||--o{ Account : owns
  User ||--o{ Position : holds
  User ||--o{ Trade : makes
  Market ||--o{ Trade : has
  Market ||--o{ Position : has
  Market ||--o{ PricePoint : history
  Market ||--o{ ResolutionProposal : resolution
  ResolutionProposal ||--o{ Dispute : disputes
  Market ||--o| Settlement : "settled once"
  Market }o--o| Fixture : "football"
  Account ||--o{ JournalLine : lines
  JournalEntry ||--o{ JournalLine : "sums to 0"
```

DB-level guarantees (see `prisma/migrations/*_init/migration.sql`): non-negative customer/escrow balances
and positions, balanced journal entries, append-only `JournalEntry`/`JournalLine`/`AuditLog`, price and
probability bounds.

## Real-time

Socket.IO rooms: `markets` (all public updates), `market:<id>`, `user:<id>` (joined from the session cookie).
Events are only emitted **after commit** and clients respond by re-fetching via SWR, so a dropped or
duplicated event can never show a wrong balance.

## Scaling path (when you need it)

1. Second API instance → add `@socket.io/redis-adapter` + a Redis throttler store.
2. Heavy jobs → move `SchedulerService.runAll` steps to BullMQ workers (they are already idempotent).
3. Read load → cache `/markets/home` for a few seconds (CDN or Redis).
4. Limit orders → new `Order` table matched against the AMM; the AMM/ledger code does not change.
