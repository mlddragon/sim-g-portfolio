# Authenticated HTTP API

> **Hosting note (2026-10-24).** Cloud Run references below describe the
> earlier deployment target. Production is now one Compute Engine `e2-micro`
> (PLAN Task 13). F13c revisits the production defaults that assumed Cloud Run:
> `GATEWAY_TRUSTED_PROXY_HOPS` 1, `GATEWAY_HOST` `0.0.0.0`, and the shutdown
> grace period. Until then, set them explicitly for the VM's actual ingress.

`buildApp` (`src/api/build-app.ts`) is the Fastify composition root. It exposes
liveness and all eight Brain operations: `search_brain` (F12a);
`fetch_record`, `list_approvals` and `resolve_approval` (F12b); and
`persist_knowledge`, `update_record`, `append_to_record` and `delete_record`
(F12c), with per-minute rate limits (F12d). `composeGateway`
(`src/bootstrap.ts`) wires it to the application services and `startServer`
(`src/server.ts`) runs it (F12e). Building the real adapters from the environment
configuration and the `main()` entry point are F12f.
Nothing is deployed. Route tests use Fastify `inject`; the server tests bind
loopback HTTP.

## Composition and server lifecycle

`composeGateway(ports, apiOptions)` takes already-built adapters (the
operational state store, the identity provider, the Notion and Drive mutable
providers, the read-only GitHub provider, registered surfaces, the approval
projection, the executable policy, the clock and optional telemetry). It wires
the authorization engine, router, destructive classifier, approval coordinator,
elevation, mutation, query and approval services behind
`AuditedBrainOperations`, with `AuthenticationService` as the only identity
path. Every Brain operation therefore reaches the client only through the
single audited boundary.

