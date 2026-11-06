#!/usr/bin/env bash
# Follows the deploy pointer (VM design section 10). Run by its timer through
# sim-g-host-env.sh, so the running image and this project come from the
# validated host settings.
#
#  1. Read gs://<project>-sim-g-deploy/family-brain-gateway/gateway.digest
#     with a metadata-server token, which reaches curl on stdin only.
#  2. Accept only a bare `sha256:<64 hex>` digest. The repository is always
#     the running image's, so the pointer can name a version but never a
#     different image.
#  3. Pull it and run its migrations (after a fresh backup) while the gateway
#     keeps running, and the host settings keep naming, the current image.
#  4. Only then record the new image, restart the gateway and wait for its
#     health check. If the restart fails or the gateway is unhealthy, restore
#     the previous image and restart again.
#
# A marker (deploy-pending) is written before the image is recorded. A run
# that finds it restarts the gateway onto whichever image the settings name,
# then keeps a healthy new image or rolls back an unhealthy one.
#
# A digest whose migrations or health failed is remembered and not retried
# until the pointer names another one. Failed pulls, failed backups, Docker
# daemon errors, a busy migration, a failed restart, maintenance and a stopped
# PostgreSQL are not the image's fault: they are retried or reported without
# rejecting it. Prints one JSON line when it acts (migrations add their own),
# and nothing when there is nothing to do.
set -euo pipefail
umask 077

file=/mnt/disks/data/sim-g/host.env
pending=/mnt/disks/data/sim-g/deploy-pending
rejected=/mnt/disks/data/sim-g/deploy-rejected
storage_base="${SIM_G_STORAGE_BASE:-https://storage.googleapis.com/storage/v1/b}"
token_url="${SIM_G_METADATA_TOKEN_URL:-http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token}"
attempts="${SIM_G_HEALTH_ATTEMPTS:-60}"
interval="${SIM_G_HEALTH_INTERVAL:-2}"

fail() { # reason [digest]
  printf '{"severity":"ERROR","msg":"deploy_failed","reason":"%s","digest":"%s"}\n' "$1" "${2:-}"
  exit 1
}

[[ ! -e /run/sim-g/maintenance ]] || exit 0
: "${SIM_G_GATEWAY_IMAGE:?}" "${SIM_G_PROJECT:?}"
current="${SIM_G_GATEWAY_IMAGE}"
repository="${current%@*}"

