# Restore-validation cases (recovery point investigation, section 9), sourced
# by scripts/check-backup-roundtrip.sh after its backups. Uses its work
# directory, images, synthetic identity, source server and backup settings.
# Every case runs the real deploy/vm/backup/sim-g-restore-check.sh against
# local throwaway containers with fictional data.

gateway_id="$(docker image inspect --format '{{.Id}}' "${gateway_image}")"
validator=(env "SIM_G_POSTGRES_IMAGE=${postgres_image}" "SIM_G_GATEWAY_IMAGE=${gateway_id}"
  bash deploy/vm/backup/sim-g-restore-check.sh)
cases=0

# validate <dump> [options...]: sets ${result} and ${status}.
validate() {
  local dump="$1"
  shift
  set +e
  result="$("${validator[@]}" "${dump}" "${work}/identity.txt" "$@" 2>/dev/null)"
  status=$?
  set -e
}
field() { # path into ${result}, as JSON
  node -e 'const o = JSON.parse(process.argv[1]);
    const v = process.argv[2].split(".").reduce((a, k) => (a == null ? a : a[k]), o);
    process.stdout.write(JSON.stringify(v ?? null));' "${result}" "$1"
}
same_json() { # a b: equal as JSON values
  node -e 'const canon = (v) => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x);
    process.exit(canon(JSON.parse(process.argv[1])) === canon(JSON.parse(process.argv[2])) ? 0 : 1);' "$1" "$2"
}
expect() { # description condition...
  local description="$1"
  shift
  cases=$((cases + 1))
  if ! "$@"; then
    echo "restore validation: FAILED: ${description}" >&2
    echo "  status=${status} result=${result}" >&2
    exit 1
  fi
}
exited() { [[ "${status}" -eq "$1" ]]; }
is() { [[ "$(field "$1")" == "$2" ]]; }
rejected() { # status reason quarantine
  exited "$1" && is msg '"restore_check_failed"' && is reason "\"$2\"" && is quarantine "$3"
}
back_up() { # tier: prints the new object's path
  local before after
  before="$(find "${work}/uploads" -type f -name '*.dump.age' | sort)"
  # A new UTC second, so the object name is new.
  sleep 1
  env "${backup_env[@]}" bash deploy/vm/backup/sim-g-backup.sh "$1" >/dev/null
  after="$(find "${work}/uploads" -type f -name '*.dump.age' | sort)"
  comm -13 <(printf '%s\n' "${before}") <(printf '%s\n' "${after}") | head -1
}
now() { date -u +%s; }

# --- a genuine backup ------------------------------------------------------
daily_at="$(now)"
validate "${uploaded}" --created-at "${daily_at}"
expect "a genuine backup without a previous summary is held for review" exited 2
expect "its verdict says so" is verdict '"held_for_owner_review"'
expect "with no previous summary, nothing is compared" is changed null
expect "it restores every table's rows" same_json "$(field counts)" "${source_counts}"
expect "it pins the ciphertext by SHA-256" is sha256 "\"$( (sha256sum "${uploaded}" 2>/dev/null || shasum -a 256 "${uploaded}") | cut -d' ' -f1)\""
printf '%s\n' "${result}" >"${work}/summary-1.json"

validate "${uploaded}" --created-at "${daily_at}" --previous "${work}/summary-1.json"
expect "the same backup against its own summary is accepted" exited 0
expect "accepted, with nothing changed" is changed '[]'

recent_at="$(now)"
validate "${recent_upload}" --created-at "${recent_at}" --previous "${work}/summary-1.json"
expect "a later recent-tier backup on the same timeline is accepted" exited 0
expect "the recent backup restores every table's rows" same_json "$(field counts)" "${source_counts}"

# --- integrity --------------------------------------------------------------
validate "${uploaded}" --created-at 1000000000
expect "rows newer than the object's creation time are suspicious" \
  rejected 3 integrity_record_after_creation true
