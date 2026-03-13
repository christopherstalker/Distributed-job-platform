#!/usr/bin/env bash
set -euo pipefail

target="${SERVICE_TARGET:-dashboard}"

echo "[nixpacks-build] SERVICE_TARGET=${target}"

case "${target}" in
  dashboard)
    cd dashboard
    npm ci
    npm run build
    ;;
  api)
    go mod download
    go build -ldflags="-w -s" -o /app/bin/api ./api
    ;;
  worker)
    go mod download
    go build -ldflags="-w -s" -o /app/bin/worker ./worker
    ;;
  scheduler)
    go mod download
    go build -ldflags="-w -s" -o /app/bin/scheduler ./scheduler
    ;;
  *)
    echo "Unsupported SERVICE_TARGET: ${target}" >&2
    echo "Expected one of: dashboard, api, worker, scheduler" >&2
    exit 1
    ;;
esac
