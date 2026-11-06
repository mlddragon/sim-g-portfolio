# Family Brain Gateway v1 Implementation Plan

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved SIM-G Knowledge Gateway v1 through a tested dev deployment and a production-ready deployment path without weakening its identity, privacy, provider, or destructive-action boundaries.

**Architecture:** A stateless Fastify HTTPS service authenticates Google OIDC identities, maps them to internal principals, applies deterministic authorization and routing, and invokes capability-limited provider ports. PostgreSQL stores only operational state; Notion, Drive, and allowlisted GitHub repositories remain canonical knowledge providers. Google Cloud implementations live in adapters and Terraform while the core remains portable.

**Tech Stack:** Node.js 24 LTS, TypeScript 6, pnpm 11, Fastify 5, Zod 4, `jose` 6, PostgreSQL 17 with `pg` and SQL migrations, Vitest 5, official Notion/Google/GitHub clients, Terraform, one Compute Engine `e2-micro` with colocated PostgreSQL (owner decision 2026-10-24; previously Cloud Run and Cloud SQL), Secret Manager, Artifact Registry, Cloud Logging, GitHub Actions.

**Spec:** `docs/product/knowledge_gateway_prd_v1.md` and `docs/engineering/knowledge_gateway_engineering_design_v1.md`

## Global constraints

- The PRD controls product behavior, scope, security, users, and acceptance; the Engineering Design controls architecture, persistence, ports, tests, and sequence.
- Public operations are exactly `search_brain`, `fetch_record`, `persist_knowledge`, `update_record`, `append_to_record`, `delete_record`, `list_approvals`, and `resolve_approval`.
- No Brain operation is anonymous. Identity is established only by verified Google OIDC issuer plus immutable subject binding.
- Core modules import no Google Cloud, provider SDK, Fastify, or PostgreSQL package.
- Provider credentials are independent machine identities and are never logged, returned, or reused as human identity.
- PostgreSQL has no public endpoint and stores operational state rather than a mirrored Brain corpus.
- GitHub has a read-only capability type and is intersected with the Project Registry allowlist.
- Drive and Notion enforce registered governed roots in code as well as through provider credential scope.
- Participant reads and writes only ordinary Family Shared content. Destructive replace/delete of her own record is immediate only when request-time elapsed time is at most exactly 15 minutes and no protected rule applies.
- Protected and legal-hold decisions run before creator-window logic. Broad or inferred destructive actions never execute as routine writes.
- Every mutation requires an idempotency request ID and request fingerprint; unknown outcomes reconcile before retry.
- A destructive action that policy permits only after elevation uses a two-call, one-time server challenge bound to the principal, exact frozen target set, request fingerprint, operation, policy version, and five-minute lifetime. The target and policy are revalidated before execution; Participant can never confirm an elevation.
- PostgreSQL is authoritative for approval state. Notion Family Inbox is a Family-Shared-safe projection with stable operation IDs.
- Dev and prod have separate cloud projects, OAuth audiences, service identities, credentials, databases, secrets, provider roots, and state.
- Tests and examples use only clearly fictional synthetic data.
- No embedded LLM, vector store, provider mirror, persistent content cache, raw provider proxy, `move_record`, GitHub mutation, two-parent approval, or AWS deployment is added in v1.
- Provider deletion is recoverable trash/archive in v1; permanent deletion is excluded.
- Every task updates `docs/implementation/STATUS.md` with evidence, decisions, external prerequisites, and the next unchecked milestone before its commit. After Task 1, all implementation occurs on a feature branch/worktree and reaches `main` through review.

---

### Task 1: Repository foundation and deterministic toolchain

**Files:**

- Create: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `.prettierrc.json`, `.env.example`
- Create: `.github/workflows/ci.yml`, `.github/workflows/secret-scan.yml`, `.github/dependabot.yml`
- Modify: `.gitignore`, `README.md`, `docs/implementation/STATUS.md`

**Interfaces:**

- Produces: commands `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:acceptance`, `pnpm build`, and `pnpm verify`. Task 3 adds database migration gates and Task 5 adds `pnpm policy:verify`; CI grows only after each gate exists.
- Produces: Node engine `>=24.19 <25`, package manager `pnpm@11.19.0`, ESM output in `dist/`.

- [x] **Step 1: Pin the supported toolchain and dependencies**

Create a private `UNLICENSED` package. Pin exact direct versions and a lockfile. Foundation dependencies are Fastify, rate limiting, Zod, JOSE, PostgreSQL, YAML, and the development toolchain. Provider SDKs, Google Secret Manager, and the Cloud SQL connector are added only with the adapter task that consumes them. Development dependencies are TypeScript 6, Node 24 types, Vitest/coverage, ESLint/typescript-eslint, Prettier, and `tsx`.

- [x] **Step 2: Configure strict compilation and quality checks**

Use ESM/NodeNext, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, and separate build/test inclusions. ESLint must reject floating promises, unsafe `any`, and unused variables. Prettier owns formatting.

- [x] **Step 3: Add least-privilege CI and secret scanning**

Pin GitHub actions to immutable commit SHAs, set `permissions: contents: read`, install with a frozen lockfile, run only the formatting/lint/type/test/build gates that exist in Task 1, and run Gitleaks independently. Dependabot updates npm and GitHub Actions weekly with grouped non-major development updates. Later tasks add PostgreSQL, policy, Terraform, image, and acceptance jobs when their commands exist.

- [x] **Step 4: Verify repository privacy boundaries**

Run:

```bash
git check-ignore -v .env .env.dev provider.key terraform.tfstate family.dump gateway.log
git diff --check
pnpm format:check
```

Expected: each sensitive sample is ignored, the diff has no whitespace errors, and formatting passes.

- [x] **Step 5: Commit, create, push, and verify the private repository**

The owner explicitly authorized the new repository and the read-only preflight proved no existing repository or remote conflicts. Create `example-owner/simg-mirror` with explicit private visibility, push `main`, then verify private metadata, Pages disabled, `main` upstream tracking, local/remote SHA equality, and a clean worktree. Enable the dependency graph, Dependabot alerts/security updates, private vulnerability reporting, and secret scanning/push protection only where the account plan exposes them. Configure a `main` ruleset or branch protection requiring pull requests and the CI checks when the private-repository plan supports it; otherwise record the plan limitation and preserve the feature-branch/review workflow. Record unavailable paid features without weakening local/CI checks.

