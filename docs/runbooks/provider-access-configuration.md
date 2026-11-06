# Provider access configuration

Every Notion, Drive, and GitHub provider entry declares two independent pieces
of server-side access configuration:

```json
{
  "machineIdentity": {
    "environment": "development",
    "id": "synthetic-provider-identity-development"
  },
  "credential": {
    "environment": "development",
    "kind": "secret",
    "name": "synthetic_provider_development"
  }
}
```

These fields contain no credential value. `machineIdentity.id` identifies the
external integration, App, service account, or equivalent machine principal the
adapter is expected to use. `credential.kind` selects one of the closed,
server-supported mechanisms: `secret` or `workload_identity`.
`credential.name` is a bounded logical handle selected by trusted startup
configuration. It is never a URI, token, secret value, or value supplied by an
AI client.

## Parser guarantees

`parseEnvironment` validates and returns the configuration before any provider
adapter is constructed:

- Every machine identity and credential carries the same environment tag as the
  surrounding configuration. Mismatches return only safe field paths.
- Notion, Drive, and GitHub machine-identity IDs must be distinct.
- Provider credential names must be distinct from one another and from the
  database connection-secret name.
- Machine IDs are bounded, nonblank, printable values. Credential and database
  secret names use the conservative grammar `[a-z][a-z0-9_-]{0,127}`. This
  rejects URI payloads, user information, query/fragment syntax, whitespace,
  controls, and common inline-token forms before runtime composition.
- Provider roots and governance resources remain bounded URI-shaped references
  without whitespace or control bytes; they are not credential handles.
- Missing fields, raw token-shaped values, unknown inline-secret fields, and
  duplicate identities/handles fail with the fixed
  `invalid_environment_configuration` error. Values are not copied into errors.
- Existing provider-root and Project Registry references remain independently
  environment checked.

Exact string uniqueness is deliberate because machine identifiers and logical
names are provider-neutral values. The parser does not case-fold or resolve
aliases using provider-specific rules.

## Later runtime composition

The future composition root must consume the parsed object in this order:

1. Parse one trusted environment configuration at process startup.
2. Select the configured `credential.kind` from a closed server-side registry.
   Reject unimplemented kinds; never accept a client-selected mechanism or expose
   a general credential lookup operation.
3. For `secret`, pass only `{ environment, name }` to `SecretProvider`. For
   `workload_identity`, select the named ambient identity source from a closed
   composition registry; do not treat the name as a credential value or create a
   long-lived key.
4. Construct one capability-limited provider adapter with its declared machine
   identity, credential source, and governed roots/Registry scope.
5. Before live use, verify that the provider reports the expected machine identity
   where its API supports that check, and fail startup or readiness on mismatch.

Provider credentials remain distinct from verified human Google OIDC identity.
No request metadata can select a machine identity, credential handle, root, or
provider account.

## Limits and deployment obligations

Configuration validates declarations; it cannot prove that two different names
resolve to different underlying secrets, that a credential actually belongs to
the declared machine identity, or that provider permissions are least privilege.
One parsed file also cannot detect reuse between separate dev and production
files. Terraform/deployment validation must compare both environments, enforce
separate IAM/secret containers and identities, and verify real provider scopes.
Live adapter and acceptance tests must confirm the declared identity and governed
roots. No such external proof is claimed by this slice.

The current development environment adapter remains dev/test-only. No service
account key, provider token, credential value, real family identifier, or cloud
resource is added here. There is no migration, provider call, API change, or
deployed configuration change to roll back.

## Verification

```sh
pnpm exec vitest run tests/unit/config/environment.test.ts tests/contract/portability.test.ts
pnpm verify
pnpm test:integration
pnpm audit --prod --audit-level=high
git diff --check
```

`pnpm test:integration` requires the isolated loopback `_test` database described
in [`database-migrations.md`](database-migrations.md). Root
[`STATUS.md`](../../STATUS.md) records the exact local command, current counts,
publication state, and next bounded slice.
