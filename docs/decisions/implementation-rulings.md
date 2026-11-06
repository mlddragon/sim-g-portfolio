# Recorded engineering rulings

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

## Recorded engineering rulings

- F11 is split into mergeable vertical slices. F11a exposes only governed
  `update_record` orchestration. It persists a strict normalized mutation and
  canonical SHA-256 fingerprint before provider I/O; terminal replay returns the
  stored original operation ID. A provider-declared or structurally ambiguous
  outcome remains `OUTCOME_UNKNOWN` and reconciles before another write. A known
  pre-dispatch rejection becomes `FAILED`. Atomic transition acknowledgement loss
  is resolved by reloading the durable state, never by blindly repeating I/O.
  Approval-required and elevation-required decisions are durably staged, but
  F11b adds the actual approval rows, projection reconciliation and resolution;
  elevation challenges remain F11c.
- F11c completes elevated `update_record` without a parallel mutation path. The
  confirmation travels on the same request ID and is excluded from the
  fingerprint. Challenge issuance re-checks the pending owner under the
  operation row lock and supersedes older live challenges; consumption and the
  `ELEVATION_PENDING → EXECUTING` claim plus audit commit together after fresh
  target and policy revalidation. Drift settles `SUPERSEDED`, forbidden targets
  `FAILED`, transient errors leave the challenge usable, and an ambiguous claim
  never dispatches. An elevation-required decision for Participant fails closed
  rather than escalating. `ElevationService.confirm` was removed so
  `confirmAndClaim` is the only application consumption path.
- F11d adds governed creation to the same service. Routing errors are returned
  before an operation opens. A routed container registered under zero or several
  scopes fails closed. Approval- or elevation-gated creates fail closed with
  `gated_create_not_supported` until a frozen-target design for not-yet-existing
  records exists. No create body is stored in PostgreSQL. Gateway-created
  records carry the authenticated principal as alias creator; targeted writes
  merge it into fetched provenance and drop the creator when sources disagree,
  so Participant's exact correction window applies only to records she created.
- F11e generalizes the target pipeline with an internal update/append change
  rather than a parallel path. Append fails closed without a provider version.
  Approval resumption stays update-only, so approval-gated appends fail with
  `append_to_record_approval_not_supported`.
- Owner decision 2026-10-22 supersedes the open legal-hold append question:
  original evidence under legal hold is immutable through SIM-G. Executable
  policy `family-brain-v1.1.0` declares `legalHoldEvidence: immutable`, and the
  authorization engine denies any mutation of a `legal_hold` target before the
  forbidden-destructive, protection, approval, elevation and correction-window
  branches. The version bump voids approvals and elevation challenges issued
  under `family-brain-v1.0.0` (they supersede or fail instead of executing), and
  an elevated uncertain outcome from that version cannot reconcile
  automatically; drain in-flight operations before deploying a version bump.
  Once a target becomes legal-hold evidence, even read-only reconciliation of an
  earlier uncertain write is refused (fail closed, operator reconciliation). A
  second, adapter-level legal-hold guard is a recorded follow-up. The approved PRD
  and Engineering Design are unchanged; this decision is stricter than their
  legal-hold deletion rule.
- F11f routes deletes through the same `runTargetChange` path as update and
  append. Approval resumption is generalized by rebuilding the stored change
  (update payload or delete), with update fingerprints unchanged. Because a
  completed trash hides its target, uncertain deletes reconcile with access
  rebuilt from the alias, route and current surface authorization, completing
  only on this operation's trash marker and never re-dispatching. Approval-gated
  appends still fail closed; approval-gated deletes queue for either parent.
- F11g lets approval-gated appends queue for either parent. Only that
  transition may store an append body, enforced in the store's compare-and-set
  (append operations without a payload moving to `AUTHORIZATION_REQUIRED`).
  Every transition to `COMPLETED`, `FAILED`, `CANCELLED` or `SUPERSEDED` clears
  the stored payload, closing a pre-existing retention gap for update payloads;
  `EXECUTING` and `OUTCOME_UNKNOWN` retain it for recovery. Approval snapshots
  now also compare the provider record ID. A stored change that no longer
  validates resolves the approval as impossible.