---

### Task 2: Domain contracts, errors, request context, and configuration

**Files:**

- Create: `src/domain/identifiers.ts`, `src/domain/principal.ts`, `src/domain/records.ts`, `src/domain/operations.ts`, `src/domain/approvals.ts`, `src/domain/errors.ts`, `src/domain/request-context.ts`
- Create: `src/ports/identity-provider.ts`, `src/ports/operational-state-store.ts`, `src/ports/audit-sink.ts`, `src/ports/telemetry-sink.ts`, `src/ports/secret-provider.ts`, `src/ports/knowledge-provider.ts`, `src/ports/approval-projection.ts`, `src/ports/governance-source.ts`, `src/ports/clock.ts`
- Create: `src/config/environment.ts`, `tests/unit/config/environment.test.ts`, `tests/contract/portability.test.ts`
- Modify: `docs/implementation/STATUS.md`

**Interfaces:**

- Produces: branded IDs `PrincipalId`, `RequestId`, `OperationId`, `BrainRecordId`, `ProviderRecordId`.
- Produces: `DomainError` with stable `code`, `retryable`, safe `details`, and cause excluded from serialization.
- Produces: normalized provider capability interfaces `SearchableKnowledgeProvider`, `FetchableKnowledgeProvider`, and `MutableKnowledgeProvider`; GitHub can implement only the first two.
- Produces: `EnvironmentConfig` discriminated by `development | test | production` and validated at process boundary.
- Produces: `UpdateMutation` discriminated by `patch` versus `replace`; a client label does not override the server's destructive classification of the actual mutation shape.

- [x] **Step 1: Write failing tests for safe error serialization and environment isolation**

```ts
it('serializes a safe error without stack, SQL, or cause', () => {
  const error = new DomainError(
    'unauthorized',
    false,
    { reason: 'scope_denied' },
    new Error('secret SQL'),
  );
  expect(error.toResponse()).toEqual({
    error: {
      code: 'unauthorized',
      retryable: false,
      details: { reason: 'scope_denied' },
    },
  });
});

it('rejects a development config that names production provider roots', () => {
  expect(() =>
    parseEnvironment(fixtureWithCrossEnvironmentRoots()),
  ).toThrowError('environment_boundary_violation');
});
```

- [x] **Step 2: Run the focused tests and observe failures caused by missing contracts**

Run: `pnpm vitest run tests/unit/config/environment.test.ts tests/contract/portability.test.ts`

- [x] **Step 3: Implement minimal normalized types, ports, errors, and config parser**

The knowledge provider contracts must have this capability split:

```ts
export interface SearchableKnowledgeProvider {
  readonly provider: KnowledgeProviderName;
  search(
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ): Promise<ProviderSearchResponse>;
}
export interface FetchableKnowledgeProvider extends SearchableKnowledgeProvider {
  fetch(
    request: ProviderFetchRequest,
    signal: AbortSignal,
  ): Promise<ProviderRecord>;
}
export interface MutableKnowledgeProvider extends FetchableKnowledgeProvider {
  create(
    request: RoutedCreate,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult>;
  update(
    request: RoutedUpdate,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult>;
  append(
    request: RoutedAppend,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult>;
  trash(
    request: RoutedTrash,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult>;
  reconcile(
    request: ReconciliationRequest,
    signal: AbortSignal,
  ): Promise<ReconciliationResult>;
}
```

`ApprovalProjectionPort`, `GovernanceSource`, and `TelemetrySink` are declared in core here. Provider and cloud adapters implement them later; adapters never define inward-facing ports.

- [x] **Step 4: Run focused and full verification**

Run: `pnpm vitest run tests/unit/config/environment.test.ts tests/contract/portability.test.ts && pnpm typecheck && pnpm lint`

- [x] **Step 5: Commit the domain foundation**

Commit message: `feat: define gateway domain and portability ports`

---

### Task 3: PostgreSQL operational state and migrations

**Files:**

- Create: `migrations/000001_operational_state.sql`, `migrations/000002_seed_principals.sql`
- Create: `src/adapters/state/postgres/pool.ts`, `src/adapters/state/postgres/postgres-operational-state-store.ts`, `src/adapters/state/postgres/migrate.ts`
- Create: `scripts/migrate.ts`, `tests/contract/operational-state-store.contract.ts`, `tests/integration/postgres-operational-state-store.test.ts`
- Create: `tests/support/postgres.ts`, `docs/runbooks/database-migrations.md`
- Modify: `package.json`, `.github/workflows/ci.yml`, `docs/implementation/STATUS.md`

**Interfaces:**

- Consumes: `OperationalStateStore`, normalized IDs and operation/approval state types.
- Produces: identity binding lookup, operation create/load/transition, approval create/list/resolve, stable alias resolution, policy version persistence, and reconciliation-attempt persistence.

- [x] **Step 1: Write the state-store contract against a PostgreSQL test database**

Cover unique issuer/subject identity bindings, unique principal/operation/request idempotency, fingerprint conflict, atomic operation transitions, non-expiring approvals, one-time elevation challenges, stable alias reuse, policy/Project Registry versions, reconciliation attempts, and audit-outbox delivery state. Use literal synthetic principals and records.

- [x] **Step 2: Run migrations and observe contract failures before the adapter exists**

Run: `TEST_DATABASE_URL=postgres://gateway_test:gateway_test@127.0.0.1:5432/gateway_test pnpm vitest run tests/integration/postgres-operational-state-store.test.ts`

- [x] **Step 3: Implement SQL migrations and transactional adapter**

Tables are `principals`, `identity_bindings`, `operations`, `approval_requests`, `elevation_challenges`, `brain_record_aliases`, `policy_versions`, `project_registry_versions`, `reconciliation_attempts`, and `audit_outbox`. `operations` stores minimum encrypted-at-rest operational payload JSON, request fingerprint, provider identifiers/version, safe result metadata, error code, policy version, and timestamps. The outbox stores normalized metadata-only audit events and delivery attempts. No knowledge index or provider content mirror is added.

- [x] **Step 4: Prove restart persistence and idempotency**

