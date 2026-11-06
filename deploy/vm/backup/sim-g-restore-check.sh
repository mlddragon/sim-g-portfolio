#!/usr/bin/env bash
# Isolated, least-privileged restore validation (recovery point
# investigation, section 9). It validates one encrypted dump before anything
# is restored into production, and it is the restore drill:
#
#   sim-g-restore-check.sh <encrypted dump> <age identity file> \
#     --created-at <unix seconds> [--previous <summary file>]
#
#   sim-g-restore-check.sh --production-check --summary <accepted summary> \
#     --dump <the restored private copy> [--previous <summary file>] \
#     [--server <container>]
#
# The second form is the production re-check (production restore, step 8):
# see production_check below.
#
#   --created-at  the object's server-side creation time (timeCreated), from
#                 Cloud Storage, never from its name.
#   --previous    the summary line of the previous accepted backup on this
#                 timeline, created before this one (the owner's restore
#                 record). Without it, the verdict is held for owner review.
#
# The ciphertext is copied once to a private file, and only that copy is
# read. Everything runs in throwaway --network none containers with tmpfs
# storage, no capabilities and no stored logs, under the production database
# and role names. Two servers are initialized and bootstrapped: a reference,
# migrated from the gateway image, and the candidate. The dump's SQL runs
# only as gateway_migrator (peer, uid 9002), never as the superuser. The
# owner's identity is mounted read-only, for decryption only.
#
# The restored database belongs to the migrator, who could plant database
# settings or functions that shadow builtins. So the validator's own
# superuser sessions first check the shared catalogs from the postgres
# database, then always run with search_path=pg_catalog,pg_temp and fixed
# timeouts and formats (client options override database settings), and
# name every table by schema. Then:
#   1. the archive's table of contents must be a subset of the reference's
#      (a cheap pre-filter: in a forged archive its entries are only labels);
#   2. the restored catalogs must hold no functions, triggers, rules,
#      policies, extensions beyond plpgsql, event triggers, user types, extra
#      schemas, large objects, foreign owners, or database or role settings;
#      and the database row (including its grants), the job roles and role
#      memberships must equal the reference server's. This is authoritative
#      only for what persists: SQL can create and drop objects during the
#      restore;
#   3. no record time is later than --created-at plus 5 minutes, and no
#      table count or audit identifier is below --previous (before
#      migrating, so the validator's own ledger rows never count);
#   4. the migration ledger must be a prefix of the reference's; after
#      migrating forward, the ledger and the schema must equal the
#      reference's;
#   5. the security-relevant tables are compared with --previous by digest.
# These checks reduce the risk of a forged backup; they do not eliminate it.
#
# Prints one JSON line. On success it is the summary to keep in the owner's
# restore record: the verdict, the ciphertext's SHA-256 (age's header binds
# its file key, and decryption is deterministic, so only that file may be
# restored), counts and digests. It never prints table contents.
#
# Exit status:
#   0  accepted;
#   2  held for owner review: security-relevant state changed ("changed"
#      names the tables), or no previous summary was given ("changed":null);
#   3  suspicious: quarantine this object, and treat every object created at
#      or after it as suspect ("quarantine":true). Once the archive has been
#      read, any failure the dump could cause is suspicious, including a
#      dump that does not restore (engineering ruling, R4a);
#   1  anything else: a dump that does not decrypt (junk: the previous
#      object may be used), bad arguments, or a tool failure.
set -euo pipefail
umask 077

skew=300
record_columns="created_at updated_at activated_at attempted_at resolved_at consumed_at delivered_at applied_at superseded_at"
security_tables="identity_bindings policy_versions principals project_registry_versions"
database=family_brain_gateway
# Every superuser session on a throwaway copy. Client options take precedence
# over database and role settings.
pgoptions="-c search_path=pg_catalog,pg_temp -c statement_timeout=0 -c lock_timeout=0"
pgoptions+=" -c idle_in_transaction_session_timeout=0 -c default_transaction_read_only=off"
pgoptions+=" -c TimeZone=UTC -c DateStyle=ISO,MDY -c IntervalStyle=postgres -c extra_float_digits=1"
pgoptions+=" -c client_min_messages=warning -c row_security=off"
reference=""
candidate=""
private=""