`startServer(app, {port, host, shutdownTimeoutMs, resources})` listens (on
`0.0.0.0` by default, as Cloud Run requires) and installs graceful shutdown on
`SIGTERM` or `SIGINT`. The steps run under one deadline (`shutdownTimeoutMs`,
default 8 s, inside Cloud Run's 10 s grace period):

1. Stop accepting requests and drain the in-flight ones, using three quarters
   of the deadline. Fastify closes only connections idle at that moment, so
   idle keep-alive connections are swept every 25 ms until the server closes;
   a request in flight therefore finishes and its socket closes promptly
   instead of holding the drain open. Connections still open at the drain bound
   are destroyed.
2. Close every resource (such as the database pool) in parallel within the
   rest of the deadline. A resource that fails or hangs is logged by name and
   outcome only.

A repeated signal during shutdown is absorbed instead of killing the drain.
Shutdown is idempotent, and its signal listeners are removed once it finishes.
If the port cannot be bound, the app and resources are closed and the error
rethrown. `closed` settles when shutdown finishes; the entry point (F12f) exits
the process with a status code after it.

## Routes

| Route                                   | Authentication | Purpose                                                                        |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| `GET /healthz`                          | None           | Liveness only: `{"status":"ok"}`. No version, environment or dependency state. |
| `POST /v1/operations/search_brain`      | Bearer token   | Unified search through `AuditedBrainOperations`.                               |
| `POST /v1/operations/fetch_record`      | Bearer token   | Full content of one authorized record.                                         |
| `POST /v1/operations/list_approvals`    | Bearer token   | Approvals visible to the caller's role.                                        |
| `POST /v1/operations/resolve_approval`  | Bearer token   | Approve, decline or cancel one approval.                                       |
| `POST /v1/operations/persist_knowledge` | Bearer token   | Create one routed record.                                                      |
| `POST /v1/operations/update_record`     | Bearer token   | Patch or replace one record.                                                   |
| `POST /v1/operations/append_to_record`  | Bearer token   | Append content to one record.                                                  |
| `POST /v1/operations/delete_record`     | Bearer token   | Recoverable trash of one record with explicit intent.                          |

Every other method or path, including unknown or "raw provider" operations,
returns `404` with `not_found` / `route_not_found`, before any body is read.
A malformed URL returns `400` `invalid_request` / `bad_url` through the same
envelope, headers and log line, and its path is never echoed. There is no
generic provider route.

## Authentication

`Authorization: Bearer <token>` (scheme case-insensitive) is parsed in
`onRequest`, before the body is read, and verified by `AuthenticationService` (Google OIDC plus the immutable
principal binding). A missing, malformed or oversized (over 16 KiB) header
returns `401` `bearer_token_required` with `WWW-Authenticate: Bearer`, and no
service is called. Identity never comes from the body or headers: the search
body is strict, so fields such as `principalId` or `user` are rejected. The
request context's `clientId` comes only from the verified identity.
Authentication has its own deadline (`operationTimeoutMs`); an identity
provider that never answers yields a retryable `503` `provider_unavailable` /
`authentication_timeout`.

## Request IDs

The gateway always generates the HTTP correlation ID (`req_<uuid>`). A client
`x-request-id` header is ignored. The ID is returned in the `x-request-id`
response header, in every error body and in the search response, and it
correlates request logs and read-operation audit events.

Mutations are different (PRD §15): the body carries the client's stable
`requestId`, which is the idempotency key. It becomes the operation's request
context and the mutation audit events' `requestId`. The operation ID is never
client-chosen: it is `op_` plus the SHA-256 of the verified principal, the
operation name and the client `requestId`, so it is stable across one
principal's retries and cannot be claimed or blocked by another principal.
Repeating the same `requestId` returns the original or reconciled result;
reusing it for different content is a `409` `idempotency_conflict`. Another
principal using the same `requestId` simply gets their own operation. The
mutation log line carries the derived `operationId` and the `clientRequestId`
to join HTTP logs with audit events.

## `search_brain`

Body (JSON only, at most 16 KiB): `{"query": string, "limit": integer}`. The
query is 1 to 2,048 characters and not blank. `limit` is 1 to 50, below the
service ceiling of 100. The response is the domain `SearchBrainResponse`
projected field by field: `requestId`, `results` (summaries with ISO
timestamps) and `completeness`. JSON field names are the domain's camelCase
names, matching the audit serializer and the existing error body.

## `fetch_record`

Body (at most 4 KiB): `{"brainRecordId": string}`, where the ID is 1 to 512
printable ASCII characters without spaces. Provider record IDs, provider hints
and identity fields are rejected. The response is `{"record": ...}`: the search
summary fields plus `content` and `contentType`, projected field by field. This
is the only route that returns full content. Authorization is re-evaluated by
the fetch service, which reports an unauthorized record exactly like a missing
one (`404` `not_found` / `record_not_found`), so existence never leaks.

## `list_approvals`

Body (at most 1 KiB): `{}`, or no body with no `content-type` header (an empty
body declared as JSON is `invalid_json`). Filters and identity fields are rejected;
the caller's role decides visibility in the approval service. Each item has
`approvalRequestId`, `operationId`, `status`, the safe `summary`
(`requestedByDisplayName`, `action`, `safeTargetDescription`) and `createdAt`.
No mutation payload or protected detail is projected.

## `resolve_approval`

Body (at most 8 KiB): `{"approvalRequestId": string, "resolution": "approve" |
"decline" | "cancel", "reason"?: string}`. The reason, when present, is 1 to
1,000 characters with no leading or trailing whitespace, mirroring the service's
validation. It is not stored: the service records a fixed reason code for the
resolution.
The resolver is always the authenticated caller; resolver, identity and
elevation fields are rejected. The response is `approvalRequestId`,
`operationId`, `approvalStatus` and `operationState`. Replays and reconcile-only
recovery are handled by the approval service.

## Mutations

Every mutation body is strict and carries `requestId` (1 to 512 printable
ASCII characters without spaces) plus an optional `elevation` confirmation
`{challengeId, confirmationToken}` (token 1 to 512 characters); a client
`operationId` is rejected.
Principal, client ID, creator, scope, protection class and any other identity or
policy field are rejected. The principal and client ID come only from the
verified caller. All text must be storable: a NUL character or a lone UTF-16
surrogate is rejected as `invalid_request_body`. The mutation and approval services refuse
it too, and the store maps it to `invalid_request` when opening an operation.

- `persist_knowledge`: `title` (1 to 2,000 characters), `content` (1 byte to
  1 MiB of UTF-8) and strict `semanticMetadata` (`subject`, `domain`,
  `recordType`, `durability`, `provenance`, `projectReference` of at most 512
  characters; `sensitivity`; an advisory `canonicalHint` of `provider` and/or
  `containerRef` that never overrides routing).
- `update_record`: `brainRecordId` and `mutation`, either `{"mode": "patch",
"patch": {title?, content?}}` with at least one field, or `{"mode":
"replace", "replacement": {title?, content}}`. Content is at most 1 MiB of
  UTF-8, and a patch may set `content` to `""` to clear it.
- `append_to_record`: `brainRecordId` and non-blank `content` (at most 1 MiB).
- `delete_record`: `brainRecordId` and `explicitIntent: true` (literal); no
  batch or permanent fields.

Responses project only `operationId`, `state`, an optional `brainRecordId`,
the provider `record` reference and, for `elevation_required`, the one-time
`elevation` grant `{challengeId, confirmationToken, expiresAt}`. The grant goes
only to the caller in the response body and is never logged. Request content is
never echoed. Status: `completed` is `200`; `failed` is terminal (including a policy
denial) and returns `422`, so a status-only client never reads it as success;
`approval_required`, `elevation_required` and `outcome_unknown` need follow-up
(`202`). To confirm elevation, repeat the same body and keys with `elevation`
added.

## Errors

Every error body is `{"error": {"code", "retryable", "details"}, "requestId"}`.

| Code                                                                                                            | Status |
| --------------------------------------------------------------------------------------------------------------- | ------ |
| `invalid_request`                                                                                               | 400    |
| `unauthenticated`                                                                                               | 401    |
| `unauthorized`, `protected_record`, `approval_required`, `elevation_required`, `environment_boundary_violation` | 403    |
| `not_found`                                                                                                     | 404    |
| `idempotency_conflict`, `outcome_unknown`                                                                       | 409    |
| `insufficient_metadata`, `routing_ambiguous`, `provider_capability_unsupported`                                 | 422    |
| `internal_error`                                                                                                | 500    |
| `provider_unavailable`, `partial_results`, `policy_drift`                                                       | 503    |

Transport failures use `invalid_request` with a fixed reason: `invalid_json`
(400), `body_too_large` (413), `unsupported_media_type` (415) or
`invalid_request_body` (400). These transport reasons apply only to failures
raised before the route handler runs; an application error is never mapped to
one. JSON containing `__proto__` or `constructor`
keys is rejected as `invalid_json`. Any other unexpected failure becomes a
generic `internal_error` with empty details. Messages, stacks, SQL and
provider detail are never returned or logged.

### Database outages

A dropped or refused PostgreSQL connection answers a retryable `503`
`provider_unavailable`, never a `500`, at these points:

| Path                                                                                                                                                                                          | Reason                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Principal lookup during authentication (still fail-closed)                                                                                                                                    | `principal_state_unavailable`           |
| Opening or finding a mutation's durable operation (before any provider call)                                                                                                                  | `operation_state_unavailable`           |
| `fetch_record`'s record-reference lookup                                                                                                                                                      | `record_reference_store_unavailable`    |
| Listing approvals; reading an approval, its operation or its requester to resolve it; creating the approval request                                                                           | `approval_state_unavailable`            |
| Reading the operation after its approval request was created                                                                                                                                  | `approval_operation_state_unavailable`  |
| Reading the outcome after an approved change was resumed, reconciled or recovered (it may have executed: retry the same resolution to read the outcome, which replays without a second write) | `approval_resolution_state_unavailable` |
| Loading an operation to issue or confirm an elevation challenge                                                                                                                               | `elevation_state_unavailable`           |
| A state transition the store could not commit, including when the follow-up reload also fails                                                                                                 | `operation_audit_state_unavailable`     |
| Enqueueing the request's audit event                                                                                                                                                          | `audit_state_unavailable`               |

Search keeps the partial-result behaviour of a failed provider pass instead.

What a retry with the same `requestId` does:

- **Nothing was recorded:** the retry proceeds normally.
- **The operation was opened but is still `RECEIVED`**: the insert
  committed, then the acknowledgement was lost, or the request was aborted
  or failed before it claimed the operation. No provider write was ever
  dispatched, because dispatch always follows the `EXECUTING` claim.
  - For 10 minutes (five times the largest configurable request deadline),
    retries answer `operation_in_progress` (503).
  - After that, the next retry settles the operation `FAILED`
    (`provider_unavailable`, reason `operation_abandoned_before_dispatch`;
    HTTP 422 `failed`), and later retries replay that. Concurrent retries
    settle it once.
  - If a lingering original request claims the operation first, the retry
    answers from the operation's current state (`operation_in_progress`
    while it executes). Once settled, the original's own claim fails, so it
    never dispatches.

  Retry with a new `requestId`; it cannot duplicate anything.

