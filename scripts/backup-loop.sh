#!/bin/sh
# Used by the compose `backup` service: one pg_dump per day, keep 14 days.
while true; do
  f="/backups/tinbit-$(date +%Y%m%d-%H%M%S).sql.gz"
  if pg_dump -h db -d tinbit --no-owner | gzip > "$f"; then echo "backup written: $f"; else echo "backup FAILED"; fi
  find /backups -name 'tinbit-*.sql.gz' -type f -mtime +14 -delete
  sleep 86400
done