- F11h: owner decision 2026-10-22 makes stranded-execution recovery
  reconcile-only. `recoverStrandedExecution` is owner-operator only and
  explicitly invoked, with a 15-minute minimum claim age. It resolves access from
  the original principal's current surfaces (or the frozen create route), makes
  one marker reconciliation, finalizes `COMPLETED` only on a matching reference
  and otherwise records `OUTCOME_UNKNOWN` with a metadata-only reason, keeping
  the payload. It never re-dispatches. Live executors that lose a completion
  compare-and-set to recovery return retryable `outcome_unknown`.
- F11i: a create has no record to freeze, so its elevation binds to a route
  token (SHA-256 of provider, container and Brain scope) in the existing
  `frozen_target_ids`. `ELEVATION_PENDING` stores the frozen container, scope
  and decision reason, never the body. Confirmation, uncertain-outcome
  reconciliation and stranded recovery all re-derive the route and evaluate
  under the exact consumed challenge.
- F6a adds `AuditedBrainOperations`, the single boundary F12 must call. It is
  written fresh rather than restoring the parked draft: one request-level event
  per call, outcome mapped from the response or error class, reason detail only
  when it is a safe identifier, principal attributed only from a consistent
  authenticated binding, and a retryable error when the outbox fails after a
  successful (idempotent) operation.
- F6b writes telemetry through a closed metric and label vocabulary rather than
  free-form tags, adopting the parked draft's allowlist idea without restoring
  its code. Telemetry uses its own stdout destination and a one-second write
  timeout and is strictly best effort.
- Owner decision 2026-10-23: approved executions that were claimed or may have
  reached the provider are never re-dispatched because reconciliation finds no
  marker. `recoverApprovedUpdate` now shares F11h's single-lookup settlement;
  the earlier F11b behaviour (re-dispatch after revalidation, `FAILED` on a
  changed target) is removed.
