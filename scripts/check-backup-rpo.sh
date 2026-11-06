#!/usr/bin/env bash
# Synthetic 15-minute recovery test (recovery point investigation, section
# 12), in scaled time: an interval of SIM_G_RPO_INTERVAL seconds (default 15)
# stands in for the recent tier's 15 minutes. Local containers and fictional
# data only; nothing leaves this machine.
#
# It proves that after a complete loss of the database, recovery returns
# every change committed more than one interval (plus 10 % and a backup's
# run time) before the failure, using the production tooling:
#   1. a socket-only server, the production roles and migrations;
#   2. household-like operations and a heartbeat committed every second,
#      both through the runtime role. Commit times and counts come from the
#      server, never from the client;
#   3. the real sim-g-backup.sh recent every interval, against the local
#      Cloud Storage stand-in (an object's file time is its timeCreated). Each
#      run's object comes from its own backup_completed line;
#   4. a kill at a random moment from the end of the fourth run until just
#      after the fifth run has started (which may be killed mid-run), and the
#      data volume deleted (a lost data disk);
#   5. recovery as the production procedure will (docs/runbooks/
#      backup-and-restore.md): the newest object by creation time, isolated
#      validation (sim-g-restore-check.sh) against the previous accepted
#      summary, only undecryptable junk falling back; a private copy of that
#      exact file restored by hash as gateway_migrator; the migration job's
#      grants; the production re-check against a reference, fail-closed;
#      migrations with nothing to apply; then the runtime password and a
#      runtime write;
#   6. the bound, from the heartbeat and operations the restored copy holds.
# Then the negative cases: a corrupted newest object falls back to the
# previous one (two intervals), a planted far-future name is never chosen,
# and no usable object stops recovery with an explicit error, starting
# nothing.
#
# Not modelled (docs/implementation/STATUS.md, R4b rulings): reconciliation
# and the owner's acknowledgement (in production the gateway stays stopped
# until then); the gateway's own health check, which waits for the VM
# database transport (draft PR #79); the staleness thresholds, which
# pnpm host:check covers at real scale. The planted-object, identity-binding
# and older-ledger cases of section 12 are R4a's (scripts/backup-check).
set -euo pipefail

cd "$(dirname "$0")/.."

gateway_image="${1:-family-brain-gateway:check}"
interval="${SIM_G_RPO_INTERVAL:-15}"
[[ "${interval}" =~ ^[1-9][0-9]*$ && "${interval}" -ge 6 ]] || { echo "SIM_G_RPO_INTERVAL must be at least 6" >&2; exit 1; }
# Under $HOME: Colima bind-mounts only the home directory into its VM.
mkdir -p "${HOME}/.cache/sim-g-rpo-check"
work="$(mktemp -d "${HOME}/.cache/sim-g-rpo-check/run.XXXXXX")"
chmod 700 "${work}"
mkdir -p "${work}/uploads" "${work}/staging"
db=sim-g-rpo-db
restored=sim-g-rpo-restored
socket=sim-g-rpo-socket
data=sim-g-rpo-data
port=18766
loops=()

stop_loops() {
  local pid
  # bash 3.2 (macOS) treats an empty array as unset under set -u.
  for pid in ${loops[@]+"${loops[@]}"}; do
    kill "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null || true
  done
  loops=()
}
cleanup() {
  stop_loops
  if [[ -n "${mock:-}" ]]; then
    kill "${mock}" 2>/dev/null || true
    wait "${mock}" 2>/dev/null || true
  fi
  docker rm -f "${db}" "${restored}" >/dev/null 2>&1 || true
  docker volume rm -f "${socket}" "${data}" "${restored}" >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT
# A cancelled run (CI, Ctrl-C) still cleans up.
trap 'exit 143' TERM
trap 'exit 130' INT
docker rm -f "${db}" "${restored}" >/dev/null 2>&1 || true
docker volume rm -f "${socket}" "${data}" "${restored}" >/dev/null 2>&1 || true

say() { printf 'rpo check: %s\n' "$*" >&2; }
die() {
  say "FAILED: $*"
  exit 1
}
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
sha256() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; }

docker build --quiet --tag sim-g-postgres:check deploy/vm/postgres >/dev/null
postgres_image="$(docker image inspect --format '{{.Id}}' sim-g-postgres:check)"
gateway_id="$(docker image inspect --format '{{.Id}}' "${gateway_image}")"