- **The mutation's target lookup failed** inside preparation: the operation is
  recorded terminal `FAILED` with error code `provider_unavailable` (HTTP 422
  `failed`), and the same `requestId` replays that. Retry with a new
  `requestId`. Whether a retryable cause should leave a terminal `FAILED` is
  an owner ruling.
- **An operation is left `EXECUTING`**, for example after a provider call:
  retries answer `operation_in_progress`. Recovery happens only through the
  owner-operator's explicit stranded-execution recovery, after the documented
  staleness period ([stranded execution recovery](stranded-execution-recovery.md)).
  Nothing does it automatically.

Other existing reasons on these paths:

- `created_alias_unavailable`: a create completed, but its record reference
  could not be stored. A retry replays the stored outcome.
- `recovery_operation_state_unavailable`: an approved or stranded recovery
  could not read its operation.
- `record_reference_store_unavailable` on a mutation's target lookup: the
  operation is recorded `FAILED`, as described above.
- `approval_resolution_state_unavailable`: also returned when any resolution
  commit (approve, decline, cancel, impossible) cannot be confirmed.

**Remaining raw-error paths** (still `500`, fail-closed), deliberately not
mapped:

- **Reconciliation-attempt reads and writes** (`listReconciliationAttempts`,
  `recordReconciliationAttempt`) and the consumed-elevation lookups that feed
  a reconciliation's create authorization, because those flows decide
  outcomes. They are HTTP-reachable through:
  - a mutation's own `OUTCOME_UNKNOWN` replay;
  - a parent's resolve replay of an approved change (`OUTCOME_UNKNOWN`
    reconcile, or `EXECUTING` recovery).
