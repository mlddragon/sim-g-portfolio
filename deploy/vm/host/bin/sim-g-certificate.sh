#!/usr/bin/env bash
# Obtains and renews the ingress certificate (VM design section 3), run by
# sim-g-certificate.timer twice a day. certbot answers the Let's Encrypt
# HTTP-01 challenge through the webroot that nginx serves on port 80, and
# renews only within 30 days of expiry (--keep-until-expiring).
#
# certbot runs as nginx's uid 101 (so nginx can read the key), read-only,
# with no capabilities, on the edge egress bridge, which the firewall keeps
# off the metadata server. Its state lives on the data disk.
#
# The owner accepts the Let's Encrypt Subscriber Agreement by setting
# SIM_G_ACME_TERMS=agreed in the host settings; without it nothing is
# requested. certbot's errors (--quiet prints only those) reach the unit's
# journal for diagnosis; they carry no key material. A first certificate
# restarts the ingress (bootstrap to serving); a renewal reloads it. A
# failure logs certificate_renewal_failed, which alerts (VM design section
# 11). The lineage is pinned to the host name (--cert-name), so a lost
# renewal configuration can never start a second lineage nginx ignores.
set -euo pipefail

certs=/mnt/disks/data/sim-g/edge/certs
acme=/run/sim-g/edge/acme

fail() {
  printf '{"severity":"ERROR","msg":"certificate_renewal_failed","reason":"%s"}\n' "$1"
  exit 1
}

fingerprint() { # domain
  local chain="${certs}/live/$1/fullchain.pem"
  if [[ -f "${chain}" ]]; then sha256sum <"${chain}" | cut -d' ' -f1; else echo none; fi
}

# Until the owner accepts the terms nothing is requested; this is a state,
# not a failure, so it does not page (the uptime check shows the ingress is
# not serving TLS).
if [[ "${SIM_G_ACME_TERMS:-}" != agreed ]]; then
  printf '{"severity":"WARNING","msg":"certificate_not_requested","reason":"acme_terms_not_accepted"}\n'
  exit 0
fi
[[ -n "${SIM_G_CERTBOT_IMAGE:-}" ]] || fail certbot_image_missing
domain="${SIM_G_DOMAIN:-}"
label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
[[ ${#domain} -le 253 && "${domain}" =~ ^(${label}\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]] ||
  fail invalid_domain
install -d -m 0755 -o 101 -g 101 "${acme}" "${certs}"

before="$(fingerprint "${domain}")"
docker run --rm --name sim-g-certbot --network sim-g-edge-egress \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges --user 101:101 \
  --memory 128m --memory-swap 128m --pids-limit 64 --tmpfs /tmp:size=32m,uid=101,gid=101 \
  --log-driver json-file --log-opt max-size=1m --log-opt max-file=2 \
  --env HOME=/tmp \
  --volume "${certs}:/etc/letsencrypt" \
  --volume "${acme}:/var/www/acme" \
  "${SIM_G_CERTBOT_IMAGE}" certonly --non-interactive --agree-tos \
  --register-unsafely-without-email --webroot --webroot-path /var/www/acme \
  --domain "${domain}" --cert-name "${domain}" --keep-until-expiring --key-type ecdsa \
  --config-dir /etc/letsencrypt --work-dir /tmp/work --logs-dir /tmp/logs --quiet \
  >/dev/null || fail certbot_failed
after="$(fingerprint "${domain}")"

if [[ "${after}" == none ]]; then
  fail certificate_missing
elif [[ "${before}" == none ]]; then
  # The first certificate: re-render the ingress with its TLS site.
  systemctl restart sim-g-edge.service || fail edge_restart_failed
  printf '{"severity":"INFO","msg":"certificate_issued"}\n'
elif [[ "${after}" != "${before}" ]]; then
  docker kill --signal HUP sim-g-edge >/dev/null || fail edge_reload_failed
  printf '{"severity":"INFO","msg":"certificate_renewed"}\n'
else
  printf '{"severity":"INFO","msg":"certificate_current"}\n'
fi
