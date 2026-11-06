# Runtime configuration

> **Hosting note (2026-10-24).** Cloud Run references below describe the
> earlier deployment target. Production is now one Compute Engine `e2-micro`
> (PLAN Task 13). F13c revisits the production defaults that assumed Cloud Run:
> `GATEWAY_TRUSTED_PROXY_HOPS` 1, `GATEWAY_HOST` `0.0.0.0`, and the shutdown
> grace period. Until then, set them explicitly for the VM's actual ingress.

The gateway is configured by one JSON document validated by
`parseEnvironment` (`src/config/environment.ts`) and loaded by
`loadEnvironmentConfig` (`src/runtime/configuration.ts`). The document holds
only references and handles, never secret values.

## Loading

`loadEnvironmentConfig(path)` reads the document, rejects anything over
64 KiB, tolerates a leading byte-order mark, parses JSON and validates the
strict schema. Load failures carry a fixed, path-free reason and never the
content or cause: `environment_configuration_unreadable`,
`environment_configuration_too_large` or `environment_configuration_malformed`
(`invalid_request`). An invalid shape fails with
`invalid_environment_configuration`. A value scoped to another environment
fails with `environment_boundary_violation` and only the offending field paths
(for example `providers.notion.credential`).

## Sections

- `environment`: `development`, `test` or `production`. Every scoped reference,
  handle and machine identity in the document must name the same environment.
- `secrets`: where credential handles resolve.
  - `{"provider": "environment", "bindings": {handle: ENV_VAR}}`, allowed for
    `development` and `test` only. Environment variable names are upper case.
  - `{"provider": "google_secret_manager", "projectNumber": "<number>",
"bindings": {handle: secretId}}`, allowed for `development` and
    `production`. The project number (not the project ID) is required. See the
    [Secret Manager runbook](google-secret-manager.md). Nothing in the document
    ties the project number to the environment: a development document naming
    the production project would parse. Give each environment its own project
    and a runtime identity that can read only that project's bound secrets;
    that IAM boundary, not the configuration, keeps development from reading
    production secrets.

  The bindings must cover exactly the secret-backed handles: the database
  connection secret, and every provider credential whose `kind` is `secret`. A
  missing or extra binding is rejected. `workload_identity` credentials (such
  as Drive) need no binding.

- `server`: `port` and `logLevel`.
- `database.connectionSecret`: the handle whose secret is the PostgreSQL URL.
  `resolveDatabaseUrl` never echoes the value and accepts two
  `postgresql:`/`postgres:` forms only:
  - **The local PostgreSQL socket** on the same VM:
    `user:password@/database?host=/run/postgresql`, with no TCP host (e2-micro
    design section 6).
    - `/run/postgresql` is the only accepted socket directory, and `host` is
      the only allowed query key.
    - A database name is required, and so are a role and password in
      `production` (SCRAM over the socket).
    - The retired Cloud Run `/cloudsql/` form is refused.
  - **TCP to a named host**, with `sslmode=verify-full`.
    - Outside `production`, a loopback host (`127.0.0.1` or `localhost`; IPv6 literal hosts are not accepted)
      may omit TLS.
    - `sslmode` is the only allowed query key, so `require` and `verify-ca`
      (accepted only through a client deprecation alias), `ssl`,
      `uselibpqcompat` and certificate files are refused.

  Also refused, in either form:
  - any repeated query key, any malformed `%` escape, whitespace or control
    character;
  - a percent-encoded hostname (which the client would decode to a socket
    path);
  - surrounding whitespace.

  After parsing, the URL is checked against what node-postgres itself will
  use, its host and TLS settings, so the validator and the client cannot
  disagree about either. The client also reads `PG*` environment variables
  for anything the URL omits (port, user, session options), so `main`
  refuses to start when any is set (`postgres_environment_override_refused`).

- `identity`: the Google OIDC `issuer`, `audience` and Workspace `hostedDomain`
  for `createIdentityProvider`.
- `policy`: references to the executable policy, the canonical governance
  source and the project registry.
- `providers`: dedicated machine identities and credentials for Notion, Drive
  and the read-only GitHub App. Credential handles and machine identities must be
  unique across providers. The Notion credential must be a `secret`; the Drive
  credential must be a `workload_identity`.
  - `notion.roots` and `drive.roots`: one governed root per
    registered container (so at most three per provider) (`family_shared`, `parent_and_stewardship` or
    `protected`). Each names its container, never a scope, plus its provider
    object (a Notion `page` or `data_source` ID; a Drive folder and optional
    shared-drive ID) and a display path. The root's scope, sensitivity and
    protected class come only from the executable policy. `legalHold: true` is
    allowed only on a `protected` root and only tightens it to `legal_hold`.
    The generic `restricted` container is not accepted.
  - Notion `mutationPropertyIds` (title, operation marker, content type and
    content hash) make a `data_source` root a create target. At least one is
    required, and they are not allowed on page roots.
  - `notion.familyInbox`: the Family Inbox data source, its nine property IDs
    and six status option IDs, all distinct.

  `createRuntimeProviders` (`src/runtime/providers.ts`) builds the adapters:
  - the Notion token is resolved only through the configured secret handle;
  - Drive uses the injected workload-identity auth;
  - surfaces are registered only for the configured containers;
  - GitHub is `UnregisteredGitHubProvider` until the Project Registry is bound;
  - at startup it walks each root's ancestry and refuses (`invalid_root_nesting`)
    a less restrictive root inside a more restrictive one, ranking
    `legal_hold`, then legal or protected, then parents, then Family Shared. A
    walk stops at the first configured ancestor (whose own walk covers the rest)
    and retries a transient provider failure at most twice;
  - a Drive root folder must be on its configured shared drive.

  Notion IDs may be written dashed or undashed in any case; they are
  canonicalised to Notion's dashed lower-case form, so a root can never fail to
  match because of how its ID was written.

  **Onboarding decision (owner):** an ancestor the Notion integration or the
  Drive workload identity cannot see fails
  startup closed (`root_ancestry_unavailable`) rather than being treated as the
  top of the tree. With least-privilege sharing (only the root pages or folders shared with
  the machine identity) startup will fail until either each root's ancestry is
  made visible to it, or the owner accepts treating an invisible
  ancestor as the top. That is unsafe only if access was explicitly removed from
  an intermediate page and re-granted below it. Decide this before live roots
  are configured.

  `legalHold: true` on the single `protected` root makes everything in it
  immutable, including protected records that are not evidence and new records
  created there (they cannot be corrected afterwards). Use it only for a root
  that holds original evidence.