sed 's/"principals": 3/"principals": 9/' "${work}/summary-1.json" >"${work}/summary-more.json"
validate "${uploaded}" --created-at "${daily_at}" --previous "${work}/summary-more.json"
expect "counts below the previous accepted backup are suspicious" \
  rejected 3 integrity_counts_went_backwards true
sed 's/"principals": 3/"principals": "three"/' "${work}/summary-1.json" >"${work}/summary-text.json"
validate "${uploaded}" --created-at "${daily_at}" --previous "${work}/summary-text.json"
expect "a previous summary with a non-numeric count is refused, not quarantined" \
  rejected 1 restore_previous_invalid false
sed 's/"principals": 3/"principals": 3.5/' "${work}/summary-1.json" >"${work}/summary-fraction.json"
validate "${uploaded}" --created-at "${daily_at}" --previous "${work}/summary-fraction.json"
expect "a previous summary with a fractional count is refused, not quarantined" \
  rejected 1 restore_previous_invalid false
sed 's/"max_audit_id": [0-9]*/"max_audit_id": 1e30/' "${work}/summary-1.json" >"${work}/summary-huge.json"
validate "${uploaded}" --created-at "${daily_at}" --previous "${work}/summary-huge.json"
expect "a previous summary with an out-of-range audit identifier is refused, not quarantined" \
  rejected 1 restore_previous_invalid false
sed "s/\"created_at\":${daily_at}/\"created_at\":$((daily_at + 86400))/" "${work}/summary-1.json" \
  >"${work}/summary-later.json"
validate "${uploaded}" --created-at "${daily_at}" --previous "${work}/summary-later.json"
expect "a previous summary created later is refused, not quarantined" \
  rejected 1 restore_previous_not_earlier false

# --- security-relevant state ------------------------------------------------
runtime_sql "INSERT INTO identity_bindings (id, principal_id, issuer, external_subject, email)
  VALUES ('idb_check_steward', 'prn_steward', 'https://accounts.google.com', 'synthetic-subject-steward', 'steward@example.invalid')" >/dev/null
binding="$(back_up daily)"
validate "${binding}" --created-at "$(now)" --previous "${work}/summary-1.json"
expect "a new identity binding is held for owner review" exited 2
expect "the change names the table, not its contents" is changed '["identity_bindings"]'
expect "the held summary never prints a binding" bash -c '[[ $0 != *steward* && $0 != *synthetic-subject* ]]' "${result}"
# The owner accepts the new binding: its summary is the next on the timeline.
printf '%s\n' "${result}" >"${work}/summary-2.json"

# --- planted objects ---------------------------------------------------------
docker run --rm --network none --user 9002:9002 -v "${socket}:/run/postgresql" "${postgres_image}" \
  psql -q -v ON_ERROR_STOP=1 -h /run/postgresql -U gateway_migrator -d family_brain_gateway \
  -c 'CREATE FUNCTION public.synthetic_planted() RETURNS integer LANGUAGE sql AS $$SELECT 1$$' >/dev/null
planted="$(back_up recent)"
docker run --rm --network none --user 9002:9002 -v "${socket}:/run/postgresql" "${postgres_image}" \
  psql -q -v ON_ERROR_STOP=1 -h /run/postgresql -U gateway_migrator -d family_brain_gateway \
  -c 'DROP FUNCTION public.synthetic_planted()' >/dev/null
validate "${planted}" --created-at "$(now)" --previous "${work}/summary-1.json"
expect "a dump that creates a function is quarantined" rejected 3 toc_rejected true

