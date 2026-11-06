# Production re-check cases (backup and restore runbook, step 8), sourced by
# scripts/check-backup-roundtrip.sh after the restore-validation cases. A
# throwaway server stands in for production PostgreSQL: the accepted object
# is restored into it as the migrator, as in step 7, then the real
# `sim-g-restore-check.sh --production-check` must pass a faithful copy and
# fail closed on everything else. Fictional data only.

prod=sim-g-check-production
recheck=(env "SIM_G_POSTGRES_IMAGE=${postgres_image}" "SIM_G_GATEWAY_IMAGE=${gateway_id}"
  "SIM_G_RECHECK_MIGRATE_SOCKET=${prod}" "SIM_G_RECHECK_GATEWAY_CONFIG=${work}/gateway.json"
  bash deploy/vm/backup/sim-g-restore-check.sh --production-check --server "${prod}")
checks=0

# A fresh "production" server with the accepted object restored, as in
# step 7: bootstrapped roles, no runtime password, then pg_restore.
restore_production() { # dump
  docker rm -f "${prod}" >/dev/null 2>&1 || true
  docker volume rm -f "${prod}" >/dev/null 2>&1 || true
  (
    # shellcheck source=deploy/vm/backup/sim-g-restore-check.sh
    source deploy/vm/backup/sim-g-restore-check.sh
    SIM_G_POSTGRES_IMAGE="${postgres_image}"
    start_server "${prod}"
  ) || { echo "production check: the stand-in server did not start" >&2; exit 1; }
  docker run --rm -i --network none --read-only --user "$(id -u):$(id -g)" --log-driver none \
    --mount "type=bind,source=${work}/identity.txt,target=/run/age-identity,readonly" \
    "${postgres_image}" age --decrypt --identity /run/age-identity <"$1" |
    docker run --rm -i --network none --read-only --cap-drop=ALL --user 9002:9002 --log-driver none \
      -v "${prod}:/run/postgresql" "${postgres_image}" pg_restore -h /run/postgresql \
      -U gateway_migrator -d family_brain_gateway --no-owner --no-privileges --exit-on-error
}
prod_sql() { # sql [database]
  docker exec "${prod}" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "${2:-family_brain_gateway}" -tA -c "$1"
}
recheck_run() { # summary [options...]: sets ${result} and ${status}
  local summary="$1"
  shift
  set +e
  result="$("${recheck[@]}" --summary "${summary}" --dump "${dump:-${uploaded}}" "$@" 2>/dev/null)"
  status=$?
  set -e
}
assert() { # description condition...
  local description="$1"
  shift
  checks=$((checks + 1))
  if ! "$@"; then
    echo "production check: FAILED: ${description}" >&2
    echo "  status=${status} result=${result}" >&2
    exit 1
  fi
}
passed() { [[ "${status}" -eq 0 && "${result}" == '{"severity":"INFO","msg":"production_recheck_passed",'* ]]; }
refused() { # status reason
  [[ "${status}" -eq "$1" && "${result}" == "{\"severity\":\"ERROR\",\"msg\":\"production_recheck_failed\",\"reason\":\"$2\"}" ]]
}
summary="${work}/summary-1.json"

# --- a faithful copy passes --------------------------------------------------
restore_production "${uploaded}"
recheck_run "${summary}"
assert "a faithful production copy passes" passed
assert "it names the accepted ciphertext" bash -c '[[ $0 == *"\"sha256\":\"$1\""* ]]' "${result}" \
  "$(sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p' "${summary}")"
assert "it migrated and granted the copy" test "$(prod_sql "SELECT has_table_privilege('gateway_runtime', 'public.operations', 'INSERT')")" == t
recheck_run "${summary}"
assert "a second run on a copy with nothing to migrate still passes" passed

# --- the hold ------------------------------------------------------------------
restore_production "${uploaded}"
prod_sql "ALTER ROLE gateway_runtime PASSWORD 'synthetic-runtime-password'" postgres >/dev/null
recheck_run "${summary}"
assert "a runtime password already set is refused" refused 1 production_runtime_password_set
assert "it migrated nothing" test "$(prod_sql "SELECT has_table_privilege('gateway_runtime', 'public.operations', 'INSERT')")" == f
prod_sql "ALTER ROLE gateway_runtime PASSWORD NULL" postgres >/dev/null
printf '{}\n' >"${work}/gateway.json"
recheck_run "${summary}"
assert "a gateway configuration document present is refused" refused 1 production_gateway_config_present
rm -f "${work}/gateway.json"