emit_failure() { # reason quarantine
  printf '{"severity":"ERROR","msg":"restore_check_failed","reason":"%s","quarantine":%s}\n' "$1" "$2"
}
fail() {
  emit_failure "$1" false
  exit 1
}
suspicious() {
  emit_failure "$1" true
  exit 3
}
cleanup() {
  local name
  for name in "${reference}" "${candidate}"; do
    [[ -z "${name}" ]] && continue
    docker rm -f "${name}" >/dev/null 2>&1 || true
    docker volume rm -f "${name}" >/dev/null 2>&1 || true
  done
  [[ -z "${private}" ]] || rm -rf "${private}"
}

# GNU coreutils on the VM, BSD shasum on macOS.
sha256() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; }
random_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# A throwaway server: initialized directly (no entrypoint, so no temporary
# init server), socket only, the shipped authentication rules, small memory
# settings, then bootstrapped with the production roles and database.
start_server() { # name (also its socket volume)
  docker volume create "$1" >/dev/null || return 1
  docker run -d --name "$1" --network none --read-only --cap-drop=ALL \
    --security-opt=no-new-privileges --user 70:70 --memory 256m --memory-swap 256m \
    --pids-limit 128 --log-driver none --tmpfs /tmp:size=16m \
    --tmpfs /var/lib/postgresql/data:size=512m,uid=70,gid=70,mode=0700 \
    -v "$1:/var/run/postgresql" --entrypoint sh "${SIM_G_POSTGRES_IMAGE}" -c '
      initdb -D /var/lib/postgresql/data --username=postgres --auth-local=peer --auth-host=reject >/dev/null &&
      exec postgres -D /var/lib/postgresql/data -c listen_addresses= \
        -c hba_file=/etc/sim-g/pg_hba.conf -c ident_file=/etc/sim-g/pg_ident.conf \
        -c shared_buffers=32MB -c max_wal_size=64MB -c min_wal_size=32MB' >/dev/null || return 1
  local _
  for _ in $(seq 1 90); do
    if docker exec "$1" pg_isready -q 2>/dev/null; then
      docker exec -e PGOPTIONS="${pgoptions}" "$1" psql -X -q -v ON_ERROR_STOP=1 -U postgres \
        -f /etc/sim-g/bootstrap-roles.sql >/dev/null 2>&1
      return
    fi
    sleep 1
  done
  return 1
}
# Inspection of a throwaway copy, as its superuser, hardened (see above).
superuser_sql() { # server sql [database]
  docker exec -e PGOPTIONS="${pgoptions}" "$1" psql -X -q -v ON_ERROR_STOP=1 -U postgres \
    -d "${3:-${database}}" -tA -c "$2"
}
# A job container as the migrator (uid 9002), with no network.
as_migrator() { # volume image command...
  local volume="$1" image="$2"
  shift 2
  docker run --rm -i --network none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --user 9002:9002 --memory 256m --memory-swap 256m --pids-limit 64 --log-driver none \
    -v "${volume}:/run/postgresql" \
    -e GATEWAY_MIGRATION_DATABASE_URL="postgresql://gateway_migrator@/${database}?host=/run/postgresql" \
    "${image}" "$@"
}
migrate_and_grant() { # volume
  as_migrator "$1" "${SIM_G_GATEWAY_IMAGE}" node dist/migration-cli.js >/dev/null 2>&1 &&
    as_migrator "$1" "${SIM_G_POSTGRES_IMAGE}" psql -X -q -v ON_ERROR_STOP=1 -h /run/postgresql \
      -U gateway_migrator -d "${database}" -f /etc/sim-g/grant-runtime.sql >/dev/null 2>&1
}
# Every container here runs without a log driver: Docker records stdout even
# when it is piped, and these streams carry plaintext dumps.
decrypt() { # dump identity owner
  docker run --rm -i --network none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --user "$3" --memory 256m --memory-swap 256m --pids-limit 64 --log-driver none \
    --mount "type=bind,source=$2,target=/run/age-identity,readonly" \
    "${SIM_G_POSTGRES_IMAGE}" age --decrypt --identity /run/age-identity <"$1"
}
# The archive on stdin, with no server, network or role. pg_restore stops at
# the end of the table of contents; the rest is drained so that the
# decryption (which authenticates every chunk) always reads to the end.
list_archive() {
  docker run --rm -i --network none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --user 65534:65534 --memory 256m --memory-swap 256m --pids-limit 64 --log-driver none \
    --entrypoint sh "${SIM_G_POSTGRES_IMAGE}" -c 'pg_restore --list; status=$?; cat >/dev/null; exit "${status}"'
}
# One line per entry: its type, schema and name, without the archive's ids
# or the owner label.
toc_entries() {
  sed -n 's/^[0-9][0-9]*; [0-9][0-9]* [0-9][0-9]* //p' | sed 's/ [^ ]*$//' | LC_ALL=C sort -u
}
schema_of() { # server
  docker exec -e PGOPTIONS="${pgoptions}" "$1" pg_dump -U postgres --schema-only "${database}" |
    grep -v -e '^--' -e '^\\restrict ' -e '^\\unrestrict ' -e '^$'
}
ledger_query="SELECT version || ':' || filename || ':' || content_hash
  FROM public.gateway_schema_migrations ORDER BY version COLLATE \"C\""

