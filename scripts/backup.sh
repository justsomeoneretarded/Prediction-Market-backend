#!/bin/sh
# Manual backup:  ./scripts/backup.sh   → backups/tinbit-YYYYmmdd-HHMMSS.sql.gz
set -e
[ -f .env ] && . ./.env
: "${DATABASE_URL:?DATABASE_URL must be set}"
mkdir -p backups
f="backups/tinbit-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dump "${DATABASE_URL%%\?*}" --no-owner | gzip > "$f"
echo "Wrote $f"
