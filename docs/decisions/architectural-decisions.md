# Architectural decisions to preserve

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

## Architectural decisions to preserve

- The approved PRD controls behavior/security; Engineering Design controls
  architecture and sequence. Use bounded slices without redesigning v1.
- Exactly eight authenticated Brain operations. No raw provider proxy, embedded
  LLM router, GitHub mutation, cross-provider move, or autonomous action loop.
- Verified Google OIDC issuer/subject establishes human identity. Provider calls
  use independently scoped machine identities with server-side credentials.
- Participant is confined to Family Shared; creator correction uses
  `0 <= elapsed <= 900000 ms`. Protected/legal/governance rules take precedence.
- Ordinary patches accept string `title` and/or `content` only. A content field
  replaces the body regardless of the `patch` label. Unknown/provider/control
  fields are forbidden. Approval/elevation cannot override a forbidden action.
- Re-fetch authoritative scope, creator, creation time, protection and version
  before target operations. Client declarations never supply that authority.
- Deterministic canonical routing, governed roots, Registry allowlisting and
  drift validation remain mandatory; credential visibility grants no Brain scope.
- PostgreSQL stores minimal operational state and is never public. Preserve
  idempotency, non-expiring approvals and uncertain-outcome reconciliation.
- Audit leases, retry eligibility and acknowledgement timestamps use store time.
  Claim exactly one event per send; only a fresh, unexpired token may settle it.
  Revalidate after row-lock acquisition. Never keep a SQL transaction open for
  sink I/O, expose tokenless acknowledgement, or blindly rewrite an uncertain ack.
- Audited state transitions and outbox insertion commit on one storage transaction.
  Validate/snapshot metadata and real state enums before driver coercion. Derive
  audit correlation from the returned row, not caller declarations. Exclude the
  destination from expected states; a duplicate/conflict inserts nothing. This is
  not a legal transition graph or distributed exactly-once guarantee.
- Original evidence under legal hold is immutable through SIM-G (owner decision
  2026-10-22, policy `family-brain-v1.1.0`). The engine denies every mutation of
  a `legal_hold` target first; nothing approves or elevates past it. Additions
  are separate, dated, linked records; derived notes are never `legal_hold`.
- Elevation is a two-call flow on the same request ID and fingerprint. Issue
  only to the owning non-Participant principal of an `ELEVATION_PENDING` operation,
  revalidated under the operation row lock, superseding older live challenges.
  Revalidate the frozen target and policy before consumption, then consume and
  claim `EXECUTING` in one transaction; never dispatch on an ambiguous claim.
  Store only token hashes. Reconcile elevated unknown outcomes only under the
  exact consumed challenge and current policy version.
- `persist_knowledge` routes before opening state, derives scope from exactly one
  registered surface, stores no body, dispatches one create after the durable
  claim, commits completion before idempotent alias registration, and never
  re-creates after an uncertain outcome. The alias's gateway creator is the only
  creator source besides provider provenance; disagreement removes it.
- Family Inbox is the safe human approval projection; PostgreSQL is authoritative.
  Either parent may resolve after fresh authorization and target validation.
- Deletion is recoverable trash/archive. Core consumes ports, not provider SDKs.
- Dev/prod identities, credentials, roots, config and databases stay separate.
  Synthetic fixtures only; no secrets, family exports, logs or databases in Git.
- Environment-backed secrets are dev/test-only and explicitly injected behind
  the port. Snapshot allowlists/environment, read only the selected own string,
  observe source rotation/revocation on the next read, and never propagate raw
  errors or abort reasons. No arbitrary env lookup or implicit `process.env`.
  Returned values stay at the internal provider composition boundary.
- Each provider config declares `machineIdentity { environment, id }` separately
  from `credential { environment, kind, name }`. `kind` is limited to `secret` or
  `workload_identity`; `name` uses a conservative logical-handle grammar and is
  never treated as a URI or credential value. All three machine IDs must differ;
  all provider credential names and the database secret name must differ. Deployed
  adapters still verify real identity, provenance and scope.
- Knowledge-provider fakes snapshot independently configured roots/scopes, return
  normalized copies, and strip provider-native fixture fields. GitHub has no
  mutation/reconciliation surface. Notion/Drive fakes use recoverable trash and
  version preconditions; an uncertain result must be reconciled because repeating
  the provider operation fails. These test doubles are not live-provider proof.
- Construct Notion through the official SDK factory at API `2026-03-11`; do not
  use the SDK's older default or accept caller-selected base URLs, versions,
  retries or logging. Keep core free of the SDK. Only exact page/data-source
  roots are valid. Nearest configured root wins, so a restricted child never
  falls through to an authorized ancestor. Snapshot server-derived scopes before
  provider I/O, bound every cursor/ancestry/block traversal, report title search
  as partial, and map outside-scope and missing fetches to the same safe boundary.
- Keep governed Notion writes behind the separately frozen mutation SDK surface.
  Writable roots are exact data sources with stable IDs for title, operation
  marker, content type and full-body SHA-256. Create verifies stored complete
  Markdown before success. Every target write verifies current Markdown against
  stored integrity metadata, then re-authorizes the exact root and re-checks the
  expected version immediately before mutation. Repeat markers fail closed;
  unknown outcomes reconcile by stable marker, root, title, content type and body
  hash before any retry. Delete is recoverable trash only. Preserve the documented
  residual Notion race and partial-write operator path; do not claim atomic CAS.
- Keep Family Inbox SDK access separate from governed retrieval. Its frozen surface
  is page create/retrieve/update only. Snapshot one exact data source, distinct
  stable property IDs and all six status option IDs; accept only the approved safe
  fields within documented bounds. Verify direct parent and approval correlation
  before update and in the full post-write response. Partial/mismatched success is
  `outcome_unknown`, never permission to retry blindly. PostgreSQL is authoritative.
- Construct Drive through official `@googleapis/drive` `22.0.0`, with five-second
  request timeout, SDK retries disabled and a frozen surface containing only
  files list/get/export/create/update. Never expose permissions, permanent delete,
  `emptyTrash` or generic Drive operations. Enumerate exact configured roots with
  direct-parent queries; use `corpora=drive` plus `driveId` for Shared Drives and
  `corpora=user` otherwise, always with Shared Drive support flags and never
  `allDrives`. Nearest configured root wins and each candidate's bounded ancestry
  is revalidated. Google Docs export plus bounded UTF-8 text/Markdown/JSON are
  readable; only gateway-managed Markdown/plain text is mutable. Stable private
  `appProperties` markers support reconciliation, and delete means recoverable
  trash. Preserve the documented residual non-atomic Drive version race.
- Construct GitHub through official `@octokit/rest` `22.0.1` and
  `@octokit/auth-app` `8.3.1`, pinned to API `2026-03-10`, a five-second timeout,
  disabled logging and a frozen surface containing only installation repository
  listing, repository metadata, commit lookup, code search and file content.
  Request Contents read only. Require principal scope, live Registry and App
  installation to agree; absence is partial for search and safe not-found for
  fetch. Resolve the current default branch to a full SHA before targeted content
  reads, keep stable repository/path/blob provenance, and never add history,
  mutation, arbitrary endpoint or generic repository proxy behavior.