# --- 1. the source: production roles, migrations and grants ---------------
docker run -d --name "${db}" --network none --user 70:70 \
  -v "${socket}:/var/run/postgresql" -v "${data}:/var/lib/postgresql/data" \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" "${postgres_image}" >/dev/null
ready() { # server: the final server, not the entrypoint's temporary one
  local _
  for _ in $(seq 1 90); do
    docker logs "$1" 2>&1 | grep -q 'init process complete' &&
      docker exec "$1" pg_isready -q 2>/dev/null && return
    sleep 1
  done
  return 1
}
ready "${db}" || die "the source server never became ready"
docker exec "${db}" psql -q -v ON_ERROR_STOP=1 -U postgres -f /etc/sim-g/bootstrap-roles.sql >/dev/null
as_migrator() { # volume image command...
  local volume="$1" image="$2"
  shift 2
  docker run --rm -i --network none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --user 9002:9002 --log-driver none -v "${volume}:/run/postgresql" \
    -e GATEWAY_MIGRATION_DATABASE_URL='postgresql://gateway_migrator@/family_brain_gateway?host=/run/postgresql' \
    "${image}" "$@"
}
grant() { # volume
  as_migrator "$1" "${postgres_image}" psql -q -v ON_ERROR_STOP=1 -h /run/postgresql \
    -U gateway_migrator -d family_brain_gateway -f /etc/sim-g/grant-runtime.sql >/dev/null
}
as_migrator "${socket}" "${gateway_id}" node dist/migration-cli.js >/dev/null
grant "${socket}"
runtime_password="$(openssl rand -hex 16)"
set_runtime_password() { # server
  docker exec "$1" psql -q -v ON_ERROR_STOP=1 -U postgres -c \
    "ALTER ROLE gateway_runtime PASSWORD '${runtime_password}'" >/dev/null
}
set_runtime_password "${db}"
runtime_sql() { # server sql
  docker exec -e PGPASSWORD="${runtime_password}" "$1" psql -X -q -v ON_ERROR_STOP=1 \
    -h /var/run/postgresql -U gateway_runtime -d family_brain_gateway -tAc "$2"
}
superuser_value() { # server sql
  docker exec "$1" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d family_brain_gateway -tAc "$2"
}
heartbeat_max="SELECT coalesce(max((event->>'n')::bigint), 0) FROM public.audit_outbox
  WHERE event->>'type' = 'synthetic_heartbeat'"
operations_count="SELECT count(*) FROM public.operations WHERE id LIKE 'op\\_rpo\\_%'"

# --- 2. load and the heartbeat probe ----------------------------------------
heartbeats="${work}/heartbeats.log" # n, commit time (server clock)
: >"${heartbeats}"
(
  n=0
  while :; do
    n=$((n + 1))
    runtime_sql "${db}" "INSERT INTO audit_outbox (event)
      VALUES (jsonb_build_object('type', 'synthetic_heartbeat', 'n', ${n}))
      RETURNING ${n} || ' ' || floor(extract(epoch FROM clock_timestamp()))::bigint" \
      >>"${heartbeats}" 2>/dev/null || exit 0
    sleep 1
  done
) &
loops+=($!)
(
  n=0
  while :; do
    n=$((n + 1))
    runtime_sql "${db}" "INSERT INTO operations (id, request_id, principal_id, operation_type, state,
      request_fingerprint, created_at, updated_at) VALUES ('op_rpo_${n}', 'req_rpo_${n}', 'prn_steward',
      'search_brain', 'COMPLETED', encode(sha256('${n}'::bytea), 'hex'), now(), now())" >/dev/null 2>&1 || exit 0
    sleep 2
  done
) &
loops+=($!)

# --- 3. the recent tier on its (scaled) schedule ----------------------------
docker run --rm --network none "${postgres_image}" age-keygen 2>/dev/null >"${work}/identity.txt"
chmod 600 "${work}/identity.txt"
recipient="$(sed -n 's/^# public key: //p' "${work}/identity.txt")"
node scripts/backup-check/mock-storage.mjs "${port}" "${work}/uploads" &
mock=$!
mock_up=false
for _ in $(seq 1 50); do
  curl -sf -H 'Metadata-Flavor: Google' "http://127.0.0.1:${port}/token" >/dev/null && { mock_up=true; break; }
  sleep 0.1
