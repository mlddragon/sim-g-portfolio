#!/usr/bin/env bash
# The three Docker bridges (VM design sections 2 and 4). Each has a fixed
# subnet and a fixed Linux bridge name, which the firewall matches on, and
# the VPC's 1460-byte MTU. An existing network must match exactly: subnet,
# internal flag, IPv6 off, bridge name and MTU. Prints one JSON line.
set -euo pipefail

mtu=1460

fail() {
  printf '{"severity":"ERROR","msg":"networks_failed","reason":"%s"}\n' "$1"
  exit 1
}

ensure() { # name subnet internal bridge
  local name="$1" subnet="$2" internal="$3" bridge="$4" actual
  if actual="$(docker network inspect --format \
    '{{range .IPAM.Config}}{{.Subnet}}{{end}} {{.Internal}} {{.EnableIPv6}} {{index .Options "com.docker.network.bridge.name"}} {{index .Options "com.docker.network.driver.mtu"}}' \
    "${name}" 2>/dev/null)"; then
    [[ "${actual}" == "${subnet} ${internal} false ${bridge} ${mtu}" ]] || fail "network_mismatch_${name}"
    return
  fi
  local flags=(--driver bridge --subnet "${subnet}"
    --opt "com.docker.network.bridge.name=${bridge}"
    --opt "com.docker.network.driver.mtu=${mtu}")
  if [[ "${internal}" == true ]]; then flags+=(--internal); fi
  docker network create "${flags[@]}" "${name}" >/dev/null || fail "network_create_failed_${name}"
}

# nginx to the gateway only; no egress at all.
ensure sim-g-internal 172.31.250.0/28 true sim-g-int0
# The only container network allowed to reach the metadata server.
ensure sim-g-gateway-egress 172.31.250.16/28 false sim-g-gw0
# nginx's published ports and certbot's ACME egress.
ensure sim-g-edge-egress 172.31.250.32/28 false sim-g-edge0
printf '{"severity":"INFO","msg":"networks_ready"}\n'