Close the first pool, construct a new adapter, and verify the same operation/approval/alias state and original result remain. Reusing the request ID with a different fingerprint must yield `idempotency_conflict` without a second transition.

- [x] **Step 5: Run integration, migration, type, and lint checks**

Run: `pnpm db:migrate:test && pnpm test:integration && pnpm typecheck && pnpm lint`

- [x] **Step 6: Commit PostgreSQL operational state**

Commit message: `feat: persist gateway operational state in postgres`

---

### Task 4: Google OIDC verification and principal mapping

**Files:**

- Create: `src/application/authentication-service.ts`, `src/adapters/identity/google-oidc-identity-provider.ts`
- Create: `tests/unit/identity/google-oidc-identity-provider.test.ts`, `tests/unit/application/authentication-service.test.ts`, `tests/contract/identity-provider.contract.ts`
- Create: `docs/runbooks/google-oidc-setup.md`
- Modify: `docs/implementation/STATUS.md`

**Interfaces:**

- Consumes: `IdentityProvider.verify(token, requestContext)`, `OperationalStateStore.findPrincipalByExternalIdentity`.
- Produces: `AuthenticationService.authenticate` returning a server-owned `AuthenticatedPrincipal`.

- [x] **Step 1: Write failing JOSE tests using local generated keys**

Cover valid Operator/Steward/Participant subject bindings, both allowed Google issuer spellings, wrong signature, issuer, audience, expiry, hosted domain, unverified email, disabled binding, unknown subject, and a request containing forged `user: steward` metadata.

- [x] **Step 2: Run tests and confirm they fail for missing verification/mapping**

Run: `pnpm vitest run tests/unit/identity tests/unit/application/authentication-service.test.ts`

- [x] **Step 3: Implement strict Google token verification and state-backed mapping**

Use `jose.jwtVerify` with configured JWKS, issuer set, exact environment audience, expiry, and exact hosted-domain checks. Bind only `(issuer, sub)` to principals. Email is safe display metadata after `email_verified=true`; it never selects the principal.

- [x] **Step 4: Run identity contract, unit, type, and lint checks**

Run: `pnpm vitest run tests/unit/identity tests/unit/application/authentication-service.test.ts tests/contract/identity-provider.contract.ts && pnpm typecheck && pnpm lint`

- [x] **Step 5: Commit identity enforcement**

Commit message: `feat: verify google oidc identities and map principals`

---

### Task 5: Authorization, destructive policy, routing, and governance lock

**Files:**

- Create: `config/policy/family-brain-v1.yaml`, `config/policy/governance-lock.json`, `config/policy/project-registry.yaml`, `config/policy/project-registry-lock.json`
- Create: `src/domain/authorization/authorization-engine.ts`, `src/domain/authorization/destructive-classifier.ts`, `src/domain/routing/canonical-router.ts`, `src/domain/policy/policy-loader.ts`, `src/domain/policy/governance-validator.ts`
- Create: `scripts/verify-policy.ts`
- Create: `tests/unit/authorization/authorization-engine.test.ts`, `tests/unit/authorization/destructive-classifier.test.ts`, `tests/unit/routing/canonical-router.test.ts`, `tests/unit/policy/governance-validator.test.ts`
- Modify: `package.json`, `.github/workflows/ci.yml`, `docs/implementation/STATUS.md`

**Interfaces:**

- Produces: `AuthorizationDecision` of `ALLOW | DENY | APPROVAL_REQUIRED | ELEVATION_REQUIRED` with stable reason codes.
- Produces: `CanonicalRoute` with provider, governed container key, operation, policy version, and routing reason.
- Consumes: authoritative provider provenance for creator/time/protection; never client ownership claims.

- [x] **Step 1: Write table-driven failing authorization and time-boundary tests**

Cover every role/operation/scope combination, Participant at `14:59.999`, exactly `15:00.000`, and `15:00.001`, protected/legal-hold precedence, ordinary field patch versus full/empty-body destructive replacement, single explicit versus broad/inferred delete, Operator-only control plane, either-parent approval authority, elevation issuance/confirmation, challenge expiry/replay/mismatch, and the invariant that Participant cannot elevate.

- [x] **Step 2: Write failing routing and drift tests**

Structured records/knowledge/decisions/procedures route to Notion. Source documents/file artifacts/legal records route to Drive. Missing required fields return `insufficient_metadata`; a conflicting non-authoritative hint returns `routing_ambiguous`; any GitHub write route is absent. A changed policy hash, governance marker, Project Registry hash, or live Registry marker returns `policy_drift`. Registry additions/removals and malformed or App-installed-but-unregistered repositories fail closed.

- [x] **Step 3: Run the four focused suites and observe expected failures**

Run: `pnpm vitest run tests/unit/authorization tests/unit/routing tests/unit/policy`

- [x] **Step 4: Implement deterministic policy and injected-clock evaluation**

Run protected/legal/control-plane classification before creator-window logic. Search scope is the intersection of role scope and registered surfaces. No model or probabilistic classifier dependency is introduced.

- [x] **Step 5: Implement governance lock validation**

The governance and Project Registry locks record independent version, SHA-256, canonical marker, and environment-provided source reference. The real Registry snapshot starts with an empty fail-closed repository list until the authoritative dev Registry is connected. CI validates repository hash consistency; deployment validation compares both configured live markers through the `GovernanceSource` port. A credential-visible repository never enters the allowlist automatically.

- [x] **Step 6: Run policy verification and full unit checks**

Run: `pnpm policy:verify && pnpm vitest run tests/unit/authorization tests/unit/routing tests/unit/policy && pnpm typecheck && pnpm lint`

- [x] **Step 7: Commit policy foundation**

Commit message: `feat: enforce authorization routing and governance policy`

---

### Task 6: Audit, secrets, provider contracts, and safe fakes

**Files:**

