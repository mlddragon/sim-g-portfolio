#!/usr/bin/env bash
# The ingress (VM design sections 3 and 4): nginx, the only published
# service, with request limits before the gateway. It runs as uid 101 with a
# read-only root, no capabilities and no new privileges. It joins
# sim-g-edge-egress, whose bridge the firewall keeps off the metadata server,
# for its published ports 443 and 80, and sim-g-internal to reach the
# gateway at its fixed address.
#
# The configuration is rendered from the shipped templates with the
# validated host name. Until the certificate exists (sim-g-certificate.sh)
# only port 80 answers, for validation and redirects, and 443 refuses every
# handshake; the certificate script restarts this unit once it has one.
set -euo pipefail

templates=/etc/sim-g/edge
conf=/run/sim-g/edge/conf
certs=/mnt/disks/data/sim-g/edge/certs
acme=/run/sim-g/edge/acme
# The gateway's fixed address on sim-g-internal (sim-g-gateway.sh) and its
# fixed port.
upstream=172.31.250.2:8080

fail() {
  printf '{"severity":"ERROR","msg":"edge_failed","reason":"%s"}\n' "$1"
  exit 1
}

# A lowercase DNS name of at least two labels, at most 253 characters.
valid_domain() { # name
  local label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
  [[ ${#1} -le 253 && "$1" =~ ^(${label}\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]]
}

# Writes nginx.conf and site.conf into <out>; prints "serving" or
# "bootstrap". The site is included only when both certificate files exist.
render_edge() { # templates domain upstream certs out
  local source="$1" domain="$2" address="$3" certificates="$4" out="$5"
  valid_domain "${domain}" || return 1
  [[ "${address}" =~ ^[0-9.]+:[0-9]+$ ]] || return 1
  sed -e "s/@DOMAIN@/${domain}/g" -e "s/@UPSTREAM@/${address}/g" \
    "${source}/nginx.conf" >"${out}/nginx.conf"
  if [[ -f "${certificates}/live/${domain}/fullchain.pem" &&
    -f "${certificates}/live/${domain}/privkey.pem" ]]; then
    sed -e "s/@DOMAIN@/${domain}/g" "${source}/site.conf" >"${out}/site.conf"
    echo serving
  else
    : >"${out}/site.conf"
    echo bootstrap
  fi
}

main() {
  [[ -n "${SIM_G_EDGE_IMAGE:-}" ]] || fail edge_image_missing
  valid_domain "${SIM_G_DOMAIN:-}" || fail invalid_domain
  install -d -m 0755 -o 0 -g 0 "${conf}"
  # Only the certificates reach nginx, never certbot's ACME account key.
  install -d -m 0755 -o 101 -g 101 "${acme}" "${certs}" "${certs}/live" "${certs}/archive"
  mode="$(render_edge "${templates}" "${SIM_G_DOMAIN}" "${upstream}" "${certs}" "${conf}")" ||
    fail edge_render_failed

  docker create --name sim-g-edge --network sim-g-edge-egress \
    --publish 443:8443 --publish 80:8080 \
    --read-only --cap-drop=ALL --security-opt=no-new-privileges --user 101:101 \
    --memory 96m --memory-swap 96m --pids-limit 64 --tmpfs /tmp:size=16m,uid=101,gid=101 \
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
    --volume "${conf}:/etc/nginx/sim-g:ro" \
    --volume "${certs}/live:/etc/sim-g/certs/live:ro" \
    --volume "${certs}/archive:/etc/sim-g/certs/archive:ro" \
    --volume "${acme}:/var/www/acme:ro" \
    --entrypoint nginx \
    "${SIM_G_EDGE_IMAGE}" -c /etc/nginx/sim-g/nginx.conf -g 'daemon off;' >/dev/null ||
    fail edge_create_failed
  # A fixed address of its own, so it can never take the gateway's.
  docker network connect --ip 172.31.250.3 sim-g-internal sim-g-edge || fail edge_network_failed
  printf '{"severity":"INFO","msg":"edge_starting","mode":"%s"}\n' "${mode}"
  exec docker start --attach sim-g-edge >/dev/null
}

# Sourcing defines the functions only (the offline checks render with them).
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