- **The owner-operator's stranded-execution recovery entry**
  (`recoverStrandedExecution`), which has no HTTP route.

## Limits and cancellation

The global body limit is 64 KiB. Routes set their own limits: search 16 KiB,
fetch 4 KiB, list 1 KiB, resolve 8 KiB, delete 8 KiB, and 2 MiB for persist,
update and append. Send non-ASCII text as raw UTF-8: 1 MiB of content then fits
with room for metadata. Heavily escaped content (`\uXXXX` forms of emoji or
control characters) can exceed 2 MiB and receive `413` even though its
decoded content is within 1 MiB. Each operation runs under
an `AbortSignal` that aborts on client disconnect or at the operation deadline
(`operationTimeoutMs`, default 25 s, at most 120 s). At the deadline the response
is a retryable `503` `provider_unavailable` / `operation_timeout`, even if the
operation ignores its signal; that work may still finish in the background,
where idempotency and reconciliation govern it. A disconnect is recorded as
`client_closed`. Node's `requestTimeout` (deadline plus 5 s) bounds only
receipt of the request.

Known transport limits: a `charset` other than UTF-8 is still decoded as UTF-8,
`content-encoding` is ignored (a compressed body fails as `invalid_json`), and
Fastify's 503 during shutdown (`return503OnClosing`) has its own minimal body
without the security headers.

## Rate limits

Every bucket is an in-process fixed one-minute window, so limits are per
instance; with several Cloud Run instances the effective limit scales with the
instance count. Each bucket tracks at most `maxTrackedKeys` keys (default
10,000) and evicts the least recently used key beyond that, which keeps memory
bounded under key flooding at the cost of resetting the evicted key's count.
A fixed window can admit up to twice a limit across a window edge.

| Bucket                   | Key                | Default per minute | When                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ip_rate_limited`        | Client IP          | 120                | Every request except liveness, including malformed URLs, before authentication and before any body is read; unknown-route probes count.                                                                                                                                                                  |
| `health_rate_limited`    | Client IP          | 600                | `GET /healthz` only.                                                                                                                                                                                                                                                                                     |
| `principal_rate_limited` | Verified principal | 120                | Every operation, after authentication and before the body is read.                                                                                                                                                                                                                                       |
| `mutation_rate_limited`  | Verified principal | 30                 | The four mutation routes, in addition to the principal bucket.                                                                                                                                                                                                                                           |
| `client_rate_limited`    | Verified client ID | 600                | Operations whose verified identity carries a client ID, shared across principals. The Google OIDC adapter sets the client ID to the configured audience, so in practice this is one shared bucket per instance; keep it well above the per-principal limit or one principal can exhaust it for everyone. |

The client IP is `request.ip` as resolved through exactly `trustedProxyHops`
trusted hops: with no trusted hop `X-Forwarded-For` is ignored, and with one
(Cloud Run) only the rightmost entry, appended by Google's front end, is used,
so client-added entries cannot rotate the key. The key is normalised: every
form of one IPv4 address (including IPv4-mapped IPv6) is one key, and an IPv6
client is keyed by its /64, so rotating addresses inside one subscriber block
cannot evade the limit. Malformed URLs, which Fastify answers before any hook,
are counted against the same IP bucket. No header, body field or
declared identity selects a bucket; a failed authentication is never counted
against a principal. An exceeded bucket returns `429` with `Retry-After`
(seconds until the window ends) and the safe envelope `{"error": {"code":
"rate_limited", "retryable": true, "details": {"reason": "<bucket>"}},
"requestId"}`. `rate_limited` is a transport-only code: limiting happens before
any operation, so it never appears in operation state or audit events. All
limits are configurable through `rateLimits` (1 to 1,000,000).

## Headers and proxies

Every response carries `cache-control: no-store`, `x-content-type-options:
nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY` and
`content-security-policy: default-src 'none'; frame-ancestors 'none'`.
`trustedProxyHops` (0 to 2, default 0) trusts exactly that many nearest proxy
hops; Cloud Run fronted by Google's front end should use 1.

## Logs

Fastify's default request logs are disabled. Each request writes exactly one
JSON line, `request_completed`, containing `requestId`, `method`, the matched
route template (or `unmatched`), `statusCode`, `errorCode` when there is one,
the derived `operationId` and the `clientRequestId` for mutations, and
`durationMs`. Bodies, query strings, headers and tokens are never logged.