# A forged archive whose function entry is labelled as an existing table: it
# passes the table-of-contents pre-filter, so only the catalog inspection
# can catch it. A piped dump has no data offsets, so relabelling its
# length-prefixed strings keeps the archive valid.
# forge <out> [sql]: the planted dump with its function entry relabelled as
# the existing table principals, and its SQL optionally replaced. Strings in
# the archive are a sign byte, a 4-byte little-endian length and the bytes.
forge() {
  docker run --rm -i --network none --user "$(id -u):$(id -g)" \
    --mount "type=bind,source=${work}/identity.txt,target=/run/age-identity,readonly" \
    "${postgres_image}" age --decrypt --identity /run/age-identity <"${planted}" >"${work}/forged.dump"
  node -e '
    const fs = require("node:fs");
    const [file, sql] = process.argv.slice(1);
    const str = (s) => Buffer.concat([Buffer.from([0]), Buffer.from(new Uint32Array([Buffer.byteLength(s)]).buffer), Buffer.from(s)]);
    let data = fs.readFileSync(file);
    const swap = (find, to) => {
      const at = data.indexOf(find);
      if (at < 5 || data[at - 5] !== 0) throw new Error(`no ${find} string`);
      const end = at + data.readUInt32LE(at - 4);
      data = Buffer.concat([data.subarray(0, at - 5), str(to), data.subarray(end)]);
    };
    swap("FUNCTION", "TABLE");
    swap("synthetic_planted()", "principals");
    if (sql) swap("CREATE FUNCTION public.synthetic_planted()", sql);
    fs.writeFileSync(file, data);' "${work}/forged.dump" "${2:-}"
  docker run --rm -i --network none "${postgres_image}" age --encrypt --recipient "${recipient}" \
    <"${work}/forged.dump" >"$1"
  rm -f "${work}/forged.dump"
}
forge "${work}/relabelled.age"
validate "${work}/relabelled.age" --created-at "$(now)" --previous "${work}/summary-1.json"
expect "a function relabelled as a table passes the pre-filter but not the catalog" \
  rejected 3 catalog_rejected true

# Forgeries aimed at the validator's own superuser inspection (the restored
# database's owner is the migrator, who can set database settings).
shadow='CREATE FUNCTION public.concat_ws(text, VARIADIC text[]) RETURNS text LANGUAGE sql AS $f$SELECT $$$$::text$f$;'
forge "${work}/shadow.age" "${shadow}"
validate "${work}/shadow.age" --created-at "$(now)" --previous "${work}/summary-1.json"
expect "a function shadowing the inspection's own builtins is still found" rejected 3 catalog_rejected true
forge "${work}/path.age" "ALTER DATABASE family_brain_gateway SET search_path = public, pg_catalog; ${shadow}"
validate "${work}/path.age" --created-at "$(now)" --previous "${work}/summary-1.json"
expect "a database search_path planted for the superuser is found" rejected 3 catalog_rejected true
forge "${work}/timeout.age" 'ALTER DATABASE family_brain_gateway SET statement_timeout = 1;'
validate "${work}/timeout.age" --created-at "$(now)" --previous "${work}/summary-1.json"
expect "a timeout planted to break the inspection is suspicious, not a tool fault" \
  rejected 3 catalog_rejected true
forge "${work}/locked.age" 'ALTER DATABASE family_brain_gateway CONNECTION LIMIT 0;'
validate "${work}/locked.age" --created-at "$(now)" --previous "${work}/summary-1.json"
expect "a connection limit planted on the database is found" rejected 3 catalog_rejected true
forge "${work}/granted.age" 'GRANT CREATE, TEMPORARY ON DATABASE family_brain_gateway TO gateway_runtime;'
validate "${work}/granted.age" --created-at "$(now)" --previous "${work}/summary-1.json"
expect "a database grant the dump gives the runtime is found" rejected 3 catalog_rejected true
forge "${work}/password.age" 'ALTER ROLE gateway_migrator PASSWORD $$synthetic$$;'
validate "${work}/password.age" --created-at "$(now)" --previous "${work}/summary-1.json"
expect "a job role changed by the dump is found" rejected 3 catalog_rejected true
forge "${work}/lob.age" 'SELECT pg_catalog.lo_create(0);'
validate "${work}/lob.age" --created-at "$(now)" --previous "${work}/summary-1.json"
expect "a large object created by the dump is found" rejected 3 catalog_rejected true
forge "${work}/broken.age" 'SELECT 1 / 0;'
validate "${work}/broken.age" --created-at "$(now)" --previous "${work}/summary-1.json"
expect "a dump that decrypts but does not restore is quarantined (ruling)" rejected 3 restore_failed true