done
[[ "${mock_up}" == true ]] || die "the storage stand-in never came up"
backup_env=(
  SIM_G_BACKUP_BUCKET=sim-g-rpo-daily
  SIM_G_RECENT_BACKUP_BUCKET=sim-g-rpo-recent
  SIM_G_BACKUP_MARKER="${work}/backup-recent.last"
  SIM_G_BACKUP_RECIPIENT="${recipient}"
  SIM_G_POSTGRES_IMAGE="${postgres_image}"
  SIM_G_SOCKET_DIR="${socket}"
  SIM_G_BACKUP_STAGING="${work}/staging"
  SIM_G_STORAGE_UPLOAD_BASE="http://127.0.0.1:${port}/upload/storage/v1/b"
  SIM_G_METADATA_TOKEN_URL="http://127.0.0.1:${port}/token"
)
recent="${work}/uploads/sim-g-rpo-recent"
# One line per completed run: object, then heartbeat and operations counts at
# its start and completion (server-side), then its run time in seconds.
runs="${work}/runs.log"
: >"${runs}"
validator=(env "SIM_G_POSTGRES_IMAGE=${postgres_image}" "SIM_G_GATEWAY_IMAGE=${gateway_id}"
  bash deploy/vm/backup/sim-g-restore-check.sh)

