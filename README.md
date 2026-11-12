# Tinbit API · ትንቢት

Prediction-market backend for Ethiopian and international events — football (Ethiopian Premier League,
EPL, Champions League, internationals), music, TV and culture. Users trade YES/NO shares priced by an
**LMSR automated market maker**, using **virtual birr only** (no real money).

Frontend: [Prediction-Market-frontend](https://github.com/justsomeoneretarded/Prediction-Market-frontend).

## Quick start

```bash
pnpm dev:all
```

(needs Node 22, pnpm, and either PostgreSQL on :5432 or Docker — see [docs/OPERATIONS.md](docs/OPERATIONS.md))
Then open http://localhost:3000 and log in as `admin` / `tinbit-demo-123`.

## Docs

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System, modules, money flow, trade sequence, lifecycle, data model (diagrams) |
| [docs/graph/CODEMAP.md](docs/graph/CODEMAP.md) | Auto-generated file/module graph (`pnpm codemap`) |
| [docs/LMSR.md](docs/LMSR.md) | Pricing math, rounding, the 1,000 / 20 birr scenario, choosing `b` |
| [docs/API.md](docs/API.md) | REST + WebSocket reference, roles & permissions |
| [docs/SECURITY.md](docs/SECURITY.md) | Controls implemented, known limitations, auditor checklist |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Dev, Docker deploy, env vars, backups & recovery |
| [docs/CHECKLIST.md](docs/CHECKLIST.md) | Feature checklist & status |

## Commands

| | |
|---|---|
| `pnpm dev` | API in watch mode (:4000) |
| `pnpm dev:all` | DB + migrate + seed + API + web |
| `pnpm test` | unit + integration tests (uses database `tinbit_test`) |
| `pnpm scenario` | prints the critical 1,000 YES / 20 NO scenario from the pricing engine |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` | database |
| `pnpm codemap` | regenerate `docs/graph/` |
| `pnpm backup` | `pg_dump` to `backups/` |
| `docker compose up -d --build` | full stack (db, api, web, daily backups) |

## Stack

NestJS 11 · Prisma 6 · PostgreSQL 16 · Socket.IO · decimal.js · Zod · Argon2 · Jest — modular monolith,
no Redis/queues needed at this size (see the scaling note in ARCHITECTURE.md).

> Demo markets and football fixtures in the seed are **invented and labelled "Demo"**. Real-money payments
> are disabled; enabling them requires licensing and independent security and financial review.