# The catalog inspection itself, which a mislabelled archive entry cannot
# hide from: a clean copy passes, and each planted kind is found.
(
  # shellcheck source=/dev/null
  source deploy/vm/backup/sim-g-restore-check.sh
  SIM_G_POSTGRES_IMAGE="${postgres_image}" SIM_G_GATEWAY_IMAGE="${gateway_id}"
  reference="sim-g-restore-catalog-check-$$"
  trap cleanup EXIT
  start_server "${reference}" && migrate_and_grant "${reference}"
  [[ -z "$(catalog_findings "${reference}")" ]] || { echo "restore validation: FAILED: a clean catalog" >&2; exit 1; }
  plant() { # sql expected-kind
    superuser_sql "${reference}" "$1" >/dev/null
    [[ "$(catalog_findings "${reference}")" == *"$2"* ]] ||
      { echo "restore validation: FAILED: catalog misses a planted $2" >&2; exit 1; }
  }
  plant 'ALTER ROLE gateway_migrator SET work_mem = $$8MB$$' setting
  superuser_sql "${reference}" 'ALTER ROLE gateway_migrator RESET ALL' >/dev/null
  plant 'CREATE FUNCTION public.f() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$' function
  plant 'CREATE TRIGGER t BEFORE INSERT ON public.principals FOR EACH ROW EXECUTE FUNCTION public.f()' trigger
  plant 'CREATE RULE r AS ON UPDATE TO public.policy_versions DO INSTEAD NOTHING' rule
  plant 'CREATE POLICY p ON public.principals USING (true)' policy
  plant 'CREATE EXTENSION pgcrypto SCHEMA public' extension
  plant 'CREATE FUNCTION public.e() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN END$$' function
  plant 'CREATE EVENT TRIGGER et ON ddl_command_start EXECUTE FUNCTION public.e()' event_trigger
  plant 'CREATE SCHEMA planted' schema
  plant 'CREATE DOMAIN public.d AS integer' type
  plant 'CREATE TABLE public.foreign_owned (x integer)' owner
  plant "ALTER DATABASE family_brain_gateway SET search_path = planted, public" setting
)
cases=$((cases + 13))

# --- broken and foreign inputs -----------------------------------------------
cp "${uploaded}" "${work}/corrupted.age"
size="$(wc -c <"${work}/corrupted.age" | tr -d ' ')"
printf '\x00' | dd of="${work}/corrupted.age" bs=1 seek=$((size / 2)) conv=notrunc 2>/dev/null
validate "${work}/corrupted.age" --created-at "${daily_at}"
expect "a dump that does not decrypt is junk, not quarantined" rejected 1 restore_decrypt_failed false
printf 'not a pg_dump archive\n' | docker run --rm -i --network none "${postgres_image}" \
  age --encrypt --recipient "${recipient}" >"${work}/foreign.age"
validate "${work}/foreign.age" --created-at "${daily_at}"
expect "a decryptable non-archive is quarantined" rejected 3 toc_unreadable true
validate "${uploaded}"
expect "the creation time is required" rejected 1 restore_created_at_invalid false
validate "${uploaded}" --created-at 0123
expect "a zero-padded creation time is refused" rejected 1 restore_created_at_invalid false
validate "${uploaded}" --created-at "${daily_at}" --keep-going
expect "an unknown option is refused" rejected 1 restore_unexpected_argument false

# --- a genuine dump of several MiB ---------------------------------------------
# Listing stops at the table of contents; the rest of the stream must still
# be read, or a large genuine dump looks like a broken one.
runtime_sql "INSERT INTO audit_outbox (event)
  SELECT jsonb_build_object('type', 'synthetic_bulk', 'blob',
    (SELECT string_agg(md5(random()::text || g || i), '') FROM generate_series(1, 8) AS i))
  FROM generate_series(1, 60000) AS g" >/dev/null
