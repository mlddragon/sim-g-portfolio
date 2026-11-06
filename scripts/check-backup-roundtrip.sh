#!/usr/bin/env bash
# Synthetic backup round trip for the e2-micro VM design (sections 6 and 8),
# run against local containers only. It proves:
#   - the PostgreSQL derivative with socket-only, peer/SCRAM authentication;
#   - role bootstrap; the compiled migration command as the migrator (peer);
#   - runtime DML but no DDL; the gateway's uid cannot impersonate job roles;
#   - dump as the backup role, age encryption, a metadata-token upload that
#     never overwrites, then decrypt, restore and matching row counts.
# Fictional data only; nothing leaves this machine.
set -euo pipefail

cd "$(dirname "$0")/.."

gateway_image="${1:-family-brain-gateway:check}"
# Under $HOME: Colima bind-mounts only the home directory into its VM.
mkdir -p "${HOME}/.cache/sim-g-backup-check"
work="$(mktemp -d "${HOME}/.cache/sim-g-backup-check/run.XXXXXX")"
chmod 700 "${work}"
mkdir -p "${work}/uploads" "${work}/staging"
socket=sim-g-check-socket
data=sim-g-check-data
db=sim-g-check-db
port=18765

cleanup() {
  if [[ -n "${mock:-}" ]]; then
    kill "${mock}" 2>/dev/null || true
    wait "${mock}" 2>/dev/null || true
  fi
  docker rm -f "${db}" sim-g-check-production >/dev/null 2>&1 || true
  docker volume rm -f "${socket}" "${data}" sim-g-check-production sim-g-check-missing-socket >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT
cleanup_partial() { docker rm -f "${db}" >/dev/null 2>&1 || true; docker volume rm -f "${socket}" "${data}" >/dev/null 2>&1 || true; }
cleanup_partial

expect_line() { # expected-json actual
  if [[ "$2" != "$1" ]]; then
    echo "expected: $1" >&2
    echo "actual:   $2" >&2
    exit 1
  fi
}

docker build --quiet --tag sim-g-postgres:check deploy/vm/postgres >/dev/null
postgres_image="$(docker image inspect --format '{{.Id}}' sim-g-postgres:check)"

# Socket-only server with the shipped pg_hba/pg_ident.
# The image's own CMD: no TCP listener, the shipped pg_hba/pg_ident. The
# initdb password is synthetic and discarded by the bootstrap.
docker run -d --name "${db}" --network none --user 70:70 \
  -v "${socket}:/var/run/postgresql" -v "${data}:/var/lib/postgresql/data" \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" "${postgres_image}" >/dev/null
# Wait for the final server, not the entrypoint's temporary init server.
for _ in $(seq 1 90); do
  if docker logs "${db}" 2>&1 | grep -q 'init process complete' &&
    docker exec "${db}" pg_isready -q 2>/dev/null; then
    break
  fi
  sleep 1
done
docker exec "${db}" pg_isready -q || { echo "server never became ready" >&2; exit 1; }
docker exec -i "${db}" psql -q -v ON_ERROR_STOP=1 -U postgres <deploy/vm/postgres/bootstrap-roles.sql

# Migrations: the compiled command, as the migrator, over the socket (peer).
migrate="$(docker run --rm --network none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --user 9002:9002 -v "${socket}:/run/postgresql" \
  -e GATEWAY_MIGRATION_DATABASE_URL='postgresql://gateway_migrator@/family_brain_gateway?host=/run/postgresql' \
  "${gateway_image}" node dist/migration-cli.js 2>&1)"
expect_line '{"severity":"INFO","msg":"migrations_completed"}' "${migrate}"
# The migration job then grants the runtime exactly what it needs.
docker run --rm --network none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --user 9002:9002 -v "${socket}:/run/postgresql" \
  "${postgres_image}" psql -q -v ON_ERROR_STOP=1 -h /run/postgresql \
  -U gateway_migrator -d family_brain_gateway -f /etc/sim-g/grant-runtime.sql

refused() { # pattern description command...
  local pattern="$1" what="$2" output
  shift 2
  if output="$("$@" 2>&1)"; then
    echo "must be refused: ${what}" >&2
    exit 1
  fi
  [[ "${output}" =~ ${pattern} ]] || { echo "refused for the wrong reason: ${what}: ${output}" >&2; exit 1; }
}
as_uid() { # uid role sql
  docker run --rm --network none --user "$1:$1" -v "${socket}:/run/postgresql" \
    "${postgres_image}" psql -h /run/postgresql -U "$2" -d family_brain_gateway -tAc "$3"
}
refused 'Peer authentication failed' 'uid 1000 as the backup role' as_uid 1000 gateway_backup 'SELECT 1'
refused 'Peer authentication failed' 'uid 9001 as the migrator' as_uid 9001 gateway_migrator 'SELECT 1'
refused 'Peer authentication failed' 'uid 9002 as the backup role' as_uid 9002 gateway_backup 'SELECT 1'
refused 'Peer authentication failed' "the image's default user as superuser" \
  docker run --rm --network none -v "${socket}:/run/postgresql" "${postgres_image}" \
  psql -h /run/postgresql -U postgres -d postgres -tAc 'SELECT 1'

# The runtime role: SCRAM password, DML only.
runtime_password="$(openssl rand -hex 16)"
docker exec -u postgres "${db}" psql -q -v ON_ERROR_STOP=1 -U postgres -c \
  "ALTER ROLE gateway_runtime PASSWORD '${runtime_password}'" >/dev/null
runtime_sql() {
  docker exec -e PGPASSWORD="${runtime_password}" "${db}" psql -q -v ON_ERROR_STOP=1 \
    -h /var/run/postgresql -U gateway_runtime -d family_brain_gateway -tAc "$1"
}
runtime_sql "INSERT INTO identity_bindings (id, principal_id, issuer, external_subject, email)
  VALUES ('idb_check_operator', 'prn_operator', 'https://accounts.google.com', 'synthetic-subject-check', 'operator@example.invalid')" >/dev/null
refused 'permission denied' 'runtime DDL' runtime_sql 'CREATE TABLE synthetic_ddl_probe ()'
refused 'permission denied' 'runtime temporary tables' runtime_sql 'CREATE TEMP TABLE synthetic_temp_probe ()'
refused 'permission denied' 'runtime DELETE' runtime_sql "DELETE FROM identity_bindings WHERE id = 'idb_check_operator'"
refused 'permission denied' 'runtime writes to the migration ledger' \
  runtime_sql "UPDATE gateway_schema_migrations SET content_hash = content_hash"
refused 'password|no password supplied' 'the runtime without its password' \
  docker exec "${db}" psql -h /var/run/postgresql -U gateway_runtime -d family_brain_gateway -w -tAc 'SELECT 1'

source_counts="$(docker exec "${db}" psql -U postgres -d family_brain_gateway -tA -c \
  "SELECT json_object_agg(table_name, (xpath('/row/c/text()',
       query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text::bigint
       ORDER BY table_name)
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")"

# A synthetic owner key pair, for this run only.
docker run --rm --network none "${postgres_image}" age-keygen 2>/dev/null >"${work}/identity.txt"
chmod 600 "${work}/identity.txt"
recipient="$(sed -n 's/^# public key: //p' "${work}/identity.txt")"

node scripts/backup-check/mock-storage.mjs "${port}" "${work}/uploads" &
mock=$!
for _ in $(seq 1 50); do
  curl -sf -H 'Metadata-Flavor: Google' "http://127.0.0.1:${port}/token" >/dev/null && break
  sleep 0.1
done

backup_env=(
  SIM_G_BACKUP_BUCKET=sim-g-check-bucket
  SIM_G_RECENT_BACKUP_BUCKET=sim-g-check-recent
  SIM_G_BACKUP_MARKER="${work}/backup-recent.last"
  SIM_G_BACKUP_RECIPIENT="${recipient}"
  SIM_G_POSTGRES_IMAGE="${postgres_image}"
  SIM_G_SOCKET_DIR="${socket}"
  SIM_G_BACKUP_STAGING="${work}/staging"
  SIM_G_STORAGE_UPLOAD_BASE="http://127.0.0.1:${port}/upload/storage/v1/b"
  SIM_G_METADATA_TOKEN_URL="http://127.0.0.1:${port}/token"
)
result="$(env "${backup_env[@]}" bash deploy/vm/backup/sim-g-backup.sh)"
[[ "${result}" == *'"msg":"backup_completed"'* ]] || { echo "${result}" >&2; exit 1; }
uploaded="$(find "${work}/uploads/sim-g-check-bucket" -type f | head -1)"
[[ -s "${uploaded}" ]] || { echo "no upload recorded" >&2; exit 1; }
[[ ! -e "${work}/uploads/sim-g-check-recent" ]] || { echo "the daily tier wrote to the recent bucket" >&2; exit 1; }
[[ ! -e "${work}/backup-recent.last" ]] || { echo "the daily tier wrote the recent marker" >&2; exit 1; }
# Encrypted: an age header, and no pg_dump custom-format magic anywhere.
[[ "$(head -c 21 "${uploaded}")" == "age-encryption.org/v1" ]] || { echo "upload is not age-encrypted" >&2; exit 1; }
if grep -aq 'PGDMP' "${uploaded}"; then
  echo "the uploaded backup contains a plaintext dump" >&2
  exit 1
fi
[[ -z "$(ls -A "${work}/staging")" ]] || { echo "staging not cleaned" >&2; exit 1; }

# The script must fail, not overwrite, when storage refuses an existing name
# (ifGenerationMatch=0 answers 412).
touch "${work}/uploads/.refuse-all"
refused="$(env "${backup_env[@]}" bash deploy/vm/backup/sim-g-backup.sh || true)"
expect_line '{"severity":"ERROR","msg":"backup_failed","reason":"backup_upload_http_412"}' "${refused}"
rm -f "${work}/uploads/.refuse-all"

# The recent tier: the same dump and encryption, only to its own bucket, and
# a recorded completion time for the staleness check.
recent="$(env "${backup_env[@]}" bash deploy/vm/backup/sim-g-backup.sh recent)"
[[ "${recent}" == '{"severity":"INFO","msg":"backup_completed","tier":"recent",'* ]] || {
  echo "${recent}" >&2
  exit 1
}
recent_upload="$(find "${work}/uploads/sim-g-check-recent" -type f | head -1)"
[[ -s "${recent_upload}" && "$(head -c 21 "${recent_upload}")" == "age-encryption.org/v1" ]] ||
  { echo "no encrypted recent upload recorded" >&2; exit 1; }
if grep -aq 'PGDMP' "${recent_upload}"; then
  echo "the recent backup contains a plaintext dump" >&2
  exit 1
fi
[[ -z "$(ls -A "${work}/staging")" ]] || { echo "staging not cleaned after the recent tier" >&2; exit 1; }
[[ "$(find "${work}/uploads/sim-g-check-bucket" -type f | wc -l | tr -d ' ')" == 1 ]] ||
  { echo "the recent tier wrote to the daily bucket" >&2; exit 1; }
[[ "$(cat "${work}/backup-recent.last")" =~ ^[0-9]+$ ]] || { echo "no recent marker recorded" >&2; exit 1; }

# Both objects restore through the isolated validation, then the
# validation's own cases (scripts/backup-check/restore-validation.sh).
# shellcheck source=scripts/backup-check/restore-validation.sh
source scripts/backup-check/restore-validation.sh
# Then the production re-check on a restored copy (runbook step 8).
# shellcheck source=scripts/backup-check/production-check.sh
source scripts/backup-check/production-check.sh

echo "backup round trip passed: ${source_counts}"
