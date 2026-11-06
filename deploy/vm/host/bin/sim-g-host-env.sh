#!/usr/bin/env bash
# Usage: sim-g-host-env.sh <script> [args...]
#
# Reads the host settings file itself (systemd never loads it), validates it,
# configures Artifact Registry pulls, then runs <script> with exactly the
# validated settings exported. The file holds no secrets:
#   - four images (gateway, PostgreSQL, nginx, certbot), pinned by digest in
#     this project's Artifact Registry;
#   - this project's backup bucket;
#   - the owner's public age recipient;
#   - the ingress host name, and SIM_G_ACME_TERMS=agreed once the owner
#     accepts the Let's Encrypt Subscriber Agreement (optional until then).
# The recent-tier backup bucket is derived from the project, never read.
# Only root may write it, it may set nothing else, and its values are never
# evaluated, so it cannot inject variables such as LD_PRELOAD or BASH_ENV.
set -euo pipefail

file=/mnt/disks/data/sim-g/host.env
keys=(SIM_G_GATEWAY_IMAGE SIM_G_POSTGRES_IMAGE SIM_G_EDGE_IMAGE SIM_G_CERTBOT_IMAGE
  SIM_G_BACKUP_BUCKET SIM_G_BACKUP_RECIPIENT SIM_G_DOMAIN SIM_G_ACME_TERMS)
metadata=http://metadata.google.internal/computeMetadata/v1/project/project-id

fail() {
  printf '{"severity":"ERROR","msg":"host_env_failed","reason":"%s"}\n' "$1"
  exit 1
}

[[ $# -ge 1 && -f "$1" ]] || fail host_env_no_command
[[ -f "${file}" && ! -L "${file}" ]] || fail host_env_missing
read -r owner mode < <(stat -c '%u %a' "${file}")
[[ "${owner}" == 0 && $((8#${mode} & 8#022)) -eq 0 ]] || fail host_env_insecure

# Unquoted KEY=value lines; values use only the characters that image
# references, bucket names and age recipients need.
line_pattern='^([A-Z_]+)=([A-Za-z0-9@:/._-]+)$'
declare -A values=()
while IFS= read -r line || [[ -n "${line}" ]]; do
  [[ -z "${line}" || "${line}" == \#* ]] && continue
  [[ "${line}" =~ ${line_pattern} ]] || fail host_env_malformed
  key="${BASH_REMATCH[1]}"
  [[ " ${keys[*]} " == *" ${key} "* ]] || fail host_env_unexpected_key
  [[ -z "${values[${key}]:-}" ]] || fail host_env_duplicate_key
  values["${key}"]="${BASH_REMATCH[2]}"
done <"${file}"

project="$(curl -sf --max-time 5 -H 'Metadata-Flavor: Google' "${metadata}")" ||
  fail metadata_project_unavailable
[[ "${project}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail metadata_project_unavailable

# This project's Artifact Registry, by digest only (promotion never rebuilds).
pinned="^([a-z0-9-]+-docker\\.pkg\\.dev)/${project}/[a-z0-9._/-]+@sha256:[0-9a-f]{64}\$"
[[ "${values[SIM_G_GATEWAY_IMAGE]:-}" =~ ${pinned} ]] || fail gateway_image_not_pinned
gateway_registry="${BASH_REMATCH[1]}"
[[ "${values[SIM_G_POSTGRES_IMAGE]:-}" =~ ${pinned} ]] || fail postgres_image_not_pinned
postgres_registry="${BASH_REMATCH[1]}"
# The ingress settings are checked when present; only the ingress units
# require them (an ingress typo must not stop PostgreSQL or the backups).
edge_registry=""
certbot_registry=""
if [[ -n "${values[SIM_G_EDGE_IMAGE]:-}" ]]; then
  [[ "${values[SIM_G_EDGE_IMAGE]}" =~ ${pinned} ]] || fail edge_image_not_pinned
  edge_registry="${BASH_REMATCH[1]}"
fi
if [[ -n "${values[SIM_G_CERTBOT_IMAGE]:-}" ]]; then
  [[ "${values[SIM_G_CERTBOT_IMAGE]}" =~ ${pinned} ]] || fail certbot_image_not_pinned
  certbot_registry="${BASH_REMATCH[1]}"
fi
[[ "${values[SIM_G_BACKUP_BUCKET]:-}" == "${project}-sim-g-backups" ]] || fail invalid_backup_bucket
[[ "${values[SIM_G_BACKUP_RECIPIENT]:-}" =~ ^age1[0-9a-z]{58}$ ]] || fail invalid_backup_recipient
label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
domain="${values[SIM_G_DOMAIN]:-}"
[[ -z "${domain}" ]] ||
  [[ ${#domain} -le 253 && "${domain}" =~ ^(${label}\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]] ||
  fail invalid_domain
[[ -z "${values[SIM_G_ACME_TERMS]:-}" || "${values[SIM_G_ACME_TERMS]}" == agreed ]] ||
  fail invalid_acme_terms

# COS's root home is read-only; docker keeps its credential-helper
# configuration here instead.
export HOME=/var/lib/sim-g/home
install -d -m 0700 -o 0 -g 0 "${HOME}"
registries="${gateway_registry}"
for registry in "${postgres_registry}" "${edge_registry}" "${certbot_registry}"; do
  [[ -z "${registry}" || ",${registries}," == *",${registry},"* ]] || registries+=",${registry}"
done
# Written once: units start together, and the helper rewrites the file in
# place, so a concurrent reader could see it half-written.
configured=true
for registry in ${registries//,/ }; do
  grep -qE "\"${registry//./\\.}\"[[:space:]]*:[[:space:]]*\"gcr\"" "${HOME}/.docker/config.json" 2>/dev/null ||
    configured=false
done
if [[ "${configured}" == false ]]; then
  docker-credential-gcr configure-docker --registries="${registries}" >/dev/null 2>&1 ||
    fail registry_auth_failed
fi

for key in "${keys[@]}"; do export "${key}=${values[${key}]:-}"; done
export SIM_G_PROJECT="${project}"
export SIM_G_RECENT_BACKUP_BUCKET="${project}-sim-g-recent-backups"
exec /bin/bash "$@"
