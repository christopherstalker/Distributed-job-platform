#!/usr/bin/env bash
set -euo pipefail

readonly BACKEND_SERVICES=("api" "worker" "scheduler")

resolve_target() {
  local requested="${SERVICE_TARGET:-api}"
  case "${requested}" in
    dashboard|api|worker|scheduler)
      echo "${requested}"
      ;;
    *)
      echo "[nixpacks-build] ERROR: Unsupported SERVICE_TARGET='${requested}'" >&2
      echo "[nixpacks-build] Valid values: dashboard, api, worker, scheduler" >&2
      exit 1
      ;;
  esac
}

validate_service_package() {
  local service="$1"

  if [[ ! -d "${service}" ]]; then
    echo "[nixpacks-build] ERROR: service directory './${service}' does not exist" >&2
    exit 1
  fi

  local package_name
  package_name="$(go list -f '{{.Name}}' "./${service}")"
  if [[ "${package_name}" != "main" ]]; then
    echo "[nixpacks-build] ERROR: './${service}' is not a main package (found: ${package_name})" >&2
    exit 1
  fi
}

build_backend_service() {
  local service="$1"
  validate_service_package "${service}"

  local output="/app/bin/${service}"
  echo "[nixpacks-build] Building ${service} -> ${output}"
  go build -ldflags="-w -s" -o "${output}" "./${service}"
}

build_dashboard() {
  if [[ ! -d dashboard ]]; then
    echo "[nixpacks-build] ERROR: dashboard directory './dashboard' does not exist" >&2
    exit 1
  fi

  local api_base_url="${VITE_API_BASE_URL:-${NEXT_PUBLIC_API_URL:-${API_BASE_URL:-}}}"
  if [[ -z "${api_base_url}" ]]; then
    echo "[nixpacks-build] ERROR: Dashboard target requires VITE_API_BASE_URL (or NEXT_PUBLIC_API_URL/API_BASE_URL)." >&2
    echo "[nixpacks-build] Refusing to build a dashboard that would default to same-origin API calls and return 404 in split deployments." >&2
    exit 1
  fi

  if [[ ! "${api_base_url}" =~ ^https?:// ]]; then
    echo "[nixpacks-build] ERROR: VITE_API_BASE_URL must be an absolute http(s) URL (received: '${api_base_url}')" >&2
    exit 1
  fi

  echo "[nixpacks-build] Building dashboard assets with VITE_API_BASE_URL=${api_base_url}"
  (
    cd dashboard
    VITE_API_BASE_URL="${api_base_url}" npm ci
    VITE_API_BASE_URL="${api_base_url}" npm run build
  )
}

target="$(resolve_target)"
echo "[nixpacks-build] SERVICE_TARGET=${SERVICE_TARGET:-<unset>} resolved_target=${target}"

case "${target}" in
  dashboard)
    build_dashboard
    ;;
  api|worker|scheduler)
    go mod download
    mkdir -p /app/bin
    for service in "${BACKEND_SERVICES[@]}"; do
      build_backend_service "${service}"
    done
    echo "[nixpacks-build] Build complete. Binaries available at /app/bin/{api,worker,scheduler}"
    ;;
esac