- Create: `src/application/audited-operation.ts`, `src/application/audit-outbox-service.ts`, `src/adapters/audit/cloud-logging-audit-sink.ts`, `src/adapters/telemetry/cloud-logging-telemetry-sink.ts`, `src/adapters/secrets/environment-secret-provider.ts`, `src/adapters/secrets/google-secret-manager-provider.ts`
- Create: `tests/contract/audit-sink.contract.ts`, `tests/contract/telemetry-sink.contract.ts`, `tests/contract/secret-provider.contract.ts`, `tests/contract/knowledge-provider.contract.ts`
- Create: `tests/support/fake-audit-sink.ts`, `tests/support/fake-telemetry-sink.ts`, `tests/support/fake-secret-provider.ts`, `tests/support/fake-knowledge-providers.ts`, `tests/unit/audit/cloud-logging-audit-sink.test.ts`, `tests/unit/application/audit-outbox-service.test.ts`
- Modify: `docs/implementation/STATUS.md`

**Interfaces:**

- Consumes: `AuditSink.emit(AuditEvent)` and `SecretProvider.get(SecretReference)`.
- Produces: structured audit events containing principal, client, operation, request, target, provider, timestamp, policy/approval context, outcome, provider version, and optional integrity hash without content bodies.
- Produces: provider-neutral observations for total/auth/policy/routing/provider/database latency, timeouts, partial-result frequency, error code counts, and approval queue age/count without record content or raw identity claims.

- [ ] **Step 1: Write failing redaction and contract tests**

Inject token-shaped strings, SQL errors, content bodies, and provider payloads and prove no audit, telemetry, or error serialization contains them. Prove each fake and real adapter satisfies its port without leaking provider-specific objects. Simulate a logging outage and prove metadata-only events remain in the PostgreSQL outbox until acknowledged, without reversing a completed provider operation.

- [ ] **Step 2: Run tests and observe missing adapter failures**

Run: `pnpm vitest run tests/contract/audit-sink.contract.ts tests/contract/secret-provider.contract.ts tests/contract/knowledge-provider.contract.ts tests/unit/audit`

- [ ] **Step 3: Implement structured Cloud Logging stdout and secret adapters**

Cloud Run logging uses one-line structured JSON to stdout through separate audit and telemetry adapters. The audited-operation wrapper covers all eight successful and denied operations, including search/fetch. The outbox service claims and acknowledges durable events with bounded retries. Google Secret Manager is contained in its adapter and caches only bounded in-memory values by secret version; env secrets are development-only and fail closed in production. Configuration requires distinct provider credential logical names and machine-identity IDs, permits only closed credential mechanisms, and rejects cross-provider or cross-environment reuse.

- [ ] **Step 4: Verify contracts and commit**

Run: `pnpm vitest run tests/contract tests/unit/audit && pnpm typecheck && pnpm lint`

Commit message: `feat: add audit and secret provider boundaries`

---

### Task 7: Notion adapter and Family Inbox projection

**Files:**

- Create: `src/adapters/notion/notion-client.ts`, `src/adapters/notion/notion-scope-guard.ts`, `src/adapters/notion/notion-record-mapper.ts`, `src/adapters/notion/notion-knowledge-provider.ts`, `src/adapters/notion/notion-family-inbox.ts`
- Create: `tests/contract/notion-provider.contract.test.ts`, `tests/unit/notion/notion-scope-guard.test.ts`, `tests/integration/notion-dev.test.ts`
- Create: `docs/runbooks/notion-provider-setup.md`
- Modify: `docs/implementation/STATUS.md`

**Interfaces:**

- Implements: `MutableKnowledgeProvider` for governed Notion pages/data sources.
- Produces: `ApprovalProjectionPort.create/update` for the existing Family Inbox.

- [ ] **Step 1: Write failing contract tests with complete recorded-shape fixtures**

Cover governed-scope title search, pagination, nested-block fetch, stable page IDs and last-edited provenance, gateway-managed create/update/append, move-to-trash, uncertain create reconciliation by operation ID, and safe Family Inbox properties.

- [ ] **Step 2: Write scope and secret-negative tests**

Prove an accessible but unregistered Notion page is not returned or fetched, a broad ancestor is rejected in configuration, and tokens/content are absent from logs and errors.

- [ ] **Step 3: Implement the adapter against the official client**

Search is treated as title/index discovery rather than exhaustive full-text proof. Fetch walks paginated block children. Inbox fields contain only requester, action, safe target description, stable request ID, and status. Notion delete uses trash, never permanent deletion.

- [ ] **Step 4: Run contract tests; gate real dev tests on explicit credentials/root IDs**

Run: `pnpm vitest run tests/contract/notion-provider.contract.test.ts tests/unit/notion`

When isolated dev credentials exist, run: `RUN_NOTION_DEV_TESTS=1 pnpm vitest run tests/integration/notion-dev.test.ts`

- [ ] **Step 5: Commit Notion support**

Commit message: `feat: add governed notion and family inbox adapters`

---

### Task 8: Google Drive governed-root adapter

**Files:**

- Create: `src/adapters/drive/drive-client.ts`, `src/adapters/drive/drive-root-guard.ts`, `src/adapters/drive/drive-record-mapper.ts`, `src/adapters/drive/drive-knowledge-provider.ts`
- Create: `tests/contract/drive-provider.contract.test.ts`, `tests/unit/drive/drive-root-guard.test.ts`, `tests/integration/drive-dev.test.ts`
- Create: `docs/runbooks/google-drive-provider-setup.md`
- Modify: `docs/implementation/STATUS.md`

**Interfaces:**

- Implements: `MutableKnowledgeProvider` for explicitly registered Shared Drive/folder roots.
- Preserves: file ID, version, modified time, head revision where available, root key, app-private operation marker, and content hash.

- [ ] **Step 1: Write failing recursive-root and contract tests**

Cover direct and nested descendants, shared-drive flags, pagination, attempts to fetch by an out-of-root supplied ID, the v1 MIME capability matrix, bounded unsupported-media behavior, create/update/append, trash, and reconciliation using private `appProperties`. Read supports Google Docs export plus UTF-8 plain text/Markdown/JSON. Create writes UTF-8 Markdown. Update/append is permitted only for gateway-managed UTF-8 text/Markdown; existing Google Docs and binary/PDF files are read-only in v1 and return stable `provider_capability_unsupported` without conversion or overwrite.

- [ ] **Step 2: Run focused tests and observe guard/adapter failures**

Run: `pnpm vitest run tests/contract/drive-provider.contract.test.ts tests/unit/drive`

- [ ] **Step 3: Implement root-verified Drive operations**