# The token may only go to Google or, for the offline check, loopback.
loopback='^http://127\.0\.0\.1:[0-9]{1,5}/'
[[ "${storage_base}" == https://storage.googleapis.com/storage/v1/b || "${storage_base}" =~ ${loopback} ]] ||
  fail deploy_endpoint_refused
[[ "${token_url}" == http://metadata.google.internal/* || "${token_url}" =~ ${loopback} ]] ||
  fail deploy_endpoint_refused

# Writes $2 to $1 atomically; mktemp creates it 0600, owned by root.
replace() {
  local staged
  staged="$(mktemp "$1.XXXXXX")" || return 1
  printf '%s' "$2" >"${staged}" && mv -f "${staged}" "$1"
}

# Names $1 as the gateway image. The settings file is replaced only when the
# rewrite produced exactly the expected line, so a failure never empties it.
set_image() {
  local content
  content="$(sed "s#^SIM_G_GATEWAY_IMAGE=.*#SIM_G_GATEWAY_IMAGE=$1#" "${file}")" || return 1
  grep -qxF "SIM_G_GATEWAY_IMAGE=$1" <<<"${content}" || return 1
  replace "${file}" "${content}"$'\n'
}

# Healthy means the running container is the expected image and reports
# healthy, so a stale container or its last health status never counts.
healthy() { # image
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    [[ "$(docker inspect --format '{{.State.Running}} {{.Config.Image}} {{.State.Health.Status}}' \
      sim-g-gateway 2>/dev/null)" == "true $1 healthy" ]] && return 0
    sleep "${interval}"
  done
  return 1
}

digest_of() { printf '%s' "${1##*@}"; }

roll_back() { # previous target reason [reject]
  set_image "$1" || fail deploy_settings_write_failed "$(digest_of "$2")"
  # Only the image's own failures reject it; maintenance started mid-run is
  # never held against it.
  if [[ "${4:-}" == reject && ! -e /run/sim-g/maintenance ]]; then
    replace "${rejected}" "$(digest_of "$2")"$'\n'
  fi
  if [[ ! -e /run/sim-g/maintenance ]]; then
    systemctl restart sim-g-gateway.service || fail deploy_rollback_unhealthy "$(digest_of "$2")"
    healthy "$1" || fail deploy_rollback_unhealthy "$(digest_of "$2")"
  fi
  rm -f "${pending}"
  fail "$3" "$(digest_of "$2")"
}

# Removes this repository's digest-pulled images other than the new one and
# the previous one (kept for rollback), so deploys never fill the boot disk's
# stateful partition. Other repositories (PostgreSQL) are never touched. It
# runs only after the deploy is complete, every Docker call is bounded, and a
# failed removal never fails the deploy. Prints one line when it acted.
prune() { # previous target
  local image removed=0 failed=0
  while IFS= read -r image; do
    [[ "${image%@*}" == "${repository}" && "${image}" != "$1" && "${image}" != "$2" ]] || continue
    if timeout 120 docker image rm "${image}" >/dev/null 2>&1; then
      removed=$((removed + 1))
    else
      failed=$((failed + 1))
    fi
  done < <(timeout 60 docker image ls --digests --format '{{.Repository}}@{{.Digest}}' \
    "${repository}" 2>/dev/null || true)
  if ((removed + failed > 0)); then
    printf '{"severity":"INFO","msg":"deploy_pruned","removed":%d,"failed":%d}\n' "${removed}" "${failed}"
  fi
}

finish() { # previous target
  if healthy "$2"; then
    rm -f "${pending}" "${rejected}"
    printf '{"severity":"INFO","msg":"deploy_completed","digest":"%s"}\n' "$(digest_of "$2")"
    prune "$1" "$2"
    exit 0
  fi
  roll_back "$1" "$2" deploy_rolled_back reject
}

# An interrupted run. The marker must name exactly two images of the running
# repository; anything else stops every run until an operator removes it.
if [[ -f "${pending}" ]]; then
  read -r previous target extra <"${pending}" || true
  pinned_digest='^sha256:[0-9a-f]{64}$'
  [[ -z "${extra:-}" && "${previous%@*}" == "${repository}" && "${target%@*}" == "${repository}" &&
    "${previous##*@}" =~ ${pinned_digest} && "${target##*@}" =~ ${pinned_digest} ]] ||
    fail deploy_pending_malformed
  if [[ "${current}" == "${target}" ]]; then
    # The new image was recorded, but the gateway may not have been
    # restarted onto it yet: restart, then judge it.
    systemctl restart sim-g-gateway.service ||
      roll_back "${previous}" "${target}" deploy_restart_failed
    finish "${previous}" "${target}"
  fi
  # Never switched: nothing ran on the new image; start again.
  rm -f "${pending}"
fi

systemctl is-active --quiet sim-g-postgres.service || exit 0

token="$(curl -sf --max-time 10 -H 'Metadata-Flavor: Google' "${token_url}" |
  sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')" || fail deploy_token_unavailable
[[ -n "${token}" ]] || fail deploy_token_unavailable
body="$(mktemp)"
trap 'rm -f "${body}"' EXIT
code="$(printf 'header = "Authorization: Bearer %s"\n' "${token}" |
  curl -s --max-time 10 --config - -o "${body}" -w '%{http_code}' \
    "${storage_base}/${SIM_G_PROJECT}-sim-g-deploy/o/family-brain-gateway%2Fgateway.digest?alt=media")" ||
  fail deploy_pointer_unavailable
unset token
case "${code}" in
  200) ;;
  404) exit 0 ;; # no pointer written yet
  *) fail "deploy_pointer_http_${code}" ;;
esac
pointer="$(<"${body}")"
[[ "${pointer}" =~ ^sha256:[0-9a-f]{64}$ ]] || fail deploy_pointer_malformed

target="${repository}@${pointer}"
[[ "${target}" != "${current}" ]] || exit 0
[[ ! -f "${rejected}" ]] || ! grep -qxF "${pointer}" "${rejected}" || exit 0

timeout 600 docker pull "${target}" >/dev/null || fail deploy_pull_failed "${pointer}"

set +e
SIM_G_GATEWAY_IMAGE="${target}" bash /etc/sim-g/bin/sim-g-migrate.sh
migrated=$?
set -e
[[ ! -e /run/sim-g/maintenance ]] || exit 0
case "${migrated}" in
  0) ;;
  3 | 4 | 5) fail deploy_migration_deferred "${pointer}" ;;
  *)
    replace "${rejected}" "${pointer}"$'\n'
    fail deploy_migration_failed "${pointer}"
    ;;
esac

replace "${pending}" "${current} ${target}"$'\n' || fail deploy_settings_write_failed "${pointer}"
if ! set_image "${target}"; then
  rm -f "${pending}"
  fail deploy_settings_write_failed "${pointer}"
fi
systemctl restart sim-g-gateway.service || roll_back "${current}" "${target}" deploy_restart_failed
finish "${current}" "${target}"
