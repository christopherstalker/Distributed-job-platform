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
echo "[nixpacks-start] SERVICE_TARGET=${SERVICE_TARGET:-<unset>} resolved_target=${target}"

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
