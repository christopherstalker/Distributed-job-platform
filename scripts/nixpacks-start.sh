#!/usr/bin/env bash
set -euo pipefail

target="${SERVICE_TARGET:-dashboard}"

case "${target}" in
  dashboard)
    cd dashboard
    exec npm run preview -- --host 0.0.0.0 --port "${PORT:-3000}"
    ;;
  api)
    exec /app/bin/api
    ;;
  worker)
    exec /app/bin/worker
    ;;
  scheduler)
    exec /app/bin/scheduler
    ;;
  *)
    echo "Unsupported SERVICE_TARGET: ${target}" >&2
    exit 1
    ;;
esac
