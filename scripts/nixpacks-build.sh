#!/usr/bin/env bash
set -euo pipefail

resolve_target() {
  if [[ -n "${SERVICE_TARGET:-}" ]]; then
    echo "${SERVICE_TARGET}"
    return
  fi

  if [[ -f /app/bin/api ]]; then
    echo "api"
    return
  fi
  if [[ -f /app/bin/worker ]]; then
    echo "worker"
    return
  fi
  if [[ -f /app/bin/scheduler ]]; then
    echo "scheduler"
    return
  fi

  if command -v npm >/dev/null 2>&1; then
    echo "dashboard"
    return
  fi

  echo "api"
}

target="$(resolve_target)"

echo "[nixpacks-build] SERVICE_TARGET=${SERVICE_TARGET:-<unset>} resolved_target=${target}"

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