Enumerate only registered roots, use `supportsAllDrives=true`, and verify ancestry again before fetch or mutation. Never use domain-wide delegation or search `allDrives`/user My Drive by default. Gateway-created durable text is stored as UTF-8 Markdown. Delete sets `trashed=true`.

- [ ] **Step 4: Run contracts; gate real dev tests on isolated root credentials**

Run: `pnpm vitest run tests/contract/drive-provider.contract.test.ts tests/unit/drive`

When isolated dev credentials exist, run: `RUN_DRIVE_DEV_TESTS=1 pnpm vitest run tests/integration/drive-dev.test.ts`

- [ ] **Step 5: Commit Drive support**

Commit message: `feat: add governed google drive adapter`

---

### Task 9: GitHub App read-only adapter and Project Registry allowlist

**Files:**

- Create: `config/policy/project-registry.yaml`, `config/policy/project-registry.example.yaml`, `src/adapters/github/github-app-client.ts`, `src/adapters/github/project-registry.ts`, `src/adapters/github/github-knowledge-provider.ts`
- Create: `tests/contract/github-provider.contract.test.ts`, `tests/unit/github/project-registry.test.ts`, `tests/integration/github-dev.test.ts`
- Create: `docs/runbooks/github-app-provider-setup.md`
- Modify: `docs/implementation/STATUS.md`

**Interfaces:**

- Implements: `FetchableKnowledgeProvider`; compilation must fail if assigned to `MutableKnowledgeProvider`.
- Consumes: principal-authorized entries from the fail-closed, live-marker-verified Project Registry snapshot intersected with the GitHub App installation repository set.

- [ ] **Step 1: Write failing allowlist, provenance, and type tests**

Cover per-repository qualified search, default-branch search limitations, incomplete result propagation, targeted fetch pinned to commit SHA, stable repo/path/blob provenance, rejection of unregistered or unauthorized repos, and absence of mutation methods.

- [ ] **Step 2: Run contract tests and observe missing implementation failures**

Run: `pnpm vitest run tests/contract/github-provider.contract.test.ts tests/unit/github && pnpm typecheck`

- [ ] **Step 3: Implement GitHub App installation authentication and read adapter**

Request only repository `Contents: read` plus required metadata. Every code search includes one `repo:owner/name` qualifier from the authorized Project Registry intersection. Fetch uses an explicit resolved commit SHA and returns blob SHA provenance.

- [ ] **Step 4: Run contracts; gate real dev tests on an isolated GitHub App**

Run: `pnpm vitest run tests/contract/github-provider.contract.test.ts tests/unit/github`

When the dev App exists, run: `RUN_GITHUB_DEV_TESTS=1 pnpm vitest run tests/integration/github-dev.test.ts`

- [ ] **Step 5: Commit GitHub retrieval**

Commit message: `feat: add allowlisted read-only github adapter`

---

### Task 10: Unified search and targeted fetch

**Files:**

- Create: `src/application/search-brain-service.ts`, `src/application/fetch-record-service.ts`, `src/domain/search/rank-and-deduplicate.ts`
- Create: `tests/unit/application/search-brain-service.test.ts`, `tests/unit/application/fetch-record-service.test.ts`, `tests/unit/search/rank-and-deduplicate.test.ts`
- Create: `tests/acceptance/retrieval.acceptance.test.ts`
- Modify: `docs/implementation/STATUS.md`

**Interfaces:**

- Produces: normalized bounded excerpts, stable Brain IDs, provider/canonical/provenance metadata, per-provider `complete | partial | timeout | unavailable` completeness, and request ID.
- Consumes: authorized registered provider surfaces and aliases from `OperationalStateStore`.

- [x] **Step 1: Write failing concurrency, partial-result, and data-minimization tests**

Prove eligible providers start before any completes, one slow provider is aborted at its own timeout, an adapter that ignores cancellation cannot hold the response open and its late rejection is absorbed, successful results return with explicit missing provider state, full bodies are absent from search results, and providers with no authorized scope are omitted rather than marked failed.

- [x] **Step 2: Write failing ranking, deduplication, and fetch reauthorization tests**

Use hand-derived query/title/excerpt fixtures. Rank deterministically by local token overlap, canonical match, provider tie-breaker, and stable ID. Fetch resolves an alias and reauthorizes current provider metadata; stale search authorization must not grant access.

- [x] **Step 3: Implement search/fetch orchestration**

Use a per-provider deadline race that settles independently, aborts the underlying operation, discards late results, and absorbs late rejection; then collect the bounded settlements. Use local deterministic scoring and stable alias assignment. Preserve provider-specific incompleteness such as GitHub `incomplete_results`. Emit audit and telemetry observations for complete, partial, denied, and failed reads.

- [x] **Step 4: Run retrieval unit and acceptance suites**

Run: `pnpm vitest run tests/unit/application/search-brain-service.test.ts tests/unit/application/fetch-record-service.test.ts tests/unit/search tests/acceptance/retrieval.acceptance.test.ts`

- [x] **Step 5: Commit retrieval orchestration**

Commit message: `feat: unify brain search and targeted fetch`

---

### Task 11: Mutations, idempotency, reconciliation, and approvals

**Bounded checkpoint:** F11a completes idempotent `update_record` orchestration.
F11b adds PostgreSQL-authoritative non-expiring approvals, safe/reconcilable
Family Inbox projection, parent-only list/resolve, atomic resolution audit, and
freshly revalidated continuation through the F11a update path. The Task 11
checkboxes remain open until broader mutation and elevation coverage is complete.
F11c adds one-time elevated `update_record` confirmation with atomic challenge
consumption and execution claim. F11d adds governed `persist_knowledge` with gateway creator
attribution. F11e adds governed `append_to_record` through the shared target pipeline.
F11f adds governed recoverable-trash `delete_record` with parent approval.
F11g adds parent approval for gated appends and clears mutation payloads on
terminal states. F11h adds reconcile-only recovery of stranded direct executions. F11i adds
frozen-route elevated creates, completing local orchestration of every v1
mutation path. Remaining Task 6 (F6) wiring is next per root `STATUS.md`.

**Files:**