large="$(back_up daily)"
expect "the large synthetic dump is over 5 MiB" test "$(wc -c <"${large}" | tr -d ' ')" -gt 5242880
validate "${large}" --created-at "$(now)" --previous "${work}/summary-2.json"
expect "a genuine dump of several MiB is accepted" exited 0

# --- the schema ------------------------------------------------------------------
# A backup missing one index: its table of contents, catalog and ledger all
# pass, so only the comparison with the reference catches it.
docker exec "${db}" psql -q -v ON_ERROR_STOP=1 -U postgres -d family_brain_gateway -c "
  DROP INDEX operations_state_updated_at_idx" >/dev/null
unindexed="$(back_up daily)"
docker exec "${db}" psql -q -v ON_ERROR_STOP=1 -U postgres -d family_brain_gateway -c "
  CREATE INDEX operations_state_updated_at_idx ON operations (state, updated_at)" >/dev/null
validate "${unindexed}" --created-at "$(now)" --previous "${work}/summary-2.json"
expect "a schema that differs from the reference is quarantined" rejected 3 schema_mismatch true

# --- the migration ledger ------------------------------------------------------
# A genuine older backup: the last migration not yet applied.
docker exec "${db}" psql -q -v ON_ERROR_STOP=1 -U postgres -d family_brain_gateway -c "
  DELETE FROM gateway_schema_migrations WHERE version = '000006';
  ALTER TABLE brain_record_aliases DROP COLUMN creator_principal_id" >/dev/null
older="$(back_up daily)"
# Its ledger is shorter than any newer summary's, so it is checked without
# one: held only for the missing previous summary.
validate "${older}" --created-at "$(now)"
expect "a genuine older backup passes as a prefix and migrates forward" exited 2
expect "it is held only because there is no previous summary" is changed null
# The same older backup validated an hour after it was made: the ledger rows
# that migrating forward adds carry the validation time, not the backup's.
docker exec "${db}" psql -q -v ON_ERROR_STOP=1 -U postgres -d family_brain_gateway -c "
  DO \$\$
  DECLARE c record;
  BEGIN
    FOR c IN SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'timestamp with time zone'
    LOOP
      EXECUTE format('UPDATE public.%I SET %I = %I - interval ''2 hours''', c.table_name, c.column_name, c.column_name);
    END LOOP;
  END \$\$" >/dev/null
backdated="$(back_up daily)"
validate "${backdated}" --created-at "$(($(now) - 3600))"
expect "a genuine older backup validated an hour later is not suspicious" exited 2
# An extra ledger row, which migration itself ignores: only the comparison
# with the reference catches it.
docker exec "${db}" psql -q -v ON_ERROR_STOP=1 -U postgres -d family_brain_gateway -c "
  INSERT INTO gateway_schema_migrations (version, filename, content_hash)
  VALUES ('999999', '999999_synthetic_extra.sql', repeat('0', 64))" >/dev/null
extra="$(back_up daily)"
validate "${extra}" --created-at "$(now)" --previous "${work}/summary-2.json"
expect "an extra ledger row is quarantined" rejected 3 ledger_mismatch true
docker exec "${db}" psql -q -v ON_ERROR_STOP=1 -U postgres -d family_brain_gateway -c "
  DELETE FROM gateway_schema_migrations WHERE version = '999999'" >/dev/null
# A tampered ledger: an applied migration whose checksum changed.
docker exec "${db}" psql -q -v ON_ERROR_STOP=1 -U postgres -d family_brain_gateway -c "
  UPDATE gateway_schema_migrations SET content_hash = repeat('0', 64) WHERE version = '000001'" >/dev/null
tampered="$(back_up daily)"
validate "${tampered}" --created-at "$(now)" --previous "${work}/summary-2.json"
expect "a tampered migration ledger is quarantined" rejected 3 ledger_mismatch true

echo "restore validation passed: ${cases} cases"
