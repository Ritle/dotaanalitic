#!/usr/bin/env bash
set -euo pipefail
# DESTRUCTIVE if target database has existing objects. Use an isolated staging database first.
: "${1:?Usage: ./scripts/restore-postgres.sh path/to/backup.sql.gz}"
: "${RESTORE_ACK:?Set RESTORE_ACK=RESTORE_TO_STAGING_ONLY and point compose env at isolated staging DB}"
if [[ "$RESTORE_ACK" != 'RESTORE_TO_STAGING_ONLY' ]]; then echo 'Refusing unsafe restore'; exit 1; fi
gzip -t "$1"
gzip -dc "$1" | docker compose --env-file .env.production -f compose.production.yaml exec -T postgres \
  sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
