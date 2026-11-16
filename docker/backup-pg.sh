#!/bin/sh
# Online backup of a Postgres-backed stack, run from the repository root.
#
# pg_dump runs inside the database container, so the database password never
# appears on this command line. The accounts file is copied from the board
# container's data volume.
set -eu

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$DIR"

docker compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$DIR/board-$STAMP.dump"

if docker compose exec -T ukb sh -c 'test -f /data/.ukb/accounts.json'; then
  docker compose exec -T ukb sh -c 'cat /data/.ukb/accounts.json' \
    > "$DIR/accounts-$STAMP.json"
fi

chmod 600 "$DIR"/board-*.dump "$DIR"/accounts-*.json 2>/dev/null || true
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
find "$DIR" -name 'board-*.dump' -type f -mtime "+$KEEP_DAYS" -delete
find "$DIR" -name 'accounts-*.json' -type f -mtime "+$KEEP_DAYS" -delete

echo "backup written: $DIR/board-$STAMP.dump"
