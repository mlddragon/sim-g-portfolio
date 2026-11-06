#!/usr/bin/env bash
# Builds the gateway image, smoke-tests it under a hardened runtime, and scans
# the image, the infrastructure configuration and the locked dependencies with
# the pinned Trivy image. Fails on any fixable HIGH or CRITICAL finding.
set -euo pipefail

cd "$(dirname "$0")/.."

image="${1:-family-brain-gateway:check}"
trivy="aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa"

docker build --tag "${image}" .

# Without configuration the gateway must refuse to start with one fixed line,
# even with a read-only root filesystem, no capabilities and no network.
set +e
output="$(docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges --network=none "${image}" 2>&1)"
status=$?
set -e
expected='{"severity":"ERROR","msg":"startup_failed","reason":"gateway_config_path_required"}'
if [[ "${status}" != 1 || "${output}" != "${expected}" ]]; then
  echo "container smoke test failed (exit ${status})" >&2
  exit 1
fi
# The compiled migration command ships in the same image and fails closed
# without its connection URL.
set +e
output="$(docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges --network=none "${image}" node dist/migration-cli.js 2>&1)"
status=$?
set -e
expected='{"severity":"ERROR","msg":"migration_failed","reason":"migration_database_url_required"}'
if [[ "${status}" != 1 || "${output}" != "${expected}" ]]; then
  echo "migration command smoke test failed (exit ${status})" >&2
  exit 1
fi
if [[ "$(docker image inspect --format '{{.Config.User}}' "${image}")" != "1000:1000" ]]; then
  echo "container must run as 1000:1000" >&2
  exit 1
fi

docker volume create family-brain-trivy-cache >/dev/null
scan() {
  docker run --rm \
    --volume family-brain-trivy-cache:/root/.cache/trivy \
    --volume /var/run/docker.sock:/var/run/docker.sock:ro \
    --volume "${PWD}:/src:ro" \
    "${trivy}" "$@" --exit-code 1 --skip-version-check
}

scan image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --no-progress "${image}"

# The VM's PostgreSQL derivative (age plus the job users) is scanned the same way.
docker build --tag sim-g-postgres:check deploy/vm/postgres
scan image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --no-progress sim-g-postgres:check
# The ingress images: pinned upstream bases with security updates applied.
for name in nginx certbot; do
  docker build --quiet --file "deploy/vm/edge/${name}.Dockerfile" --tag "sim-g-${name}:check" deploy/vm/edge >/dev/null
  scan image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --no-progress "sim-g-${name}:check"
done
scan config --severity HIGH,CRITICAL /src
scan fs --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --no-progress \
  --skip-dirs /src/node_modules --skip-dirs /src/dist /src
