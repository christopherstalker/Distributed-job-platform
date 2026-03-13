#!/usr/bin/env bash
set -euo pipefail

readonly SERVICES=("api" "worker" "scheduler")

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

build_service() {
  local service="$1"
  validate_service_package "${service}"

  local output="/app/bin/${service}"
  echo "[nixpacks-build] Building ${service} -> ${output}"
  go build -ldflags="-w -s" -o "${output}" "./${service}"
}

echo "[nixpacks-build] SERVICE_TARGET=${SERVICE_TARGET:-<unset>} (build always outputs api/worker/scheduler binaries)"

go mod download
mkdir -p /app/bin

for service in "${SERVICES[@]}"; do
  build_service "${service}"
done

echo "[nixpacks-build] Build complete. Binaries available at /app/bin/{api,worker,scheduler}"
