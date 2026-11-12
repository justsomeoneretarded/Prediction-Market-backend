# Operations: run, deploy, back up, restore

## Local development (one command)

Both repos side by side:

```bash
git clone https://github.com/justsomeoneretarded/Prediction-Market-backend prediction-market-backend
```

```bash
git clone https://github.com/justsomeoneretarded/Prediction-Market-frontend prediction-market-frontend
```

```bash
cd prediction-market-backend && pnpm dev:all
```

`dev:all` uses a local PostgreSQL on :5432 (or starts one with Docker), runs migrations, seeds demo data,
starts the API on :4000, waits until `/api/health` is OK, then starts the web app on :3000.

Demo logins (password `tinbit-demo-123`, change with `SEED_PASSWORD`): `admin`, `resolver`, `reviewer`, `alice`, `bob`.

## Docker Compose (single server)

```bash
cp .env.example .env
```

Edit `.env`: set `POSTGRES_PASSWORD`, `WEB_ORIGIN` (your public URL), `COOKIE_SECURE=true` behind HTTPS,
`DEMO_MODE=false` for anything public.

```bash
docker compose up -d --build
```

Startup order is enforced with health checks: `db` healthy → `api` (runs `prisma migrate deploy`, then
serves; healthy when `/api/health` passes) → `web`. Optional demo data:

```bash
docker compose exec api npm run db:seed
```

Put a TLS-terminating reverse proxy (Caddy, Nginx, Cloudflare) in front of port 3000. Only the web port
needs to be public — the API and DB are bound to 127.0.0.1.

### Suggested low-cost hosting

One small VPS (2 vCPU / 4 GB) runs the whole compose stack comfortably for thousands of users. Managed
Postgres (with point-in-time recovery) is the first upgrade worth paying for.

## Environment variables

See [`.env.example`](../.env.example). Never commit `.env`. Key production settings:
`DEMO_MODE=false`, `COOKIE_SECURE=true`, `ADMIN_REQUIRE_2FA=true`, `BLOCKED_COUNTRIES=…`,
`FOOTBALL_PROVIDER=api-football` + `API_FOOTBALL_KEY` (only once you have a licensed key).

## Backups

- **Automatic:** the compose `backup` service writes `backups/tinbit-YYYYmmdd-HHMMSS.sql.gz` daily and
  prunes files older than 14 days. Copy `backups/` off the server (e.g. `rclone` to object storage).
- **Manual:** `pnpm backup` (needs `pg_dump` and `DATABASE_URL`).

## Recovery procedure

1. Halt trading: stop the `api` container (`docker compose stop api web`).
2. Create an empty database (or a new volume).
3. Restore: `./scripts/restore.sh backups/tinbit-….sql.gz`
4. Start the API: `docker compose up -d api web` (migrations are no-ops on a restored DB).
5. Log in as admin → **Admin → System → Reconciliation** must show *balanced* (Σ balances = 0, no unbalanced
   entries, no drift, escrow ≥ worst payout for every market). Only then reopen to users.

This round trip was tested: dump → restore into a fresh DB → identical trade count, ledger sum 0,
zero unbalanced entries.

## Routine checks

- Admin overview: queues (proposals, disputes, withdrawals), current exposure vs. reserve.
- Reconciliation daily (also visible in Admin → System).
- `docker compose logs api | grep -i error`.
