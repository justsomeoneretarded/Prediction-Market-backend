#!/bin/sh
# One command for local development: database → migrations → demo seed → API → web.
#   ./scripts/dev-all.sh
# Uses PostgreSQL on localhost:5432 if one is running, otherwise starts the compose `db` service.
set -e
cd "$(dirname "$0")/.."
WEB_DIR="${WEB_DIR:-../prediction-market-frontend}"
[ -f .env ] || cp .env.example .env
[ -f "$WEB_DIR/.env" ] || cp "$WEB_DIR/.env.example" "$WEB_DIR/.env" 2>/dev/null || true

if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  echo "▶ starting PostgreSQL via docker compose"
  POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres docker compose up -d db
  until pg_isready -h localhost -p 5432 >/dev/null 2>&1; do sleep 1; done
fi

echo "▶ installing dependencies"
pnpm install --silent
(cd "$WEB_DIR" && pnpm install --silent)

echo "▶ creating database, migrating, seeding demo data"
psql "${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/postgres}" -c 'CREATE DATABASE tinbit' >/dev/null 2>&1 || true
pnpm exec prisma migrate deploy
pnpm db:seed

echo "▶ starting API on :4000"
sh scripts/dev.sh &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT INT TERM
until curl -sf http://localhost:4000/api/health >/dev/null; do sleep 1; done   # web only starts once the API is healthy
echo "✔ API healthy — starting web on :3000"
cd "$WEB_DIR" && pnpm dev
