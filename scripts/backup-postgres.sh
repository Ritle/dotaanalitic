#!/usr/bin/env bash
set -euo pipefail
# Run on the host where compose.production.yaml is deployed.
# Requires: .env.production, Docker, tar, chmod. Expects external backup path.
: "${BACKUP_DIR:?Set BACKUP_DIR to an off-host-mounted backup destination}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
TARGET="$BACKUP_DIR/dota2-$STAMP.sql.gz"
docker compose --env-file .env.production -f compose.production.yaml exec -T postgres \
  sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl' \
  | gzip -c > "$TARGET"
chmod 600 "$TARGET"
gzip -t "$TARGET"
echo "Backup generated: $TARGET (verify restore separately; do not keep only on same VPS)"