# --- the accepted summary --------------------------------------------------------
printf 'not a summary\n' >"${work}/bad-summary.json"
recheck_run "${work}/bad-summary.json"
assert "a malformed summary is refused" refused 1 production_summary_invalid
sed 's/"verdict":"[a-z_]*"/"verdict":"quarantined"/' "${summary}" >"${work}/bad-summary.json"
recheck_run "${work}/bad-summary.json"
assert "a summary without an accepted verdict is refused" refused 1 production_summary_invalid
{ cat "${summary}"; printf 'extra\n'; } >"${work}/bad-summary.json"
recheck_run "${work}/bad-summary.json"
assert "a summary with a second line is refused" refused 1 production_summary_invalid
sed "s/\"sha256\":\"[0-9a-f]*\"/\"sha256\":\"$(printf '%064d' 0)\"/" "${summary}" >"${work}/other-summary.json"
recheck_run "${work}/other-summary.json"
assert "a summary of another file than the one restored is refused" refused 1 production_dump_mismatch
dump="${recent_upload}"
recheck_run "${summary}"
assert "a restored file that is not the accepted one is refused" refused 1 production_dump_mismatch
unset dump
sed 's/"principals": 3/"principals": 4/' "${summary}" >"${work}/other-summary.json"
recheck_run "${work}/other-summary.json"
assert "a summary of other contents fails" refused 3 production_summary_mismatch
recheck_run "${summary}" --unexpected
assert "an unexpected argument is refused" refused 1 production_unexpected_argument
recheck_run "${summary}" --previous "${summary}"
assert "a --previous other than step 5's is an argument error, not a bad copy" refused 1 production_previous_mismatch
docker create --name sim-g-gateway "${postgres_image}" true >/dev/null
recheck_run "${summary}"
assert "a gateway container, even stopped, is refused" refused 1 production_gateway_running
docker rm -f sim-g-gateway >/dev/null
set +e
result="$(env SIM_G_PROJECT=synthetic-gateway-dev "${recheck[@]}" --summary "${summary}" --dump "${uploaded}" 2>/dev/null)"
status=$?
set -e
assert "the test-only hooks are refused on the VM" refused 1 production_test_hook_refused

# --- a copy that is not the accepted object -------------------------------------
prod_sql "UPDATE public.principals SET display_name = display_name || ' (changed)'
  WHERE id = (SELECT min(id) FROM public.principals)" >/dev/null
recheck_run "${summary}"
assert "a changed security-relevant row fails" refused 3 production_summary_mismatch
assert "a failed copy is never migrated" test "$(prod_sql "SELECT has_table_privilege('gateway_runtime', 'public.operations', 'INSERT')")" == f

restore_production "${uploaded}"
prod_sql "INSERT INTO public.audit_outbox (event) VALUES (jsonb_build_object('type', 'synthetic_extra'))" >/dev/null
recheck_run "${summary}"
assert "an extra row fails" refused 3 production_summary_mismatch

restore_production "${uploaded}"
docker run --rm -i --network none --read-only --cap-drop=ALL --user 9002:9002 --log-driver none \
  -v "${prod}:/run/postgresql" "${postgres_image}" psql -X -q -v ON_ERROR_STOP=1 -h /run/postgresql \
  -U gateway_migrator -d family_brain_gateway -c "
    CREATE FUNCTION public.synthetic_planted() RETURNS int LANGUAGE sql AS 'SELECT 1'" >/dev/null
recheck_run "${summary}"
assert "a planted function fails" refused 3 production_catalog_rejected

restore_production "${uploaded}"
prod_sql "ALTER ROLE gateway_backup CREATEROLE" postgres >/dev/null
recheck_run "${summary}"
assert "an escalated job role fails" refused 3 production_catalog_rejected

restore_production "${uploaded}"
prod_sql "ALTER TABLE public.operations ADD COLUMN synthetic_extra text" >/dev/null
recheck_run "${summary}"
assert "a schema the migrations do not produce fails after migrating" refused 3 production_schema_mismatch

restore_production "${uploaded}"
recheck=("${recheck[@]/SIM_G_RECHECK_MIGRATE_SOCKET=${prod}/SIM_G_RECHECK_MIGRATE_SOCKET=sim-g-check-missing-socket}")
recheck_run "${summary}"
assert "a failed migration fails closed, as the environment's failure" refused 1 production_migration_failed
docker volume rm -f sim-g-check-missing-socket >/dev/null 2>&1 || true

# A server that stops answering mid-check is a tool failure, not a bad copy.
restore_production "${uploaded}"
recheck=("${recheck[@]/SIM_G_RECHECK_MIGRATE_SOCKET=sim-g-check-missing-socket/SIM_G_RECHECK_MIGRATE_SOCKET=${prod}}")
docker stop "${prod}" >/dev/null
recheck_run "${summary}"
assert "a server that is gone fails as unavailable, not as the copy" refused 1 production_server_unavailable

docker rm -f "${prod}" >/dev/null 2>&1 || true
docker volume rm -f "${prod}" >/dev/null 2>&1 || true
echo "production re-check passed: ${checks} cases"