# The database row, the job roles and role memberships, as one canonical
# text: everything the database owner could change outside the schema
# dump, such as GRANT ... ON DATABASE.
shared_state() { # server
  superuser_sql "$1" "
    SELECT concat_ws(' | ',
      (SELECT row(datacl, pg_get_userbyid(datdba), encoding, datcollate, datctype, datlocprovider,
        datconnlimit, datallowconn, datistemplate)::text FROM pg_database WHERE datname = '${database}'),
      (SELECT string_agg(row(rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
        rolreplication, rolconnlimit, rolvaliduntil, rolbypassrls, rolpassword IS NULL)::text, ','
        ORDER BY rolname COLLATE \"C\") FROM pg_authid
        WHERE rolname IN ('gateway_migrator', 'gateway_runtime', 'gateway_backup')),
      (SELECT coalesce(string_agg(m, ',' ORDER BY m COLLATE \"C\"), '') FROM (SELECT
        roleid::regrole::text || '>' || member::regrole::text || ':' || admin_option AS m
        FROM pg_auth_members) AS memberships))" postgres
}

# Authoritative for what persists: the shared catalogs first, from the
# postgres database, so no planted database setting can reach a superuser
# session (and, given a reference, the database and job roles must equal
# its own); then the restored catalogs. Prints the kinds found,
# comma-separated, or nothing.
catalog_findings() { # server [reference]
  local shared restored state
  if [[ -n "${2:-}" ]]; then
    state="$(shared_state "$1")" || return 1
    [[ -n "${state}" && "${state}" == "$(shared_state "$2")" ]] || {
      printf 'database\n'
      return
    }
  fi
  shared="$(superuser_sql "$1" "
    SELECT concat_ws(',',
      CASE WHEN EXISTS (SELECT FROM pg_db_role_setting) THEN 'setting' END,
      CASE WHEN EXISTS (SELECT FROM pg_database WHERE datname = '${database}'
        AND (datconnlimit <> -1 OR NOT datallowconn OR datistemplate
          OR pg_get_userbyid(datdba) <> 'gateway_migrator')) THEN 'database' END,
      CASE WHEN EXISTS (SELECT FROM pg_authid WHERE rolname IN
        ('gateway_migrator', 'gateway_runtime', 'gateway_backup')
        AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls
          OR rolconnlimit <> -1 OR rolvaliduntil IS NOT NULL
          OR (rolpassword IS NOT NULL AND rolname <> 'gateway_runtime'))) THEN 'role' END)" postgres)" ||
    return 1
  if [[ -n "${shared}" ]]; then
    printf '%s\n' "${shared}"
    return
  fi
  restored="$(superuser_sql "$1" "
    SELECT concat_ws(',',
      CASE WHEN EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')) THEN 'function' END,
      CASE WHEN EXISTS (SELECT FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')) THEN 'operator' END,
      CASE WHEN EXISTS (SELECT FROM pg_trigger WHERE NOT tgisinternal) THEN 'trigger' END,
      CASE WHEN EXISTS (SELECT FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')) THEN 'rule' END,
      CASE WHEN EXISTS (SELECT FROM pg_policy) THEN 'policy' END,
      CASE WHEN EXISTS (SELECT FROM pg_largeobject_metadata) THEN 'large_object' END,
      CASE WHEN EXISTS (SELECT FROM pg_extension WHERE extname <> 'plpgsql') THEN 'extension' END,
      CASE WHEN EXISTS (SELECT FROM pg_event_trigger) THEN 'event_trigger' END,
      CASE WHEN EXISTS (SELECT FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype IN ('d', 'e', 'r', 'm', 'p')) THEN 'type' END,
      CASE WHEN EXISTS (SELECT FROM pg_namespace WHERE nspname NOT IN
        ('pg_catalog', 'information_schema', 'public', 'pg_toast')
        AND nspname NOT LIKE 'pg\\_temp\\_%' AND nspname NOT LIKE 'pg\\_toast\\_temp\\_%') THEN 'schema' END,
      CASE WHEN EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) <> 'gateway_migrator') THEN 'owner' END)")" ||
    return 1
  printf '%s\n' "${restored}"
}

# The owner's inputs, judged on the clean reference server (never inside
# the restored copy): prints a restore_* reason, or nothing.
previous_problem() { # server created_at digest previous_line
  docker exec -i -e PGOPTIONS="${pgoptions}" "$1" psql -X -q -v ON_ERROR_STOP=1 -U postgres \
    -d postgres -tA -v created_at="$2" -v digest="$3" -v previous="$4" <<'SQL' ||
SELECT CASE
  WHEN p = '{}'::jsonb THEN ''
  WHEN NOT (p ?& ARRAY['created_at', 'sha256', 'counts', 'max_audit_id', 'security'])
    OR jsonb_typeof(p->'created_at') <> 'number' OR jsonb_typeof(p->'counts') <> 'object'
    OR jsonb_typeof(p->'max_audit_id') <> 'number' OR jsonb_typeof(p->'security') <> 'object'
    -- Counts and the audit identifier: non-negative integers in bigint range.
    OR EXISTS (SELECT FROM jsonb_each(p->'counts') AS c(name, value)
      WHERE value::text !~ '^(0|[1-9][0-9]{0,17})$')
    OR (p->'max_audit_id')::text !~ '^(0|[1-9][0-9]{0,17})$'
    OR (p->'created_at')::text !~ '^[1-9][0-9]{0,11}$'
    THEN 'restore_previous_invalid'
  WHEN (p->>'created_at')::numeric > :'created_at'::numeric THEN 'restore_previous_not_earlier'
  WHEN (p->>'created_at')::numeric = :'created_at'::numeric AND p->>'sha256' <> :'digest'
    THEN 'restore_previous_not_earlier'
  ELSE '' END
FROM (SELECT :'previous'::jsonb AS p) AS input;
SQL
    printf 'restore_previous_invalid\n'
}

# Steps 3 and 5, inside the throwaway copy, before migrating. Prints the
# summary as JSON, or fails with a restore_* reason on standard error.
summarize() { # server created_at digest previous_line
  docker exec -i -e PGOPTIONS="${pgoptions}" "$1" psql -X -q -v ON_ERROR_STOP=1 -U postgres \
    -d "${database}" -tA -v created_at="$2" -v digest="$3" -v skew="${skew}" -v previous="$4" \
    -v columns="${record_columns}" -v security="${security_tables}" <<'SQL'
SELECT set_config('restore.created_at', :'created_at', false),
  set_config('restore.digest', :'digest', false),
  set_config('restore.skew', :'skew', false),
  set_config('restore.previous', :'previous', false),
  set_config('restore.columns', :'columns', false),
  set_config('restore.security', :'security', false) \g /dev/null
DO $$
DECLARE
  limit_at timestamptz := to_timestamp(current_setting('restore.created_at')::bigint
    + current_setting('restore.skew')::bigint);
  target record;
  late bigint;
BEGIN
  FOR target IN SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'timestamp with time zone'
      AND column_name = ANY (string_to_array(current_setting('restore.columns'), ' '))
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I > $1', target.table_name, target.column_name)
      INTO late USING limit_at;
    IF late > 0 THEN
      RAISE EXCEPTION 'restore_record_after_creation';
    END IF;
  END LOOP;
END $$;
CREATE TEMP TABLE summary AS
SELECT
  (SELECT jsonb_object_agg(table_name, (xpath('/row/c/text()',
    query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text::bigint)
    FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS counts,
  (SELECT coalesce(max(id), 0) FROM public.audit_outbox) AS max_audit_id,
  (SELECT jsonb_object_agg(name, (xpath('/row/d/text()', query_to_xml(format(
    'SELECT encode(sha256(convert_to(coalesce(string_agg(t::text, %L ORDER BY t::text COLLATE "C"), %L), %L)), %L) AS d FROM public.%I t',
    E'\n', '', 'UTF8', 'hex', name), false, true, '')))[1]::text)
    FROM unnest(string_to_array(current_setting('restore.security'), ' ')) AS name) AS security,
  current_setting('restore.previous')::jsonb AS previous;
DO $$
DECLARE
  s record;
BEGIN
  SELECT * INTO s FROM summary;
  IF s.previous <> '{}'::jsonb THEN
    IF EXISTS (SELECT FROM jsonb_each_text(s.previous->'counts') AS p(name, value)
        WHERE coalesce((s.counts->>p.name)::bigint, 0) < p.value::bigint)
      OR s.max_audit_id < (s.previous->>'max_audit_id')::bigint THEN
      RAISE EXCEPTION 'restore_counts_went_backwards';
    END IF;
  END IF;
END $$;
SELECT jsonb_build_object(
    'counts', counts, 'max_audit_id', max_audit_id, 'security', security,
    'changed', CASE WHEN previous <> '{}'::jsonb THEN coalesce((SELECT jsonb_agg(key ORDER BY key)
      FROM jsonb_each_text(security) AS c(key, value)
      WHERE previous->'security'->>key IS DISTINCT FROM value), '[]'::jsonb) END)::text
  FROM summary;
SQL
}

# The production re-check (backup and restore runbook, step 8), run on the
# production copy restored from the accepted object, before the gateway may
# start. It is the validation's own checks, fail-closed, against a reference
# server from the same images:
#   0. the file: the private copy restored in step 7 must hash to the
#      summary's sha256 (the database itself cannot show which file it came
#      from); and the hold: no gateway container, no gateway configuration
#      document, and no runtime password yet (the job-role comparison needs
#      that);
#   1. before migrating, the catalogs, then the integrity summary, which must
#      equal the accepted summary exactly (it is the same file);
#   2. the migrations, through sim-g-migrate (a backup first, then any
#      migrations and the grants);
#   3. after migrating, the ledger and the schema must equal the reference's,
#      and the runtime still has no password.
# Prints one JSON line: production_recheck_passed, or production_recheck_failed
# with a fixed reason. Exit 0 passed; 3 the copy failed a check (take the
# runbook's failure path: never reopen); 1 a precondition, an argument or a
# tool failed (fix it and rerun). Any non-zero status keeps the gateway down.
#
# What the summary proves: the per-table row counts, the highest audit
# identifier and the four security tables' digests, beside the catalogs,
# the schema and the ledger. Other tables' contents are not compared; the
# restore from the hashed private copy (step 7) is what binds them.
#
# On the VM (the settings wrapper exports SIM_G_PROJECT) the hold must also
# include the gateway drop-in, and the deploy-watch and recovery timers must
# be stopped. SIM_G_RECHECK_MIGRATE_SOCKET and SIM_G_RECHECK_GATEWAY_CONFIG
# are for the offline checks only and are refused on the VM. A migration
# failure the copy cannot cause (sim-g-migrate's busy lock, failed backup or
# Docker error, the settings wrapper), a check that fails because the server
# stopped answering, and a --previous that differs from step 5's exit 1,
# not 3.
# Once the migrations have run, a rerun needs a fresh restore (step 6).
recheck_fail() { # reason status
  printf '{"severity":"ERROR","msg":"production_recheck_failed","reason":"%s"}\n' "$1"
  exit "$2"
}
# A failed check counts against the copy only if the server still answers;
# otherwise it is a tool failure (a restarting or out-of-memory server).
copy_fail() { # reason
  docker exec "${production_server}" pg_isready -q >/dev/null 2>&1 ||
    recheck_fail production_server_unavailable 1
  recheck_fail "$1" 3
}
# The validator already migrated this very object forward, so a failure
# here is the environment's (sim-g-migrate's lock, its backup, Docker, the
# settings wrapper), never the copy's.
production_migrate() {
  if [[ -n "${SIM_G_RECHECK_MIGRATE_SOCKET:-}" ]]; then
    migrate_and_grant "${SIM_G_RECHECK_MIGRATE_SOCKET}"
  else
    systemctl start sim-g-migrate.service
  fi
}
runtime_password_unset() { # server
  [[ "$(superuser_sql "$1" "SELECT rolpassword IS NULL FROM pg_authid
    WHERE rolname = 'gateway_runtime'" postgres)" == t ]]
}
production_check() {
  : "${SIM_G_POSTGRES_IMAGE:?}" "${SIM_G_GATEWAY_IMAGE:?}"
  local summary_file="" dump_file="" previous="" previous_line="{}" server=sim-g-postgres
  local gateway_config="${SIM_G_RECHECK_GATEWAY_CONFIG:-/mnt/disks/data/sim-g/config/gateway.json}"
  local on_vm=false
  [[ -z "${SIM_G_PROJECT:-}" && ! -d /etc/sim-g/bin ]] || on_vm=true
  if [[ "${on_vm}" == true && -n "${SIM_G_RECHECK_MIGRATE_SOCKET:-}${SIM_G_RECHECK_GATEWAY_CONFIG:-}" ]]; then
    recheck_fail production_test_hook_refused 1
  fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --summary | --dump | --previous | --server)
        [[ $# -ge 2 ]] || recheck_fail production_input_missing 1
        case "$1" in
          --summary) summary_file="$2" ;;
          --dump) dump_file="$2" ;;
          --previous) previous="$2" ;;
          --server) server="$2" ;;
        esac
        shift 2
        ;;
      *) recheck_fail production_unexpected_argument 1 ;;
    esac
  done
  local image
  for image in "${SIM_G_POSTGRES_IMAGE}" "${SIM_G_GATEWAY_IMAGE}"; do
    [[ "${image}" =~ (^sha256:|@sha256:)[0-9a-f]{64}$ ]] || recheck_fail production_image_not_pinned 1
  done
  [[ "${server}" =~ ^[a-z0-9][a-z0-9_.-]{0,62}$ ]] || recheck_fail production_unexpected_argument 1
  production_server="${server}"
  [[ -f "${summary_file}" ]] || recheck_fail production_input_missing 1
  # The accepted summary, exactly as the validator printed it (an accepted
  # or owner-reviewed verdict), one line.
  local summary created_at digest stored
  summary="$(head -n 1 "${summary_file}")"
  [[ "$(wc -l <"${summary_file}" | tr -d ' ')" -le 1 ]] || recheck_fail production_summary_invalid 1
  local pattern='^\{"severity":"INFO","msg":"restore_check_completed","verdict":"(accepted|held_for_owner_review)","sha256":"([0-9a-f]{64})","created_at":([1-9][0-9]{0,11}),(.*)$'
  [[ "${summary}" =~ ${pattern} ]] || recheck_fail production_summary_invalid 1
  digest="${BASH_REMATCH[2]}"
  created_at="${BASH_REMATCH[3]}"
  stored="${BASH_REMATCH[4]}"
  if [[ -n "${previous}" ]]; then
    [[ -f "${previous}" ]] || recheck_fail production_input_missing 1
    previous_line="$(head -n 1 "${previous}")"
    [[ "${previous_line}" == '{"severity":"INFO","msg":"restore_check_completed",'* ]] ||
      recheck_fail production_previous_invalid 1
  fi

  # 0. The file, then the hold.
  [[ -f "${dump_file}" ]] || recheck_fail production_input_missing 1
  [[ "$(sha256 "${dump_file}")" == "${digest}" ]] || recheck_fail production_dump_mismatch 1
  local gateway
  gateway="$(docker ps --all --quiet --filter name='^/sim-g-gateway$')" ||
    recheck_fail production_docker_unavailable 1
  [[ -z "${gateway}" ]] || recheck_fail production_gateway_running 1
  [[ ! -e "${gateway_config}" ]] || recheck_fail production_gateway_config_present 1
  if [[ "${on_vm}" == true ]]; then
    [[ -f /run/systemd/system/sim-g-gateway.service.d/hold.conf ]] ||
      recheck_fail production_gateway_not_held 1
    local timer
    for timer in sim-g-deploy-watch.timer sim-g-recover.timer; do
      case "$(systemctl show --property ActiveState --value "${timer}" 2>/dev/null)" in
        inactive | failed) ;;
        *) recheck_fail production_timers_running 1 ;;
      esac
    done
  fi
  docker exec "${server}" pg_isready -q 2>/dev/null || recheck_fail production_server_unavailable 1
  runtime_password_unset "${server}" || recheck_fail production_runtime_password_set 1

  reference="sim-g-recheck-reference-$$-$(random_hex 4)"
  private="$(mktemp -d)"
  trap cleanup EXIT
  start_server "${reference}" || recheck_fail production_reference_failed 1
  migrate_and_grant "${reference}" || recheck_fail production_reference_failed 1
  local reference_ledger
  reference_ledger="$(superuser_sql "${reference}" "${ledger_query}")" || recheck_fail production_reference_failed 1
  [[ -n "${reference_ledger}" ]] || recheck_fail production_reference_failed 1
  local problem
  problem="$(previous_problem "${reference}" "${created_at}" "${digest}" "${previous_line}" 2>/dev/null)"
  [[ -z "${problem}" ]] || recheck_fail production_previous_invalid 1

  # 1. Before migrating: catalogs, then the same integrity summary.
  local findings result
  findings="$(catalog_findings "${server}" "${reference}")" || copy_fail production_inspection_failed
  [[ -z "${findings}" ]] || copy_fail production_catalog_rejected
  result="$(summarize "${server}" "${created_at}" "${digest}" "${previous_line}" 2>/dev/null)" ||
    copy_fail production_summary_mismatch
  [[ -n "${result}" ]] || copy_fail production_summary_mismatch
  if [[ "${result:1}" != "${stored}" ]]; then
    # Equal except "changed": the --previous given differs from step 5's.
    local without='s/"changed": *(null|\[[^]]*\]),? ?//'
    [[ "$(sed -E "${without}" <<<"${result:1}")" == "$(sed -E "${without}" <<<"${stored}")" ]] &&
      recheck_fail production_previous_mismatch 1
    copy_fail production_summary_mismatch
  fi

  # 2. The migrations, then 3: the ledger, the schema and the hold again.
  production_migrate >/dev/null 2>&1 || recheck_fail production_migration_failed 1
  local ledger
  ledger="$(superuser_sql "${server}" "${ledger_query}")" || copy_fail production_inspection_failed
  [[ -n "${ledger}" && "${ledger}" == "${reference_ledger}" ]] || copy_fail production_ledger_mismatch
  schema_of "${server}" >"${private}/production.sql" || copy_fail production_inspection_failed
  schema_of "${reference}" >"${private}/reference.sql" || recheck_fail production_reference_failed 1
  [[ -s "${private}/reference.sql" ]] || recheck_fail production_reference_failed 1
  cmp -s "${private}/production.sql" "${private}/reference.sql" || copy_fail production_schema_mismatch
  findings="$(catalog_findings "${server}" "${reference}")" || copy_fail production_inspection_failed
  [[ -z "${findings}" ]] || copy_fail production_catalog_rejected
  runtime_password_unset "${server}" || copy_fail production_runtime_password_set

  printf '{"severity":"INFO","msg":"production_recheck_passed","sha256":"%s","created_at":%s}\n' \
    "${digest}" "${created_at}"
  exit 0
}