- Create: `src/application/mutation-service.ts`, `src/application/approval-service.ts`, `src/application/operation-fingerprint.ts`
- Create: `tests/unit/application/mutation-service.test.ts`, `tests/unit/application/approval-service.test.ts`, `tests/unit/application/operation-fingerprint.test.ts`
- Create: `tests/acceptance/mutations.acceptance.test.ts`, `tests/acceptance/approvals.acceptance.test.ts`
- Modify: `docs/implementation/STATUS.md`

**Interfaces:**

- Produces: client states `completed | failed | approval_required | elevation_required | outcome_unknown`.
- Consumes: router, authorization, mutable provider map, state store, audit sink, clock, and Family Inbox projection.

- [ ] **Step 1: Write failing mutation state-machine tests**

Cover Notion/Drive route execution, provider invocation only after routing plus a fresh guarded provider fetch of current scope/creator/creation time/protected/legal-hold/version metadata, forged client metadata, moved scope, newly protected records, expired correction windows, target state changes between authorization and mutation, version/precondition conflicts, terminal duplicate replay, same-key different-fingerprint conflict, in-progress response, ambiguous timeout to `OUTCOME_UNKNOWN`, reconciliation without duplicate mutation, provider version/hash persistence, and durable audit outcome emission.

- [ ] **Step 2: Write failing approval workflow tests**

Cover Participant out-of-window request persistence, safe Inbox projection, restart durability, no time expiry, list restricted to Operator/Steward, either-parent independent approval, `approve | decline | cancel` resolution by Operator/Steward, denial of Participant resolution/elevation, target changed/deleted/protected/no-longer-authorized revalidation, superseded/impossible state, Inbox projection reconciliation, and audit correlation. Cancellation is a parent/steward resolution state in v1; there is no separate requester-cancel operation.

- [ ] **Step 3: Run focused tests and observe missing service failures**

Run: `pnpm vitest run tests/unit/application/mutation-service.test.ts tests/unit/application/approval-service.test.ts tests/acceptance/mutations.acceptance.test.ts tests/acceptance/approvals.acceptance.test.ts`

- [ ] **Step 4: Implement transactional operation and approval orchestration**

Fingerprint canonical normalized payload JSON with SHA-256. Persist before provider calls, use legal state transitions, reconcile unknown outcomes, and return stored terminal results. Every target mutation resolves the alias, re-fetches through the guarded adapter, authorizes authoritative current metadata, and applies a provider version/precondition when supported. Elevation first persists and returns a one-time five-minute challenge; confirmation must match the same principal, frozen targets, fingerprint, operation, and policy version, then consumes the challenge atomically after revalidation. Approval resolution follows the same fresh-fetch path; Notion projection or audit-delivery failure cannot roll back a completed provider mutation and is recorded for reconciliation/outbox delivery.

- [ ] **Step 5: Run mutation/approval and PostgreSQL restart suites**

Run: `pnpm vitest run tests/unit/application tests/acceptance/mutations.acceptance.test.ts tests/acceptance/approvals.acceptance.test.ts && pnpm test:integration`

- [ ] **Step 6: Commit mutation and approval flows**

Commit message: `feat: execute idempotent mutations and durable approvals`

---

### Task 12: Authenticated HTTP API and operational protections

**Files:**

- Create: `src/api/build-app.ts`, `src/api/error-handler.ts`, `src/api/authentication-hook.ts`, `src/api/request-context-hook.ts`, `src/api/schemas/*.ts`, `src/api/routes/*.ts`, `src/bootstrap.ts`, `src/server.ts`
- Create: `tests/integration/api-authentication.test.ts`, `tests/integration/api-operations.test.ts`, `tests/integration/api-security.test.ts`
- Create: `docs/runbooks/local-development.md`, `docs/runbooks/configuration.md`
- Modify: `docs/implementation/STATUS.md`

**Interfaces:**

- Exposes: `POST /v1/operations/<operation-name>` for each of the eight approved operations and `GET /healthz` returning only liveness.
- Consumes: application services through dependency injection; route modules contain no provider business logic.

- [ ] **Step 1: Write failing transport authentication and schema tests**

Cover missing/malformed/invalid bearer tokens, forged identity fields, wrong content type, body over limit, stable request ID generation/validation, all eight operation schemas, `update_record` patch versus replace shapes, delete/elevation challenge and confirmation shapes, safe domain error mapping, no stack/secret response, and health output containing no infrastructure details.

- [ ] **Step 2: Write failing abuse-boundary tests**

Cover unauthenticated IP and authenticated principal/client rate limiting, explicit maximum search limits, provider timeout ceilings, and rejection of raw provider methods/endpoints/credentials or a ninth operation. The documented non-authoritative `canonical_hint` remains accepted input but can never bypass routing policy.

- [ ] **Step 3: Implement the minimal Fastify composition root**

Authentication runs before operation handlers. Use Zod schemas, fixed request/body limits, safe security headers, trust-proxy configuration appropriate to Cloud Run, and structured request logs containing IDs/outcomes but no body or authorization header.

- [ ] **Step 4: Run API integration, build, and full verification**

Run: `pnpm vitest run tests/integration/api-authentication.test.ts tests/integration/api-operations.test.ts tests/integration/api-security.test.ts && pnpm build && pnpm verify`

- [ ] **Step 5: Commit the API**

Commit message: `feat: expose authenticated family brain operations`

---

### Task 13: Google Cloud deployment on one Compute Engine e2-micro

**Direction (owner, 2026-10-24):** see `docs/engineering/2026-10-24-e2-micro-hosting-decision.md`.

- **Target:** SIM-G and its private operational PostgreSQL run on one non-Spot
  Compute Engine `e2-micro` in Google Cloud, independent of the local service host and
  home Internet.
- **Budget:** the complete incremental recurring production cost must stay
  strictly below USD 10/month, preferably USD 5 or less.
- **Approval:** any other machine type, a managed database or the previous
  topology needs explicit owner approval.

This task previously prescribed Cloud Run with private Cloud SQL. That
resource list and topology are superseded and must not be executed. Its
implementation (Terraform module, dev/prod roots and mocked-plan tests) is
preserved, unmerged, on branch `archive/f13-cloud-run-cloud-sql` as the
non-selected alternative and as a source of reusable pieces.

**Still binding, translated to the VM.** Only the topology changes. These
Task 13 obligations remain:

