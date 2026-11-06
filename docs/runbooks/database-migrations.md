# Database migrations

PostgreSQL stores gateway operational machinery only. Notion, Google Drive,
and approved GitHub repositories remain the knowledge systems of record. The
schema intentionally contains no provider-content mirror, search corpus, or
generic provider cache.

## Supported database and roles

- Use PostgreSQL 17.x.
- Bind local development PostgreSQL to loopback or a private Unix socket only.
- Use separate databases and credentials for development, test, and
  production.
- The migration role may own the gateway database and schema but must not be a
  PostgreSQL superuser and must have `NOCREATEDB`, `NOCREATEROLE`, and
  `NOREPLICATION`.
- A future production runtime role should receive only the table and sequence
  privileges needed by the gateway. Do not reuse the server administrator,
  migration, backup, or MCP inspection role at runtime.

Store passwords in macOS Keychain for local development and Secret Manager in
Google Cloud. Never put a connection URL in Git, documentation examples with a
real password, CI artifacts, or command output.

## Local test database

Create an isolated database named `family_brain_gateway_test`, owned by a login
role named `gateway_test`. The role must be non-superuser and have no database
or role administration privileges. Configure the cluster for SCRAM-SHA-256 and
listen only on loopback. Then place the connection URL in the environment for a
single command:

```bash
TEST_DATABASE_URL='postgresql://gateway_test:LOCAL_PASSWORD@127.0.0.1:55432/family_brain_gateway_test' pnpm db:migrate:test
TEST_DATABASE_URL='postgresql://gateway_test:LOCAL_PASSWORD@127.0.0.1:55432/family_brain_gateway_test' pnpm test:integration
```

The test command refuses a remote hostname, a database without the `_test`
suffix, or a username other than `gateway_test`. Tests truncate only the
approved operational tables and use fictional synthetic records.

## Applying migrations

For a non-test environment, inject `DATABASE_URL` at process launch and run:

```bash
pnpm db:migrate
```

The runner:

1. acquires a PostgreSQL advisory lock so only one migrator runs at a time;
2. validates filenames and rejects duplicate versions before executing SQL;
3. applies each new migration in its own transaction;
4. records its version, filename, and SHA-256 content hash; and
5. fails closed with `policy_drift` if an applied filename or body changes.

Running the command twice is safe and is a required CI check. Applied migration
files are immutable. Correct a deployed schema with a new forward migration;
never edit an applied file or delete its ledger row.

## Current schema boundary

The approved operational tables are:

- `principals` and `identity_bindings`;
- `operations` and `reconciliation_attempts`;
- `approval_requests` and `elevation_challenges`;
- `brain_record_aliases`;
- `policy_versions` and `project_registry_versions`; and
- `audit_outbox`.

`gateway_schema_migrations` is the migration ledger. Approval requests have no
time-based expiry. Elevation challenges bind a one-time token hash to the exact
operation, principal, fingerprint, policy version, and frozen targets. Migration
`000005` adds `superseded_at`: issuing a newer challenge for an operation
supersedes every older live challenge, and a consumed or superseded challenge
can never be consumed. Migration `000006` adds the nullable gateway
`creator_principal_id` to `brain_record_aliases` for records created through
`persist_knowledge`.

## Production procedure and recovery

Production migrations run as a private authenticated job with private database
connectivity. Before any migration that can rewrite or discard data, take and
verify the required backup/PITR recovery point, review locks and expected run
time, and prepare a forward repair migration. Do not expose Cloud SQL publicly
or run migrations from an operator laptop merely for convenience.

If a migration fails, its transaction rolls back and its version is not added
to the ledger. Diagnose the exact database error, correct the unapplied file,
and rerun. If a migration has already been recorded, preserve it and add a new
migration. Never manually erase production schema history.

## Compiled migration command (deployed image)

The gateway image ships `dist/migration-cli.js`. It runs as a one-shot
container of the **same image digest** as the gateway, after a fresh backup
and before the gateway restarts. It never runs at gateway startup.

```sh
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --network none --user 9002:9002 \
  -v <host socket directory>:/run/postgresql \
  -e GATEWAY_MIGRATION_DATABASE_URL \
  <image@sha256:...> node dist/migration-cli.js
```

- **Accepted URLs:** `GATEWAY_MIGRATION_DATABASE_URL` takes only two forms:
  - the local socket,
    `postgresql://gateway_migrator@/family_brain_gateway?host=/run/postgresql`,
    with peer or password authentication;
  - a loopback TCP host (`127.0.0.1` or `localhost`), for development and CI.

  Remote hosts, other socket directories, the retired `/cloudsql/` form,
  repeated keys, encoded hostnames and any query key other than `host`
  (socket) or `sslmode` (TCP) are refused.

- **Validation:** the URL is checked against what node-postgres will use.
  A role name is required. The command refuses to run (reason
  `postgres_environment_override_refused`) if any `PG*` variable is set, so
  the launcher's environment cannot change the role, session options or TLS
  behind the validated URL. TLS on the socket is refused.
- **Host path:** the host socket directory is a placeholder until F13c-5
  defines it.
- **One connection:** migrations take an advisory lock and refuse a migration
  file whose recorded content hash changed.
- **Output:** one JSON result line (the pool may add its fixed idle-client
  warning line):
  - `{"severity":"INFO","msg":"migrations_completed"}` with exit 0, or
  - `{"severity":"ERROR","msg":"migration_failed","reason":"<fixed>"}` with
    exit 1.

    It never prints the URL, a message or a cause. A PostgreSQL error reports
    only its SQLSTATE, as `sqlstate_<code>`; for example, `sqlstate_57014` is a
    statement timeout (each statement has 15 s, including waiting for the
    migration lock). For details, read the PostgreSQL server log on the VM.

- **Development:** `pnpm db:migrate` and `pnpm db:migrate:test` remain the
  checkout tools for local and CI databases.
