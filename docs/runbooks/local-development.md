# Local development

## Prerequisites

- macOS or Linux
- Node.js `24.19.x`
- pnpm `11.19.0`
- Git
- PostgreSQL `17.x` for integration tests

Provider credentials are not required for domain/unit tests and must never be
placed in this repository.

## Install and verify

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm test:acceptance
```

To run PostgreSQL integration tests, provision a loopback-only database whose
name ends in `_test`, owned by the non-superuser `gateway_test` role. Supply its
URL only through the process environment, then apply migrations and run the
suite serially:

```bash
TEST_DATABASE_URL='postgresql://gateway_test:LOCAL_PASSWORD@127.0.0.1:55432/family_brain_gateway_test' pnpm db:migrate:test
TEST_DATABASE_URL='postgresql://gateway_test:LOCAL_PASSWORD@127.0.0.1:55432/family_brain_gateway_test' pnpm test:integration
```

Keep the local password in the operating-system keychain rather than a shell
profile or repository file. The test migration command rejects non-loopback
hosts, database names without the `_test` suffix, and users other than
`gateway_test`. See
[`database-migrations.md`](database-migrations.md) for provisioning and
production migration rules.

## Environment configuration

Copy `.env.example` to a local ignored `.env` only when a runnable composition
root exists. Keep secrets in the local operating-system keychain or the target
environment's secret manager; never commit them.

Development and production must use distinct databases, OIDC audiences,
provider identities, secrets, governed roots, and Project Registry snapshots.
Configuration parsing rejects cross-environment references rather than trying
to infer intent. See
[`provider-access-configuration.md`](provider-access-configuration.md) for the
provider machine-identity/credential schema, startup composition contract, and
the external IAM properties configuration alone cannot prove.

See [`google-oidc-setup.md`](google-oidc-setup.md) for strict Google token
validation, environment-separated OAuth configuration, and controlled
principal onboarding. No real family subject, ID token, or OAuth secret belongs
in local fixtures or repository files.

## Quality commands

- `pnpm format:check` checks formatting without changing files.
- `pnpm lint` runs typed ESLint rules.
- `pnpm typecheck` runs strict TypeScript without emitting output.
- `pnpm test` runs the current local unit and contract suite.
- `pnpm test:integration` runs PostgreSQL integration tests serially and
  requires `TEST_DATABASE_URL`.
- `pnpm build` emits ESM JavaScript and declarations under `dist/`.
- `pnpm verify` runs every foundation gate in deterministic order.

Use synthetic fixtures only. Live provider tests remain opt-in and target
explicitly isolated development roots.
See
[`knowledge-provider-contracts.md`](knowledge-provider-contracts.md) for the
reusable provider behavior harness, synthetic fake boundaries, and the distinction
between contract evidence and live-provider proof.
See
[`notion-governed-retrieval.md`](notion-governed-retrieval.md) for the pinned
Notion client/API version, governed-root enforcement, partial-search semantics,
and current cancellation and live-validation limits.