## Policy bundle

`loadVerifiedPolicyBundle(directory)` requires a directory URL ending in `/`, reads `family-brain-v1.yaml`,
`governance-lock.json`, `project-registry.yaml` and `project-registry-lock.json`
and verifies their hashes and versions against the locks. Any mismatch fails
with `policy_drift`.

## Database pool

`createDatabasePool(url)` uses the shared bounded pool settings: at most 10
connections, a 5 s connection timeout, a 30 s idle timeout and a 15 s statement
timeout. It connects lazily.

## Running the gateway

`node dist/cli.js` (`pnpm start` after `pnpm build`) runs `main()` and exits
the process with its status:

1. Read `GATEWAY_CONFIG_PATH` (required) and load the configuration.
2. Verify the policy bundle in `config/policy/` (relative to the working
   directory).
3. Create the secret provider. Only the `environment` provider receives the
   process environment, and only the bound variables are read.
4. Resolve the database URL and create the pool.
5. Build the Google OIDC verifier, the Drive workload auth and the governed
   provider adapters.
6. Compose the audited gateway, wiring in the Cloud Logging telemetry sink, and
   serve until `SIGTERM` or `SIGINT`.
7. Once listening, run in-process audit delivery: bounded outbox passes
   (batches of 100) through the Cloud Logging audit sink. Passes run back to
   back while a full batch is delivered cleanly, otherwise every 5 s. A failed
   pass logs
   `{"severity":"WARNING","msg":"audit_delivery_failed","reason":"<fixed>"}`;
   a pass that deferred events logs `audit_delivery_deferred` with integer
   `failed` and `lostClaims` counts only. Both wait for the next interval. On
   shutdown delivery stops before the pool closes. An event mid-delivery is
   marked for retry; its bytes may already have been written, so delivery is
   at least once. Undelivered events stay in PostgreSQL for the next process.

It never runs migrations. Every startup step runs under one 30-second
deadline (`startup_timeout`), and a pool created by a step that finishes late
is still closed.

| Variable                     | Meaning                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GATEWAY_CONFIG_PATH`        | Path to the configuration document.                                                                                                                                                                                                                                            |
| `PORT`                       | Listening port; Cloud Run sets it. Defaults to `server.port`.                                                                                                                                                                                                                  |
| `GATEWAY_HOST`               | Listening address; defaults to `0.0.0.0`.                                                                                                                                                                                                                                      |
| `GATEWAY_TRUSTED_PROXY_HOPS` | 0 to 2. Defaults to 1 (Cloud Run's single front end) only in `production`; elsewhere it is required (`trusted_proxy_hops_required`), so a direct run never trusts a client-supplied `X-Forwarded-For` by default.                                                              |
| `GATEWAY_DATABASE_TRANSPORT` | Unset, or `unix_socket`. With `unix_socket` (the e2-micro VM sets it: owner decision 2026-10-27, Option A) only the local `/run/postgresql` socket is accepted and any TCP URL fails with `database_socket_required`. Any other value fails with `invalid_database_transport`. |
| Bound secret variables       | Only with the `environment` secret provider (development and test).                                                                                                                                                                                                            |

Drive authenticates as its dedicated service account
(`providers.drive.machineIdentity.id`, which must be a service-account email).
The runtime's own credentials impersonate it with only the Drive scope, so the
runtime service account needs `roles/iam.serviceAccountTokenCreator` on that
Drive service account and nothing else. The source credential is allowlisted,
not denylisted: the metadata-server identity (Cloud Run) everywhere, and a
service-account key file outside production. Everything else fails with
`source_credential_refused`, including a user login, a workforce user, and a
user token chained through
`gcloud auth application-default login --impersonate-service-account`.

Any startup failure writes one JSON line to stderr,
`{"severity":"ERROR","msg":"startup_failed","reason":"<fixed reason>"}`. The
line carries no path, value or message. The pool is closed and the process
exits 1. A graceful shutdown exits 0. An idle database client dropped by the
server (failover or maintenance) logs one fixed
`{"severity":"WARNING","msg":"database_idle_client_error"}` line and is replaced,
instead of crashing the process.

The policy files and their locks are read from the working directory's
`config/policy/`. The locks detect accidental drift but not an attacker who can
write that directory, so run only from an immutable image.

## Not yet covered

The canonical GitHub Project Registry source (an external binding) is not
built. The production target is one Compute Engine `e2-micro` with colocated
PostgreSQL (PLAN Task 13). Its database transport is the local Unix socket
above, enforced on the VM by `GATEWAY_DATABASE_TRANSPORT=unix_socket`
(F13c-2, owner-reviewed before merge). The container image
and its checks are described in the [container image runbook](container-image.md).
No real configuration document, secret or credential is committed.
