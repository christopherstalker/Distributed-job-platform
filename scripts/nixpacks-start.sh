#!/usr/bin/env bash
set -euo pipefail

resolve_target() {
  local requested="${SERVICE_TARGET:-api}"

  case "${requested}" in
    dashboard|api|worker|scheduler)
      echo "${requested}"
      ;;
    *)
      echo "[nixpacks-start] ERROR: Unsupported SERVICE_TARGET='${requested}'" >&2
      echo "[nixpacks-start] Valid values: dashboard, api, worker, scheduler" >&2
      exit 1
      ;;
  esac
}

assert_binary_ready() {
  local binary_path="$1"

  if [[ ! -f "${binary_path}" ]]; then
    echo "[nixpacks-start] ERROR: Expected binary not found: ${binary_path}" >&2
    if [[ -d /app/bin ]]; then
      echo "[nixpacks-start] Available files in /app/bin:" >&2
      ls -la /app/bin >&2
    else
      echo "[nixpacks-start] Directory /app/bin does not exist." >&2
    fi
    exit 1
  fi

  if [[ ! -x "${binary_path}" ]]; then
    echo "[nixpacks-start] ERROR: Binary exists but is not executable: ${binary_path}" >&2
    exit 1
  fi
}

target="$(resolve_target)"

echo "[nixpacks-start] SERVICE_TARGET=${SERVICE_TARGET:-<unset>} resolved_target=${target}"

case "${target}" in
  dashboard)
    if [[ ! -d dashboard ]]; then
      echo "[nixpacks-start] ERROR: dashboard directory './dashboard' does not exist" >&2
      exit 1
    fi
    echo "[nixpacks-start] Launching dashboard preview server on 0.0.0.0:${PORT:-3000}"
    cd dashboard
    exec npm run preview -- --host 0.0.0.0 --port "${PORT:-3000}"
    ;;
  api|worker|scheduler)
    binary_path="/app/bin/${target}"
    echo "[nixpacks-start] Launching binary: ${binary_path}"
    assert_binary_ready "${binary_path}"
    exec "${binary_path}"
    ;;
esac