- **Reviewed deployment code:**
  - infrastructure-boundary contract tests;
  - no service-account keys;
  - per-secret runtime access and a dedicated, impersonated Drive identity;
    - distinct dev and prod projects, identities, credentials, databases and
      roots, with rejection of cross-environment reuse;
  - Terraform creates no project or billing account;
  - secrets are empty containers whose values are loaded out of band, so no
    secret value or secret-bearing variable enters state.
- **Release gates:**
  - dev deploys only from reviewed `main` after CI, in its own GitHub
    environment;
  - prod promotion requires the GitHub production-environment approval,
    automated acceptance evidence and a manual-readiness artifact;
  - migrations run through a private, authenticated path, never at gateway
    startup;
  - verification proves secrets are unreachable through the API and absent
    from logs.
- **Deployment pipeline:**
  - GitHub workload identity federation bound to the exact repository, ref,
    environment and workflow;
  - pinned Trivy image, IaC and dependency scans that fail on fixable
    HIGH/CRITICAL findings;
  - deployment by immutable image digest, with the dev-validated digest
    promoted to prod and never rebuilt.
- **Audit and observability:**
  - durable audit delivery with verified remote collection and explicit
    retention;
  - the required log-based metrics.
- **Data safety:**
  - backups with tested restore, and deletion protection;
  - PostgreSQL never on a public listener;
  - a dev deployment before prod (PRD section 22, Task 14).

**VM-specific requirements:**

- **Database transport.** Database access is the local Unix socket. Draft PR
  #79 (held for owner review) makes `resolveDatabaseUrl` accept only
  `host=/run/postgresql`, or TCP with `sslmode=verify-full`, and refuses the
  retired `/cloudsql/` form. Any change:
  - starts with failing tests;
  - is owner-reviewed (it touches a security control);
  - is limited to loopback or a local socket;
    - never permits non-TLS TCP to a non-loopback host;
    - never aliases a local socket under `/cloudsql/`.
- **Network.**
  - No default-VPC rules, and no firewall rule for 5432.
  - SSH only through IAP or OS Login.
    - Minimal HTTPS ingress with correct proxy and IP trust for rate limiting.
      The production defaults (`GATEWAY_TRUSTED_PROXY_HOPS` 1 for Cloud Run's
      front end, `GATEWAY_HOST` `0.0.0.0`) are Cloud Run-era. F13c must set them
      for the VM's actual ingress: on a directly exposed VM, 1 hop would trust a
      spoofed `X-Forwarded-For` and defeat per-IP rate limiting.
  - No load balancer, NAT gateway, Kubernetes, Cloud SQL or second always-on
    VM without owner approval.
  - The metadata-server token is reachable by every process on the VM, so
    least privilege covers the PostgreSQL process too.
- **Free tier, verified and not assumed.** One `e2-micro` in us-west1,
  us-central1 or us-east1. The allowance is 30 GB-months of standard (not
  balanced) persistent disk and 1 GB/month of outbound transfer. It is counted
  per billing account, so a concurrent dev VM is paid, and snapshots and
  backups are not covered. External IPv4 costs USD 0.005/hour, about USD 3.65
  for 730 hours.
- **Capacity envelope.** 2 burstable vCPUs with a 0.25 vCPU sustained baseline
  and 1 GB of memory, shared with the OS, PostgreSQL and the log agent. Local
  resource-limited runs are preliminary evidence, not proof of E2 performance.
- **Budget alerts are not a cap.** Compute Engine has no spend cap; never claim
  a hard invoice maximum.

**Slices.** One bounded, reviewed PR each, with exact-head CI:

