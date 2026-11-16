#!/bin/sh
# Container entrypoint: the server by default, any ukb command when given args.
#
# `docker compose run --rm ukb ukb user add alice` has to be able to create the
# first account before the server binds 0.0.0.0 — otherwise the container exits
# with the "refusing to bind without accounts" message and there is no way to
# fix it from inside.
set -eu

UKB_DIR="${UKB_DIR:-/data}"
mkdir -p "$UKB_DIR/.ukb"

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

STORAGE="${UKB_STORAGE:-sqlite}"
set -- ukb-server \
  --dir "$UKB_DIR" \
  --host "${UKB_HOST:-0.0.0.0}" \
  --port "${UKB_PORT:-8787}" \
  --ui "${UKB_UI:-/app/web}" \
  --storage "$STORAGE"
if [ "$STORAGE" = "postgres" ] && [ -n "${UKB_PG_URL:-}" ]; then
  set -- "$@" --pg-url "$UKB_PG_URL"
fi
exec "$@"
