#!/usr/bin/env bash
set -euo pipefail

resolve_target() {
  local requested="${SERVICE_TARGET:-api}"

  case "${requested}" in
    api|worker|scheduler)
      echo "${requested}"
      ;;
    *)
      echo "[nixpacks-start] ERROR: Unsupported SERVICE_TARGET='${requested}'" >&2
      echo "[nixpacks-start] Valid values: api, worker, scheduler" >&2
      exit 1
      ;;
  esac
}

target="$(resolve_target)"
binary_path="/app/bin/${target}"

echo "[nixpacks-start] SERVICE_TARGET=${SERVICE_TARGET:-<unset>} resolved_target=${target}"
echo "[nixpacks-start] Launching binary: ${binary_path}"

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

exec "${binary_path}"