back_up() { # run number: records the run on success
  local started before before_ops after after_ops line object
  started="$(date -u +%s)"
  before="$(superuser_value "${db}" "${heartbeat_max}")" || return 1
  before_ops="$(superuser_value "${db}" "${operations_count}")" || return 1
  line="$(env "${backup_env[@]}" bash deploy/vm/backup/sim-g-backup.sh recent)" || return 1
  after="$(superuser_value "${db}" "${heartbeat_max}")" || return 1
  after_ops="$(superuser_value "${db}" "${operations_count}")" || return 1
  # The object name from the backup's own line, as the stand-in stores it.
  object="$(printf '%s' "${line}" | sed -n 's/.*"object":"\([^"]*\)".*/\1/p' | sed 's#/#__#g')"
  [[ -n "${object}" && -f "${recent}/${object}" ]] || return 1
  printf '%s %s %s %s %s %s\n' "${object}" "${before}" "${after}" "${before_ops}" "${after_ops}" \
    "$(($(date -u +%s) - started))" >>"${runs}"
}

sleep 3
for k in 1 2 3 4; do
  started="$(date -u +%s)"
  back_up "${k}" || die "backup ${k} failed"
  if [[ "${k}" == 1 ]]; then
    # The owner's restore record starts with the first accepted object.
    first="$(tail -n 1 "${runs}" | cut -d' ' -f1)"
    set +e
    "${validator[@]}" "${recent}/${first}" "${work}/identity.txt" \
      --created-at "$(mtime "${recent}/${first}")" >"${work}/accepted.json" 2>/dev/null
    status=$?
    set -e
    [[ "${status}" == 2 ]] || die "the first object did not validate (exit ${status}): $(cat "${work}/accepted.json")"
  fi
  [[ "${k}" == 4 ]] && break
  remaining=$((interval - ($(date -u +%s) - started)))
  [[ "${remaining}" -lt 1 ]] || sleep "${remaining}"
done

# --- 4. a lost data disk at a random moment ---------------------------------
# From just after run 4 until a moment after run 5 is due, so the kill can
# land during run 5 (which then fails, leaving run 4's object newest).
next_at=$((started + interval))
earliest=$(($(date -u +%s) + 1))
latest=$((next_at + 2))
[[ "${latest}" -gt "${earliest}" ]] || die "a backup took longer than the interval"
failure_at=$((earliest + RANDOM % (latest - earliest + 1)))
for pid in ${loops[@]+"${loops[@]}"}; do
  kill -0 "${pid}" 2>/dev/null || die "the load or heartbeat stopped before the failure"
done
(
  wait_for=$((next_at - $(date -u +%s)))
  [[ "${wait_for}" -lt 1 ]] || sleep "${wait_for}"
  back_up 5 || true
) &
fifth=$!
wait_for=$((failure_at - $(date -u +%s)))
[[ "${wait_for}" -lt 1 ]] || sleep "${wait_for}"
failed_at="$(date -u +%s)"
lost_from="$(superuser_value "${db}" "${heartbeat_max}")"
docker kill "${db}" >/dev/null
docker rm -f "${db}" >/dev/null
docker volume rm -f "${data}" >/dev/null
stop_loops
wait "${fifth}" 2>/dev/null || true
say "data disk lost at ${failed_at}, $((failed_at - next_at)) s after run 5 was due; last heartbeat ${lost_from}"

# --- 5. recovery: choose by creation time, validate, restore ----------------
# Newest first by creation time; junk falls back, anything else stops.
choose() { # directory: prints the chosen object's path
  local object status
  for object in $(ls -t "$1"); do
    set +e
    "${validator[@]}" "$1/${object}" "${work}/identity.txt" --created-at "$(mtime "$1/${object}")" \
      --previous "${work}/accepted.json" >"${work}/candidate.json" 2>/dev/null
    status=$?
    set -e
    case "${status}" in
      0)
        printf '%s\n' "$1/${object}"
        return
        ;;
      1) grep -q '"reason":"restore_decrypt_failed"' "${work}/candidate.json" || return 1 ;;
      *) return 1 ;;
    esac
  done
  return 1
}
restore_into() { # object
  # A private copy of exactly the validated file.
  cp "$1" "${work}/restore.age"
  [[ "$(sha256 "${work}/restore.age")" == "$(sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p' "${work}/candidate.json")" ]] ||
    die "the file to restore is not the validated one"
  docker volume create "${restored}" >/dev/null
  docker run -d --name "${restored}" --network none --user 70:70 \
    -v "${restored}:/var/run/postgresql" --tmpfs /var/lib/postgresql/data:uid=70,gid=70,mode=0700 \
    -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" "${postgres_image}" >/dev/null
  ready "${restored}" || die "the new server never became ready"
  # Bootstrapped as in production: the runtime password comes last (step 7).
  docker exec "${restored}" psql -q -v ON_ERROR_STOP=1 -U postgres -f /etc/sim-g/bootstrap-roles.sql >/dev/null
  docker run --rm -i --network none --read-only --user "$(id -u):$(id -g)" \
    --mount "type=bind,source=${work}/identity.txt,target=/run/age-identity,readonly" \
    "${postgres_image}" age --decrypt --identity /run/age-identity <"${work}/restore.age" |
    as_migrator "${restored}" "${postgres_image}" pg_restore -h /run/postgresql -U gateway_migrator \
      -d family_brain_gateway --no-owner --no-privileges --exit-on-error
  local ledger="SELECT count(*) FROM public.gateway_schema_migrations" applied result
  applied="$(superuser_value "${restored}" "${ledger}")"
  # The production re-check, exactly as the runbook's step 8: its own mode
  # of the validator, which migrates and grants the copy itself (here
  # directly, not through systemd) and fails closed.
  result="$(env "SIM_G_POSTGRES_IMAGE=${postgres_image}" "SIM_G_GATEWAY_IMAGE=${gateway_id}" \
    "SIM_G_RECHECK_MIGRATE_SOCKET=${restored}" "SIM_G_RECHECK_GATEWAY_CONFIG=${work}/gateway.json" \
    bash deploy/vm/backup/sim-g-restore-check.sh --production-check --server "${restored}" \
    --summary "${work}/candidate.json" --dump "${work}/restore.age" \
    --previous "${work}/accepted.json" 2>/dev/null)" ||
    die "the restored production copy failed its re-check: ${result}"
  [[ "${result}" == '{"severity":"INFO","msg":"production_recheck_passed",'* ]] ||
    die "the re-check did not pass: ${result}"
  [[ "$(superuser_value "${restored}" "${ledger}")" == "${applied}" ]] ||
    die "migrations applied something to the restored copy"
  set_runtime_password "${restored}"
  runtime_sql "${restored}" "INSERT INTO audit_outbox (event)
    VALUES (jsonb_build_object('type', 'synthetic_after_restore'))" >/dev/null ||
    die "the runtime cannot write to the restored copy"
}
recover() { # directory: chooses and restores, or stops with an explicit error
  local chosen
  chosen="$(choose "$1")" || {
    say "no usable backup: recovery stopped"
    return 3
  }
  restore_into "${chosen}"
  printf '%s\n' "${chosen}"
}
drop_restored() {
  docker rm -f "${restored}" >/dev/null 2>&1 || true
  docker volume rm -f "${restored}" >/dev/null 2>&1 || true
}
heartbeat_time() { awk -v n="$1" '$1 == n { print $2 }' "${heartbeats}"; }
assert_bound() { # object intervals
  local kept kept_at ops window fields seconds slowest loss
  kept="$(superuser_value "${restored}" "${heartbeat_max}")"
  kept_at="$(heartbeat_time "${kept}")"
  [[ -n "${kept_at}" ]] || die "the restored heartbeat ${kept} was never recorded"
  ops="$(superuser_value "${restored}" "${operations_count}")"
  read -r -a fields < <(awk -v o="$(basename "$1")" '$1 == o { print $2, $3, $4, $5, $6 }' "${runs}")
  [[ "${#fields[@]}" == 5 ]] || die "no completed run made $(basename "$1")"
  seconds="${fields[4]}"
  # The snapshot falls between the run's start and its completion.
  [[ "${kept}" -ge "${fields[0]}" && "${kept}" -le "${fields[1]}" ]] ||
    die "restored heartbeat ${kept} is outside its run's window ${fields[0]}-${fields[1]}"
  [[ "${ops}" -gt 0 && "${ops}" -ge "${fields[2]}" && "${ops}" -le "${fields[3]}" ]] ||
    die "restored operations ${ops} are outside its run's window ${fields[2]}-${fields[3]}"
  slowest="$(awk 'BEGIN { m = 0 } $6 > m { m = $6 } END { print m }' "${runs}")"
  loss=$((failed_at - kept_at))
  window=$(($2 * interval + ($2 * interval + 9) / 10 + slowest + 2))
  [[ "${loss}" -le "${window}" ]] || die "lost ${loss} s, more than the ${window} s bound"
  printf '{"severity":"INFO","msg":"rpo_check_bound","intervals":%s,"interval_seconds":%s,"lost_seconds":%s,"lost_heartbeats":%s,"bound_seconds":%s,"run_seconds":%s}\n' \
    "$2" "${interval}" "${loss}" "$((lost_from - kept))" "${window}" "${seconds}"
}

