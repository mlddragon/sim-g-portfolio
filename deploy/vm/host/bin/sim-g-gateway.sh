#!/usr/bin/env bash
# The gateway (VM design sections 2 and 3): uid 1000, read-only, no
# capabilities and no published port. It joins its egress bridge (the only
# one allowed to reach the metadata server) and the internal bridge, where
# the nginx ingress reaches it at a fixed address and port (sim-g-edge.sh).
# The configuration document holds only references and handles, never
# secret values. The database is the local socket only: the gateway refuses
# any TCP URL here (owner decision 2026-10-27, Option A).
set -euo pipefail

config=/mnt/disks/data/sim-g/config/gateway.json
socket=/run/sim-g/postgresql

fail() { # reason [status]
  printf '{"severity":"ERROR","msg":"gateway_failed","reason":"%s"}\n' "$1"
  exit "${2:-1}"
}

# Status 3: the unit does not restart it every 5 seconds (neither cause can
# fix itself that fast); the recovery timer still starts it every 5 minutes
# (and stays paused during maintenance), so a missing document keeps paging
# without flooding the logs.
[[ ! -e /run/sim-g/maintenance ]] || fail maintenance_mode 3
[[ -f "${config}" ]] || fail gateway_config_missing 3

docker create --name sim-g-gateway --network sim-g-gateway-egress \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges --user 1000:1000 \
  --memory 384m --memory-swap 384m --pids-limit 256 --tmpfs /tmp:size=16m \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
  --env GATEWAY_CONFIG_PATH=/etc/sim-g/gateway.json --env PORT=8080 \
  --env GATEWAY_HOST=0.0.0.0 --env GATEWAY_TRUSTED_PROXY_HOPS=1 \
  --env GATEWAY_DATABASE_TRANSPORT=unix_socket \
  --volume "${config}:/etc/sim-g/gateway.json:ro" \
  --volume "${socket}:/run/postgresql:ro" \
  "${SIM_G_GATEWAY_IMAGE}" >/dev/null || fail gateway_create_failed
docker network connect --ip 172.31.250.2 sim-g-internal sim-g-gateway ||
  fail gateway_network_failed
# Attached so systemd tracks the container. Its output (the audit and
# telemetry lines on stdout, its warnings and errors on stderr) already goes
# to json-file for the logging agent, so none of it is copied into the
# journal, where the host log shipper would send it a second time. Docker's
# own start errors are discarded with it; the unit's failure still reaches
# the journal, and `docker start --attach sim-g-gateway` by hand shows why.
exec docker start --attach sim-g-gateway >/dev/null 2>&1