- [x] **F13a: container image, supply-chain checks and hosting reconciliation**
      (PR #74).
  - A digest-pinned, non-root, read-only-compatible image, plus
    `pnpm image:check` (hardened smoke test and pinned Trivy image, IaC and
    dependency scans).
  - CI container and dependency-audit jobs, and deployment-artifact contract
    tests.
  - The Engineering Design, PLAN and STATUS reconciled with the e2-micro
    decision, and the Cloud Run/Cloud SQL Terraform retired to the archive
    branch.
- [x] **F13b: synthetic e2-micro capacity and recurring-cost evidence** (PR #77). See
      `docs/engineering/2026-10-25-e2-micro-capacity-report.md` and
      `docs/engineering/2026-10-25-e2-micro-cost-model.md`.
  - Run the complete stack (gateway, PostgreSQL 17, log collection stand-in)
    under e2-micro limits (1 GiB; 0.25 sustained and 2 burst vCPU) with
    fictional data and provider mocks.
  - Use development/test configuration: loopback TCP to PostgreSQL, the
    environment secret provider with synthetic values, and an explicit
    `GATEWAY_TRUSTED_PROXY_HOPS`. Record that the production-only paths (Secret
    Manager, production transport) are not measured. No transport workaround
    before F13c.
  - Measure startup, realistic concurrency, audit backlog with sink failure,
    database restart, TLS and logging overhead, and backup/restore.
  - Produce an itemized recurring-cost model covering every incremental
    service, with assumptions and sources.
  - If the target cannot meet the budget and usability safely, report the
    evidence and alternatives instead of changing configuration.
- [ ] **F13c: VM deployment design and offline-validated scaffolding.** The
      design is in `docs/engineering/2026-10-25-e2-micro-vm-design.md`, with
      the owner's section 14 decisions recorded (PR #99, 2026-10-27);
      section 15 lists the slices. Every offline slice is built; only PR #79
      awaits the owner's merge review:
  - F13c-1: the design (decisions recorded in PR #99);
  - F13c-2: database transport, PR #79, reviewed, **held for the owner's
    merge review**; socket-only on the VM (`GATEWAY_DATABASE_TRANSPORT`);
  - F13c-3: nginx ingress, certificates, limits and runbooks (PR #105);
  - F13c-4a: outage mappings, merged in PR #80;
    - F13c-4b: the migration entry point (part 1, PR #82) and backup tooling
      (part 2);
  - F13c-5: Terraform and cloud-init, mocked plans only; the amd64 image
    smoke test runs in CI's Container image job (an amd64 runner).
    - F13c-5a: the non-IAM VM Terraform (merged in PR #86);
    - F13c-5b: the host layer, meaning cloud-init and systemd units (merged
      in PR #87);
    - F13c-5c: the deploy-pointer watcher, offline (merged in PR #88; image
      pruning in PR #89); the weekly reboot timer (PR #104);
    - F13c-5d: IAM, secrets, federation, alerts and the development deploy
      workflow (PR #107).
  - The production restore-check mode, before the F13d rehearsal (PR #106).
  - The QA environment specification and authorization request:
    `docs/engineering/2026-10-28-cloud-qa-readiness.md`.

  Recorded follow-ups:
  - stale `RECEIVED` operations (resolved in PR #85);
  - an owner ruling on terminal `FAILED` for retryable causes;
  - the remaining safe raw-read mappings (done; the paths that remain are
    deliberately fail-closed).

- [ ] **F13d: bounded cloud trial request.** Only after F13b and F13c, ask the
      owner for a specific resource, duration, cost and cleanup authorization
      (requested in `docs/engineering/2026-10-28-cloud-qa-readiness.md`,
      section 5; approved within the exact pinned scope on 2026-10-28; see
      `docs/engineering/2026-10-28-owner-qa-approvals.md`). Execution is still
      pending; normal PR #79 merge/review gates, owner-only prerequisites,
      runtime/cost/abort/cleanup bounds and separate R6 safety gates remain.
      The approval-recording turn performs no live work.
      Then deploy dev, verify posture (no public database, anonymous denial, no
      secrets in logs, remote audit retention, restore), and record resource IDs
      without credentials.

---

### Task 14: Acceptance, production readiness, and onboarding

**Files:**

- Create: `tests/acceptance/identity-and-authorization.acceptance.test.ts`, `tests/acceptance/provider-boundaries.acceptance.test.ts`, `tests/acceptance/operations-and-audit.acceptance.test.ts`, `tests/acceptance/observability.acceptance.test.ts`, `tests/acceptance/environment-isolation.acceptance.test.ts`, `tests/acceptance/portability.acceptance.test.ts`
- Create: `docs/implementation/ACCEPTANCE-MATRIX.md`, `docs/runbooks/production-readiness.md`, `docs/runbooks/provider-reconciliation.md`, `docs/runbooks/onboarding.md`, `docs/runbooks/incident-response.md`
- Modify: `docs/implementation/STATUS.md`, `README.md`

**Interfaces:**

- Produces: one traceable automated/manual acceptance record for every PRD section 21 criterion and every Engineering Design security invariant.

- [ ] **Step 1: Complete the automated acceptance matrix**

Map every PRD criterion and every normative Engineering Design obligation to a named test and verification command. Tests must cover identity mapping, permission boundaries, unified search/provenance/completeness, targeted fetch, routing/ambiguity, provider allowlists/roots/service identities, correction/protection/destructive/elevation policy, approvals, idempotency/restart/reconciliation, durable audit delivery/retention, required latency/error/timeout/partial/approval observability, rate limits, provider capability limitations, PostgreSQL, environment isolation, governance and Project Registry drift, and cloud portability.

- [ ] **Step 2: Run the complete automated gate from a clean checkout**

Run: `pnpm install --frozen-lockfile && pnpm verify && pnpm test:integration && pnpm test:acceptance && pnpm audit --prod --audit-level=high`

Expected: zero failed tests, zero type/lint/format/build/policy errors, and no known production dependency vulnerability at the configured high/critical gate.

- [ ] **Step 3: Run isolated live dev provider and end-to-end tests**

Exercise Notion search/fetch/write/trash/Inbox, Drive root search/fetch/write/trash, GitHub allowlisted search/fetch, real OIDC, mutation replay, unknown-outcome reconciliation, either-parent approval, and audit correlation using only designated dev roots.

- [ ] **Step 4: Complete manual production-readiness checks**

Verify anonymous denial, no public PostgreSQL, no secret retrieval, real AI-client auth, conversational approval review, representative cross-provider search, understandable provenance, safe production test-record writes, correction-window behavior, request/audit correlation, backup/restore, rollback, and least-privilege credentials.

- [ ] **Step 5: Promote the verified digest and validate Operator first**

Apply the reviewed production plan, migrate privately, promote the exact dev-validated digest, run smoke/security checks, and validate Operator's day-to-day workflow before enabling Steward and Participant.

- [ ] **Step 6: Onboard Steward and Participant separately**

**Prerequisite (owner requirement, 2026-10-26, from the PR #91 review):**
deterministic post-restore reconciliation must exist and be proven by a
synthetic loss-and-restore test. It requires:

- automated, read-only evidence collection;
- deterministic classification, settling outcomes only on positive proof;
- an operator report of unresolved outcomes, including lost-window request
  IDs, acknowledged by the owner before mutations reopen;
- no automatic re-execution.

See `docs/engineering/2026-10-26-recovery-point-investigation.md`,
section 9. The manual restore runbook is interim, for Operator-only
production use, and does not satisfy this prerequisite. It is a separate
slice from the backup work (R1–R6).

Create immutable subject bindings through the controlled flow, prove each role's allowed and denied cases, and confirm routine use plus approval requests require no repeated technical intervention.

- [ ] **Step 7: Close the v1 status only with evidence**

Record commit/image digests, CI runs, migration version, infrastructure plan/apply IDs, acceptance counts, manual checker/date, known limitations, rollback point, and owner acceptance. Mark v1 complete only when the PRD and Engineering Definition of Done are both satisfied.

## Acceptance trace summary

| Acceptance area                                   | Primary tasks       |
| ------------------------------------------------- | ------------------- |
| Identity and principal mapping                    | 2, 3, 4, 12, 14     |
| Authorization and destructive policy              | 5, 11, 12, 14       |
| Provider roots, allowlists, and service isolation | 6, 7, 8, 9, 13, 14  |
| Unified search, provenance, partial reads, fetch  | 7, 8, 9, 10, 12, 14 |
| Canonical writes and routing ambiguity            | 5, 7, 8, 11, 12, 14 |
| Idempotency, restart, unknown outcomes            | 3, 7, 8, 11, 14     |
| Approval durability and revalidation              | 3, 5, 7, 11, 14     |
| Audit and secret non-disclosure                   | 6, 11, 12, 13, 14   |
| Policy/governance drift                           | 3, 5, 13, 14        |
| Dev/prod isolation and portability                | 2, 6, 13, 14        |
| Manual deployment/readiness/onboarding            | 13, 14              |