# A planted object with a far-future name but an old creation time.
planted="${recent}/family-brain-gateway__2099__01__01__20990101T000000Z.dump.age"
cp "${recent}/$(head -n 1 "${runs}" | cut -d' ' -f1)" "${planted}"
touch -t 202001010000 "${planted}"

newest="$(tail -n 1 "${runs}" | cut -d' ' -f1)"
chosen="$(recover "${recent}")" || die "recovery failed: $(cat "${work}/candidate.json")"
[[ "${chosen}" != "${planted}" ]] || die "the far-future name was chosen"
[[ "$(basename "${chosen}")" == "${newest}" ]] || die "the newest completed run's object was not chosen"
assert_bound "${chosen}" 1
drop_restored

# --- negative cases ---------------------------------------------------------
# The newest object corrupted at rest (one byte complemented, its creation
# time kept): decryption fails, so the previous object is used, within two
# intervals.
touch -r "${chosen}" "${work}/created"
offset=$(($(wc -c <"${chosen}" | tr -d ' ') / 2))
before_hash="$(sha256 "${chosen}")"
byte="$(dd if="${chosen}" bs=1 skip="${offset}" count=1 2>/dev/null | od -An -tu1 | tr -d ' ')"
# shellcheck disable=SC2059
printf "\\$(printf '%03o' $((255 - byte)))" | dd of="${chosen}" bs=1 seek="${offset}" conv=notrunc 2>/dev/null
touch -r "${work}/created" "${chosen}"
[[ "$(sha256 "${chosen}")" != "${before_hash}" ]] || die "the corruption changed nothing"
previous="$(tail -n 2 "${runs}" | head -n 1 | cut -d' ' -f1)"
fallback="$(recover "${recent}")" || die "no fallback restored: $(cat "${work}/candidate.json")"
[[ "$(basename "${fallback}")" == "${previous}" ]] || die "the fallback is not the previous object"
assert_bound "${fallback}" 2
drop_restored

# No usable object, empty or all junk: recovery stops explicitly and starts
# nothing.
mkdir -p "${work}/empty" "${work}/junk"
for object in $(ls "${recent}"); do
  head -c 4096 /dev/urandom >"${work}/junk/${object}"
done
for directory in "${work}/empty" "${work}/junk"; do
  set +e
  recover "${directory}" >/dev/null 2>"${work}/stopped.log"
  status=$?
  set -e
  [[ "${status}" == 3 ]] || die "recovery from $(basename "${directory}") did not stop (exit ${status})"
  grep -q 'no usable backup: recovery stopped' "${work}/stopped.log" || die "no explicit error for $(basename "${directory}")"
  ! docker container inspect "${restored}" >/dev/null 2>&1 || die "a server was started without a backup"
  ! docker volume inspect "${restored}" >/dev/null 2>&1 || die "a volume was created without a backup"
done

say "passed: interval ${interval} s"
