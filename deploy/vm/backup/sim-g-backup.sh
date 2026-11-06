#!/usr/bin/env bash
# Encrypted logical backup on the e2-micro VM (design section 8).
# Usage: sim-g-backup.sh [daily|recent]
#
# Two tiers share one mechanism (recovery point investigation, section 5):
#  - daily (the default): the 35-day bucket; its output is unchanged;
#  - recent: every 15 minutes, to the separate 3-day bucket. Its lines carry
#    "tier":"recent", and a success records its completion time on the host
#    for the staleness check.
#
#  1. pg_dump runs as the backup role (uid 9001, peer authentication) over the
#     local socket, in a container with no network.
#  2. age encrypts the dump to the owner-held public key, in a container with
#     no network. The private key never exists on the VM.
#  3. The host uploads the ciphertext to Cloud Storage with a metadata-server
#     token. ifGenerationMatch=0 refuses to overwrite an existing object, and
#     the runtime identity can only create objects there.
#
# Prints one JSON line. Never prints the token, the recipient or a cause.
set -euo pipefail
umask 077

# An empty argument is not "daily": it fails like any other unknown tier.
tier="${1-daily}"
tier_field=""
case "$#:${tier}" in
  0:daily | 1:daily) ;;
  1:recent) tier_field=',"tier":"recent"' ;;
  *)
    printf '{"severity":"ERROR","msg":"backup_failed","reason":"invalid_backup_tier"}\n'
    exit 1
    ;;
esac

: "${SIM_G_BACKUP_BUCKET:?}" "${SIM_G_BACKUP_RECIPIENT:?}" "${SIM_G_POSTGRES_IMAGE:?}"
socket_dir="${SIM_G_SOCKET_DIR:-/run/sim-g/postgresql}"
staging_dir="${SIM_G_BACKUP_STAGING:-/mnt/disks/data/backup-staging}"
database="${SIM_G_DATABASE:-family_brain_gateway}"
upload_base="${SIM_G_STORAGE_UPLOAD_BASE:-https://storage.googleapis.com/upload/storage/v1/b}"
token_url="${SIM_G_METADATA_TOKEN_URL:-http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token}"
marker="${SIM_G_BACKUP_MARKER:-/var/lib/sim-g/backup-recent.last}"

fail() {
  printf '{"severity":"ERROR","msg":"backup_failed"%s,"reason":"%s"}\n' "${tier_field}" "$1"
  exit 1
}

bucket="${SIM_G_BACKUP_BUCKET}"
if [[ "${tier}" == recent ]]; then
  bucket="${SIM_G_RECENT_BACKUP_BUCKET:-}"
  # Fifteen-minute dumps never land in the 35-day bucket.
  [[ "${bucket}" != "${SIM_G_BACKUP_BUCKET}" ]] || fail invalid_backup_bucket
fi
[[ "${SIM_G_BACKUP_RECIPIENT}" =~ ^age1[0-9a-z]{58}$ ]] || fail invalid_backup_recipient
[[ "${bucket}" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]] || fail invalid_backup_bucket
[[ "${SIM_G_POSTGRES_IMAGE}" =~ (^sha256:|@sha256:)[0-9a-f]{64}$ ]] || fail backup_image_not_pinned
# The real token may only go to Google or, for the synthetic check, loopback.
loopback='^http://127\.0\.0\.1:[0-9]{1,5}/'
[[ "${upload_base}" == https://storage.googleapis.com/upload/storage/v1/b || "${upload_base}" =~ ${loopback} ]] ||
  fail backup_endpoint_refused
[[ "${token_url}" == http://metadata.google.internal/* || "${token_url}" =~ ${loopback} ]] ||
  fail backup_endpoint_refused

mkdir -p "${staging_dir}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
object="family-brain-gateway/${stamp:0:4}/${stamp:4:2}/${stamp:6:2}/${stamp}.dump.age"
staged="$(mktemp "${staging_dir}/${stamp}.XXXXXX")" || fail backup_staging_failed
marker_tmp=""
cleanup() {
  rm -f "${staged}"
  [[ -z "${marker_tmp}" ]] || rm -f "${marker_tmp}"
}
trap cleanup EXIT

# No log driver: Docker records a container's stdout even when it is piped,
# and these streams are the plaintext dump and its ciphertext.
job=(docker run --rm --network none --read-only --cap-drop=ALL
  --security-opt=no-new-privileges --user 9001:9001
  --memory 256m --memory-swap 256m --pids-limit 64 --log-driver none)

# A failure anywhere in the pipeline fails the backup (pipefail).
if ! "${job[@]}" -v "${socket_dir}:/run/postgresql" "${SIM_G_POSTGRES_IMAGE}" \
  pg_dump --host=/run/postgresql --username=gateway_backup --format=custom \
  --no-password "${database}" 2>/dev/null |
  "${job[@]}" -i "${SIM_G_POSTGRES_IMAGE}" age --encrypt \
  --recipient "${SIM_G_BACKUP_RECIPIENT}" >"${staged}" 2>/dev/null; then
  fail backup_dump_failed
fi
# age always writes its header, so check it rather than the size alone.
[[ "$(head -c 21 "${staged}")" == "age-encryption.org/v1" ]] || fail backup_not_encrypted
bytes="$(wc -c <"${staged}" | tr -d ' ')"

token="$(curl -sf --max-time 10 -H 'Metadata-Flavor: Google' "${token_url}" |
  sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')" || fail backup_token_unavailable
[[ -n "${token}" ]] || fail backup_token_unavailable

encoded="$(printf '%s' "${object}" | sed 's#/#%2F#g')"
# The header travels on stdin (printf is a builtin), never in process arguments.
status="$(printf 'header = "Authorization: Bearer %s"\n' "${token}" |
  curl -s --max-time 120 --config - -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/octet-stream' \
  --data-binary "@${staged}" \
  "${upload_base}/${bucket}/o?uploadType=media&ifGenerationMatch=0&name=${encoded}" || true)"
unset token
[[ "${status}" == 200 ]] || fail "backup_upload_http_${status:-000}"

# The staleness check reads this; written atomically, only after an upload.
if [[ "${tier}" == recent ]]; then
  # Only ever replaces a regular file, never a directory or a symlink, and
  # writes through a freshly created temporary name (mktemp: exclusive, so
  # a planted name or link is never followed).
  { [[ ! -L "${marker}" && (! -e "${marker}" || -f "${marker}") ]] &&
    mkdir -p "$(dirname "${marker}")" &&
    marker_tmp="$(mktemp "${marker}.XXXXXX")" &&
    date -u +%s >"${marker_tmp}" &&
    mv -f "${marker_tmp}" "${marker}" &&
    marker_tmp=""; } 2>/dev/null || fail backup_marker_failed
fi

printf '{"severity":"INFO","msg":"backup_completed"%s,"object":"%s","bytes":%s}\n' \
  "${tier_field}" "${object}" "${bytes}"
