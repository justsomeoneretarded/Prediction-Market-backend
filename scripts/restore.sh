#!/bin/sh
# Restore INTO AN EMPTY DATABASE:  ./scripts/restore.sh backups/tinbit-....sql.gz
# Afterwards run reconciliation (Admin → System) before reopening trading.
set -e
[ -f .env ] && . ./.env
: "${DATABASE_URL:?DATABASE_URL must be set}"
[ -f "$1" ] || { echo "usage: $0 <backup.sql.gz>"; exit 1; }
gunzip -c "$1" | psql "${DATABASE_URL%%\?*}" -v ON_ERROR_STOP=1 -q
echo "Restored $1"