- F13c rulings:
  - **Design status.** The VM design is a proposal; nothing that depends on
    its owner decisions is merged.
  - **Transport (PR #79, pending owner):** the local socket or TCP with
    `verify-full`, and non-TLS TCP outside production only to loopback. The
    URL is validated against node-postgres's own parsed view, so the two
    parsers cannot disagree. Production TCP with `verify-full` is retained
    for the owner to keep or retire.
  - **Outage mapping:** only non-domain errors on reads, idempotent opens, and
    transition reloads (which rethrow the original mapped error) are mapped.
    Reconciliation flows are never blanket-mapped.
  - **Known gaps, recorded:**
    - a stale `RECEIVED` operation answered `operation_in_progress` forever
      (resolved in PR #85: settled `FAILED` after 10 minutes);
    - a failed mutation target lookup records terminal `FAILED`, which needs
      an owner ruling;
    - some raw reads remain (listed in `docs/runbooks/http-api.md`).
  - **F13c-5a Terraform:**
    - **Development is temporary.** It gets an ephemeral IPv4 (a reserved
      address left unattached bills about USD 7/month, which would break the
      budget), no VM deletion protection, and `deletion_policy = "DELETE"`.
      Its data is synthetic.
    - **Production is protected by `deletion_policy = "PREVENT"`** on the
      data disk, buckets, audit log bucket and static address, instead of
      `prevent_destroy`. The policy is kept in state, so it still holds when a
      resource block is removed.
    - **The project-label guard is a mistake check, not the dev/prod
      boundary.** Every resource takes its project from the guarded data
      source, so `-target` cannot skip it. The boundary is IAM (owner-gated).
    - **F13d preconditions recorded in `infra/google/README.md`:**
      - remove the `default` network;
      - handle the default Compute Engine service account;
      - enable Cloud Resource Manager and Service Usage first;
      - create a per-environment state bucket;
      - plan boot-image upgrades.
    - **Open for the owner (decision 8):** audit lines are also kept 30 days
      in `_Default`.
  - **F13c-5b host layer:**
    - **One source.** The units and scripts live in `deploy/vm/host` and
      reach the VM only through rendered `user-data`, which COS rewrites
      every boot. A provider-free Terraform module renders it, so the offline
      check validates exactly what the VM receives.
    - **The data disk** is mounted from its own by-id device after checking
      its label, never by label. It is formatted only when `blkid -p` finds
      no signature **and** the disk reads as zeros: the first and last
      16 MiB, and the first 64 KiB of every 8 MiB (every ext4 group start for
      1–4 KiB blocks). The reviews proved that `blkid` alone also reports "no
      signature" for a damaged ext4, a wiped head and read errors.
    - **Maintenance** (`/run/sim-g/maintenance`) stops PostgreSQL and the
      gateway from starting and pauses recovery. PostgreSQL's lock cannot see
      a second server in another container.
    - **Metadata isolation is one chain.** Only packets that both arrive on
      the gateway's fixed bridge (`sim-g-gw0`) and come from its subnet reach
      `169.254.169.254`, except DNS, which issues no credentials. An existing
      chain must match exactly, or the unit fails closed. Connection limits
      wait for F13c-3.
    - **Host settings** (`/mnt/disks/data/sim-g/host.env`) are read and
      validated by a wrapper and never loaded by systemd, so nothing in them
      acts before they are checked. They are limited to:
      - two images, digest-pinned in this project's Artifact Registry;
      - this project's backup bucket;
      - the age recipient.

      The file must be root-owned and not group- or world-writable. Neither
      it nor the gateway's document holds secrets.

    - **No automatic `initdb` or migration.** PostgreSQL refuses an
      unbootstrapped data directory. Migrations run only through the
      operator's `sim-g-migrate`, after a fresh backup run through its own
      unit.
    - **Recovery.** systemd never restarts a unit whose dependency failed, so
      a 5-minute timer starts the workloads again. A maintenance file pauses
      it.
    - **Deploys (F13c-5c)** switch images only after the new image's
      migrations succeed. A pending marker makes interrupted deploys finish
      or roll back. Only failed migrations or health reject a digest. The
      pointer can name any digest of the running repository, so promotion
      must restrict who writes it (F13c-5d).
    - **Dependencies before F13d:**
      - PR #79's socket transport, held for the owner;
      - Artifact Registry read access and the other grants (F13c-5d).
    - **Validator packages** for the check are installed from Debian at check
      time into a throwaway container from the pinned base. They never ship.
- F13b rulings:
  - **Capacity evidence is synthetic and local.** The harness runs the real
    `main()` but swaps only the outbound edges (providers, OIDC key, approval
    projection, audit sink), and runs only under `tests/capacity/`. It is
    never in the production image.
  - **Rate-limit seam.** `MainDependencies.rateLimits` lets the capacity run
    lift the per-minute limits for its labelled headroom phases, because every
    synthetic user shares one source address. Production passes nothing and
    keeps the defaults.
    - **Database outages should not surface as `internal_error`.** Fixed so far:
    - authentication maps a principal-store failure to retryable
      `provider_unavailable` / `principal_state_unavailable`, still
      fail-closed;
    - mutation target lookup maps to `record_reference_store_unavailable`;
    - search's alias writes already degrade to partial results, now pinned by
      a test.

    Not yet fixed (F13c, one call at a time, test-first): `openOperation`,
    approval listing and resolution, elevation, and some operation reads and
    transitions. A blanket store-level mapping is rejected, because the
    mutation state machine treats some domain errors as definite outcomes.

  - **Free-tier risk.** The cost model passes only with the billing account's
    free e2-micro allowance. F13d must confirm no other e2-micro uses it.
- F13a rulings:
  - Superseded topology. The Cloud Run/Cloud SQL Terraform built in this slice
    (module, dev/prod roots and 18 mocked-plan runs) is not merged. It is
    preserved on `archive/f13-cloud-run-cloud-sql` and the annotated tag
    `archive/f13-cloud-run-cloud-sql-v1` (both at `bcf08b7`). Its
    lessons carry into F13c:
    - no credential or SQL user in state;
    - per-secret access and impersonation-only Drive;
    - a deployer as powerful as the runtime, guarded by federation conditions
      (repository ID, ref, environment, workflow file, push or dispatch only);
    - owner project labels, refused unless they match the environment;
    - `pg` treats `sslmode=require` as full verification against public CAs.
  - Numbering. The owner's handoff named its next work F13a while PR #74
    already used that name. F13a therefore covers both the image and checks
    and the reconciliation (handoff step 1). F13b, F13c and F13d map to
    handoff steps 3 and 4 (cost), 2 and 4 (plan), and 5.
  - Review of PR #75 (same-model-family, separate context) found no Critical
    issues and four Important ones. All four were resolved here rather than by
    rewriting the owner's decision record:
    - a competing "next" pointer: AGENTS.md now defers to root `NEXT:`;
    - the breadth of "supersedes Task 13": PLAN Task 13 lists the binding
      safeguards;
    - Engineering Design authority: section 2 is amended, and the addendum is
      on the mandatory reading list;
    - the F13a numbering collision: the mapping is above.

    Its Minor points are folded into PLAN Task 13: the database transport
    rule, the exact free-tier terms, the mandatory dev deployment, network
    hardening, needing approval for any other configuration, and the CPU
    envelope.

  - The runtime image takes Debian security updates at build time. It is
    built once and promoted by digest.
- F12j ruling: audit delivery runs in the gateway process rather than as a
  separate scheduler. Passes are bounded by the outbox service, the loop stops
  before the pool closes, and the durable outbox carries anything undelivered
  to the next process. Telemetry is the strictly best-effort Cloud Logging
  sink.
- F12i rulings:
  - Drive authenticates by impersonating its configured service account from
    the runtime's Application Default Credentials, with only the Drive scope
    and no delegates. Human user and workforce-user credentials are refused as
    the source; the source is allowlisted (metadata-server identity, plus a
    service-account key outside production), never denylisted.
  - `google-auth-library` is pinned to 10.5.0 because the Drive SDK's
    `googleapis-common` already uses it, so the auth types match and no new
    package version is added.
  - `main` never runs migrations. It defaults to one trusted proxy hop
    (Cloud Run) and the working directory's `config/policy/`.
  - Startup failures emit one fixed JSON reason and exit 1.
- F12h rulings:
  - There is one governed root per registered container per provider, and its
    root reference is the policy container key.
  - Configuration names containers, never scopes, and `legalHold` only
    tightens `protected` roots.
  - Surfaces are registered only for configured containers, because a guard
    rejects access to a root reference it does not hold.
  - Root nesting is checked at startup through each root's ancestry,
    resolving the F12g follow-up.
  - Drive workload credentials are injected, and building them is part of
    F12i.
- Owner decision 2026-10-24 (container record policy and GitHub):
  - The executable policy (`family-brain-v1.2.0`) assigns `family_shared` and
    `parent_and_stewardship` their own scope and sensitivity with no protected
    class, and `protected` the `legal` scope with protected sensitivity and
    class.
  - The generic `restricted` container is not registered. P3 records require
    explicit, narrowly scoped access and must not become readable by both
    parents merely because they are restricted; restricted roots will be
    authorized separately later.
  - Operator and Steward keep `legal` access, legal-hold originals stay immutable,
    and nested protected roots take precedence (nearest configured root wins).
  - GitHub is visibly unavailable until the canonical Project Registry is
    bound.
- F12g rulings:
  - The planned F12g splits again: the container policy, surfaces,
    precedence tests and unavailable GitHub here; provider settings and
    factories in F12h; `main()` in F12i.
  - Configuration may only tighten a `protected` root to `legal_hold`, never
    choose a scope or sensitivity.
  - The guards resolve the nearest configured root, which cannot detect a
    less restrictive root configured inside a more restrictive one. That is a
    configuration rule for now, and startup ancestry validation is a
    follow-up.
- F12f rulings:
  - Building real adapters needs settings the original `EnvironmentConfig`
    lacked, so the planned F12f is split three ways: F12f (secret-provider
    selection and runtime loaders), F12g (provider adapter settings and
    factories) and F12h (`main()`).
  - `EnvironmentConfig` gains a required `secrets` section. Environment
    variables are allowed for `development` and `test` only. Secret Manager is
    allowed for `development` and `production` and requires the project
    number.
  - The bindings must cover exactly the secret-backed handles, so a missing
    binding fails closed and an extra one cannot widen what the service can
    read.
- F12e ruling: F12e covers application composition from already-built adapters
  (`composeGateway`) and the server lifecycle (`startServer`). Building the
  real adapters from `EnvironmentConfig` and the `main()` entry point are split
  into F12f, so each slice stays reviewable. Database-backed API tests use
  synthetic identity and provider fakes over the real PostgreSQL store.
- F12d rulings:
  - Rate limiting uses a small in-process fixed-window limiter instead of the
    unused `@fastify/rate-limit` dependency, which was removed. The reasons are
    keys that exist only after authentication (verified principal and client
    ID), an injected clock for deterministic tests, and 429s that go through
    the safe error envelope.
  - `rate_limited` is a transport-only code, so the domain error list, the
    `operations.error_code` CHECK and the audit enum are unchanged.
  - Limits are per instance, and LRU eviction bounds tracked keys at the cost
    of resetting an evicted key's count.
  - IP keys are normalised: IPv4-mapped addresses collapse to IPv4, and IPv6
    clients are keyed by their /64.
- Dependency ruling (2026-10-23): a high-severity advisory fix may use a pinned
  patched release younger than the usual two-week age, when the lockfile change
  is limited to that package and all gates pass. `zod` 4.6.6 (released
  2026-10-11) was taken under this rule for GHSA-mrhx-c7xc-m3w5; 4.6.7 (one day
  newer) was not needed.
- F12c ruling: the F12a "gateway always generates request IDs" ruling covers
  the HTTP correlation ID only. PRD §15 makes every mutation carry a stable
  client idempotency/request ID, and Postgres replays by unique `(principal_id,
operation_type, request_id)`. So mutation bodies carry the client
  `requestId`, which becomes the operation's request context (and its audit
  events' `requestId`). The operation ID is derived as `op_` plus the SHA-256
  of the verified principal, the operation and that request ID. The global
  `operations.id` key therefore cannot be squatted, probed or overwritten by
  another principal. The principal and client ID still come only from the
  verified caller. Mutation logs carry the derived `operationId` and the
  `clientRequestId`. `completed` is `200`, `failed` (including a policy denial)
  `422`, and follow-up states `202`. Text containing NUL or lone surrogates is a
  client error: the transport, the mutation service and the approval reason
  check refuse it, and the store maps the `jsonb` failure to `invalid_request`
  when opening an operation.
- F12a rulings: JSON fields keep the domain's camelCase names, matching the
  audit serializer and `DomainError.toResponse`; the design's snake_case JSON
  examples are illustrative. The gateway always generates request IDs and
  ignores client `x-request-id`. Authentication runs in `onRequest` so
  unauthenticated bodies are never parsed. The transport caps search at 50
  results (service ceiling 100). Fastify `inject` tests need no database, so
  they live in `tests/unit/api`; database-backed API tests come with the
  bootstrap slice.
- F6c Google Secret Manager rulings: the adapter serves only `development` and
  `production` (tests use the environment adapter); it requires the numeric
  project number so returned resource names can be matched exactly; it requires
  a matching CRC32C on every payload rather than trusting a missing checksum; it
  replaces the parked draft's unbounded version cache with a TTL- and
  entry-bounded LRU that evicts every cached version of a secret on any failed
  fetch; and the dependency is pinned to 7.1.1 (7.2.0 is under two weeks old)
  with the protobufjs lifecycle script denied.

- Ordinary update patches accept only string `title` and/or `content`. A supplied
  content field replaces the body and receives the same destructive policy as
  explicit `replace`. Unknown provider/control fields and malformed updates are
  forbidden. Approval or elevation never overrides a forbidden classification.
  This implements the existing PRD destructive/protected rules without changing
  the eight-operation surface or Participant's 15-minute boundary.

- Use issuer plus Google OIDC `sub` as the durable external identity binding. Email is validated and retained only as non-authoritative metadata.
- Keep cryptographic identity proof and local authorization identity distinct:
  `IdentityProvider` returns a provider-neutral `VerifiedExternalIdentity`, then
  `AuthenticationService` alone applies the PostgreSQL issuer-plus-subject
  binding and returns an `AuthenticatedPrincipal`.
- Accept both Google-documented issuer spellings but normalize them to
  `https://accounts.google.com` before state lookup. Require one exact audience;
  if `azp` exists, it must match that audience.
- Use recoverable Notion trash and Drive trash for `delete_record`; permanent provider deletion is outside v1.
- A successful `delete_record` means the provider record entered its recoverable trash/archive state. Restoration follows the provider recovery runbook and retention; the gateway exposes no permanent purge in v1.
- Scope mutation idempotency by principal, operation type, and request ID. Reuse with a different request fingerprint returns `idempotency_conflict`.
- Evaluate Participant's window at request time with `elapsed <= 15 minutes`; protected and legal-hold rules run first.
- Treat a destructive full replacement as a destructive mode of `update_record`, not a ninth public operation.
- Search only authorized registered surfaces; a provider with no authorized surface is omitted, not reported as failed.
- PostgreSQL is authoritative for approvals; Family Inbox is a safe human-facing projection whose update failures are reconciled.
- Governance drift blocks production promotion and is never resolved by an LLM at request time.
- Permitted elevated destructive actions use a one-time five-minute server challenge bound to principal, exact targets, request fingerprint, operation, and policy version, followed by fresh authorization/state validation. Participant cannot elevate.
- Every target update, append, replacement, or deletion re-fetches authoritative current provider metadata before authorization and uses a provider version/precondition where supported.
- The Project Registry adapter starts fail-closed with no repositories and requires independent snapshot hash plus live source-marker validation before a repository can participate in search.
- Notion v1 search uses the official integration-visible title/index and registered data-source capabilities; it does not claim exhaustive provider full-text search. Search completeness and manual body-only quality probes must expose this limitation.
- `resolve_approval` accepts parent/steward decisions `approve`, `decline`, or `cancel`; Participant cannot resolve or cancel through the v1 operation surface.
- All eight operations and denied authorization decisions emit metadata-only audit events through a PostgreSQL outbox. Required latency/error/timeout/partial/approval measures use a separate provider-neutral telemetry port.
- `DomainError` snapshots only finite JSON-safe details, rejects unsafe object prototypes and cycles, and never serializes its cause or stack.
- Runtime configuration accepts environment-tagged resource and secret references only. Any development/test/production reference mismatch fails closed without exposing the reference value.
- Knowledge adapters are capability-shaped as searchable, fetchable, or mutable. The mutable type excludes `github`, so GitHub mutation is invalid at compile time as well as absent at runtime.
- Identity, operational state, audit, telemetry, secrets, governed-provider access, Family Inbox projection, governance sources, and time are inward-facing ports. Core source has an executable forbidden-import check for provider, cloud, transport, and database SDKs.
- SQL migration versions use six-digit immutable filenames plus SHA-256 body
  hashes. Duplicate versions, filename drift, and content drift fail closed
  before additional schema mutation; each new file applies transactionally
  under a PostgreSQL advisory lock.
- Local destructive integration helpers accept only a loopback PostgreSQL URL
  whose database name ends in `_test`; the migration CLI additionally requires
  the `gateway_test` role. CI creates a fresh non-superuser `gateway_test` role
  rather than running integration behavior as the container administrator.
- Audit outbox serialization projects an exact runtime metadata allowlist in
  both directions. TypeScript excess properties cannot place unrecognized
  content or secret-shaped fields into the JSONB audit event.
- `transitionOperationWithAudit` commits the state change and its audit on one
  database client/transaction. The audit argument carries only event/reason/hash
  metadata; correlation and provenance are derived from the updated operation.
  Metadata and state enums are validated/snapshotted before driver coercion, and
  the same provider-neutral audit validator guards outbox insertion and output.
  Same-state expected sets are rejected; full legal transitions remain F11 work.
  A database error can hide a successful COMMIT: reload state before retry and
  never repeat provider I/O blindly. The event's actor is the operation initiator;
  approval resolution must retain the parent's independent operation/audit context.
- Audit delivery claims use database time, one row per acquisition, and a fresh
  token. Acknowledgement/retry locks first, then revalidates ownership and expiry;
  tokenless settlement is removed. Network output occurs outside SQL transactions.
  Delivery is at least once; local acknowledgement does not prove cloud retention.
- Environment-backed secret resolution is dev/test-only, requires an explicit
  source and logical-name allowlist, and refuses production before reading values.
  Environment/bindings are snapshotted; values are not cached. Only the selected
  own string property can resolve, so source edits/deletion apply on the next read.
  All explicit versions are unsupported; returned `environment` is a source marker,
  not a version pin or stable cache key. Raw abort/source failures never escape.
  Values remain plaintext only at internal provider composition; no public secret
  operation is added. Tags do not establish actual credential provenance or IAM.
- Provider access configuration separates an environment-tagged machine identity
  from its environment-tagged credential handle. Machine IDs are unique across
  Notion, Drive and GitHub; credential handles are unique across those providers
  and the database. A closed mechanism plus conservative logical name replaces
  free-form credential URIs. Parser guarantees do not prove underlying secret
  uniqueness, deployed identity, IAM, or reuse across separately parsed dev/prod
  files; deployment and acceptance must.
- Notion retrieval uses the official `@notionhq/client` `5.26.0` factory pinned
  to API `2026-03-11`, a five-second SDK timeout, disabled retries and no-op SDK
  logging. Core remains SDK-free. Only exact page/data-source roots are valid;
  nearest configured root wins and server-derived access is snapshotted before
  I/O. Native title search is always partial. Ancestry, cursors, search pages,
  block depth, request count and block count are bounded; outside-scope and
  missing fetches share a safe response. SDK cancellation discards late results
  but does not prove transport abort.
- The Family Inbox adapter has a separate frozen SDK surface containing page
  create/retrieve/update only. It snapshots one exact data source, nine distinct
  stable property IDs and all six status option IDs. Runtime input accepts only
  the safe approval/request/operation IDs, requester display name, action, target,
  status and optional resolution reason within fixed bounds. Update pre-validates
  direct parent and stored approval ID; both writes require the full post-write
  response to prove exact parent and correlation. Partial/mismatched results and
  post-dispatch cancellation are non-retryable `outcome_unknown`. PostgreSQL stays
  authoritative and reconciliation precedes any retry.
- Governed Notion mutations use a separately frozen official SDK surface and
  exact writable data-source targets with four stable property IDs: title,
  operation marker, content type and complete-body SHA-256. Create synchronously
  stores and then re-reads the complete Markdown before success. Every target
  write verifies live Markdown against stored integrity metadata and then
  re-fetches authorization, exact root, expected version, marker and metadata
  immediately before mutation. Repeat markers fail closed. Reconciliation keys
  bind operation, root, title, content type and intended body without exposing
  content. Delete is recoverable trash only. Notion has no atomic conditional
  page/Markdown write; preserve the documented residual race and manual handling
  for metadata-ahead-of-body partial updates rather than blind retry or auto-repair.
- Drive access uses official `@googleapis/drive` `22.0.0` behind a frozen client
  surface limited to files list/get/export/create/update. SDK retries are disabled
  and requests have a five-second timeout. Exact roots are enumerated with direct
  parent queries, `corpora=drive` plus `driveId` for Shared Drives or
  `corpora=user` otherwise, always with Shared Drive support flags and never
  `allDrives`. Nearest-root authorization, ancestry, pagination, files and content
  bytes are bounded. Google Docs export and UTF-8 plain text/Markdown/JSON are
  readable; only gateway-managed Markdown/plain text is mutable. Private
  `appProperties` markers support reconciliation and deletion is recoverable
  trash. Because Drive provides no supported atomic file-version precondition for
  `files.update`, retain the final refresh/post-write verification and explicit
  uncertain-outcome path rather than claiming atomic compare-and-set behavior.
- GitHub retrieval uses official `@octokit/rest` `22.0.1` and
  `@octokit/auth-app` `8.3.1`, API `2026-03-10`, a five-second timeout, no-op
  logging and a frozen five-call read surface. Tokens request Contents read only.
  Every operation intersects principal scope, an independently hash/marker-locked
  live Project Registry and the App installation set. Search adds one exact repo
  qualifier and preserves partial coverage; fetch resolves the current default
  branch and reads by full commit SHA. Paths/content are bounded and only UTF-8
  regular files are returned. GitHub has no mutation or generic endpoint surface.
- Repository verification currently passes locked-policy verification,
  formatting, typed lint, strict type checking, 625 unit/contract tests,
  ESM/declaration build, 54 PostgreSQL integration tests,
  lockfile supply-chain verification, and a
  high-severity production dependency audit.