main() {
  : "${SIM_G_POSTGRES_IMAGE:?}" "${SIM_G_GATEWAY_IMAGE:?}"
  [[ $# -ge 2 ]] || fail restore_input_missing
  local source="$1" identity="$2" created_at="" previous="" previous_line="{}"
  shift 2
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --created-at | --previous)
        [[ $# -ge 2 ]] || fail restore_input_missing
        if [[ "$1" == --created-at ]]; then created_at="$2"; else previous="$2"; fi
        shift 2
        ;;
      *) fail restore_unexpected_argument ;;
    esac
  done
  local image
  for image in "${SIM_G_POSTGRES_IMAGE}" "${SIM_G_GATEWAY_IMAGE}"; do
    [[ "${image}" =~ (^sha256:|@sha256:)[0-9a-f]{64}$ ]] || fail restore_image_not_pinned
  done
  [[ -f "${source}" && -f "${identity}" ]] || fail restore_input_missing
  [[ "${created_at}" =~ ^[1-9][0-9]{0,11}$ ]] || fail restore_created_at_invalid
  if [[ -n "${previous}" ]]; then
    [[ -f "${previous}" ]] || fail restore_input_missing
    previous_line="$(head -n 1 "${previous}")"
    [[ "${previous_line}" == '{"severity":"INFO","msg":"restore_check_completed",'* ]] ||
      fail restore_previous_invalid
  fi

  identity="$(cd "$(dirname "${identity}")" && pwd)/$(basename "${identity}")"
  # Decrypt as the key file's owner: the 0600 key stays readable without any
  # capability (GNU stat on the VM, BSD stat on macOS).
  local owner
  owner="$(stat -c '%u:%g' "${identity}" 2>/dev/null || stat -f '%u:%g' "${identity}")"

  local suffix
  suffix="$$-$(random_hex 4)"
  reference="sim-g-restore-reference-${suffix}"
  candidate="sim-g-restore-candidate-${suffix}"
  private="$(mktemp -d)"
  trap cleanup EXIT
  # One private copy: every later read is of this exact file.
  local dump="${private}/dump.age" digest
  cp "${source}" "${dump}" || fail restore_input_missing
  digest="$(sha256 "${dump}")"

  # The table of contents, read without any server. A dump that does not
  # decrypt is junk, not a forgery.
  local toc
  if ! toc="$(decrypt "${dump}" "${identity}" "${owner}" 2>/dev/null | list_archive 2>/dev/null)"; then
    decrypt "${dump}" "${identity}" "${owner}" >/dev/null 2>&1 || fail restore_decrypt_failed
    suspicious toc_unreadable
  fi

  start_server "${reference}" || fail restore_server_unavailable
  migrate_and_grant "${reference}" || fail restore_reference_failed
  local reference_toc reference_ledger unexpected
  reference_toc="$(docker exec -e PGOPTIONS="${pgoptions}" "${reference}" \
    pg_dump -U postgres --format=custom "${database}" | list_archive | toc_entries)" ||
    fail restore_reference_failed
  reference_ledger="$(superuser_sql "${reference}" "${ledger_query}")" || fail restore_reference_failed
  [[ -n "${reference_toc}" && -n "${reference_ledger}" ]] || fail restore_reference_failed
  unexpected="$(LC_ALL=C comm -23 <(printf '%s\n' "${toc}" | toc_entries) <(printf '%s\n' "${reference_toc}"))"
  [[ -z "${unexpected}" ]] || suspicious toc_rejected
  local problem
  problem="$(previous_problem "${reference}" "${created_at}" "${digest}" "${previous_line}" 2>/dev/null)"
  [[ -z "${problem}" ]] || fail "${problem}"

  start_server "${candidate}" || fail restore_server_unavailable
  # From here on, the dump has run: any failure it could cause is suspicious.
  if ! decrypt "${dump}" "${identity}" "${owner}" 2>/dev/null |
    as_migrator "${candidate}" "${SIM_G_POSTGRES_IMAGE}" pg_restore -h /run/postgresql \
      -U gateway_migrator -d "${database}" --no-owner --no-privileges --exit-on-error >/dev/null 2>&1; then
    suspicious restore_failed
  fi

  local findings
  findings="$(catalog_findings "${candidate}" "${reference}")" || suspicious inspection_failed
  [[ -z "${findings}" ]] || suspicious catalog_rejected

  local ledger result errors="${private}/errors"
  ledger="$(superuser_sql "${candidate}" "${ledger_query}")" || suspicious inspection_failed
  [[ -n "${ledger}" ]] || suspicious ledger_mismatch
  # A prefix: exactly the reference's first rows, with no gaps.
  [[ "$(printf '%s\n' "${reference_ledger}" | head -n "$(printf '%s\n' "${ledger}" | wc -l)")" == "${ledger}" ]] ||
    suspicious ledger_mismatch
  if ! result="$(summarize "${candidate}" "${created_at}" "${digest}" "${previous_line}" 2>"${errors}")"; then
    case "$(cat "${errors}")" in
      *restore_record_after_creation*) suspicious integrity_record_after_creation ;;
      *restore_counts_went_backwards*) suspicious integrity_counts_went_backwards ;;
      *) suspicious inspection_failed ;;
    esac
  fi

  # Forward to the image's migrations, then the same ledger and schema.
  migrate_and_grant "${candidate}" || suspicious forward_migration_failed
  ledger="$(superuser_sql "${candidate}" "${ledger_query}")" || suspicious inspection_failed
  [[ "${ledger}" == "${reference_ledger}" ]] || suspicious ledger_mismatch
  schema_of "${candidate}" >"${private}/candidate.sql" || suspicious inspection_failed
  schema_of "${reference}" >"${private}/reference.sql" || fail restore_reference_failed
  [[ -s "${private}/reference.sql" ]] || fail restore_reference_failed
  cmp -s "${private}/candidate.sql" "${private}/reference.sql" || suspicious schema_mismatch

  local verdict=accepted status=0
  [[ "${result}" =~ \"changed\":\ (null|\[[^]]*\]) ]] || suspicious inspection_failed
  if [[ "${BASH_REMATCH[1]}" != "[]" ]]; then
    verdict=held_for_owner_review status=2
  fi
  printf '{"severity":"INFO","msg":"restore_check_completed","verdict":"%s","sha256":"%s","created_at":%s,%s\n' \
    "${verdict}" "${digest}" "${created_at}" "${result:1}"
  exit "${status}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${1:-}" == --production-check ]]; then
    production_check "${@:2}"
  else
    main "$@"
  fi
fi
