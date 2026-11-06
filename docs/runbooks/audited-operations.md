# Audited operation boundary

`AuditedBrainOperations` is the single application boundary the future F12 API
must call for all eight Brain operations. It records exactly one metadata-only
request event per call in the PostgreSQL audit outbox, in addition to the domain
events the services already record (reads, transitions, approvals, elevation
rejections, recovery). It adds no HTTP, scheduler or provider dependency.

## Events

| Event                     | When                                    | `outcome`                                                               |
| ------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `brain.request.completed` | The service returned a response         | `COMPLETED`, or the mutation's durable state (`APPROVAL_PENDING`, etc.) |
| `brain.request.rejected`  | The service threw before or during work | `DENIED` for authentication/authorization codes, otherwise `FAILED`     |

Each event carries request ID, attributed principal, client ID, operation, and
when known the operation, gateway record, approval and provider record
identifiers, plus a reason code: `search_complete`/`search_partial`,
`record_fetched`, `mutation_<state>`, `approvals_listed`,
`approval_<status>`, or `<error code>[.<reason>]` for rejections. A detail reason
is included only when it is a short lowercase identifier; anything else is
dropped. Queries, titles, bodies, semantic metadata, approval reasons and tokens
are never recorded.

The principal is attributed only when the caller is a structurally valid
authenticated principal whose identity binding names the same principal ID.
Otherwise the event records `unauthenticated`; client-declared identity is never
trusted. Cancellation is recorded as `request_cancelled` and rethrown.

## Failure behaviour

- If the outbox cannot accept the event after a successful call, the caller
  receives retryable `provider_unavailable` (`audit_state_unavailable`). Every
  operation is idempotent on replay, so the retry returns the same result and
  records the event, instead of silently dropping it. This includes an
  `approve` whose durable outcome was `impossible` or `superseded`: the same
  resolver's retry replays that outcome.
- If the outbox cannot accept the event for a rejection, the original error
  still reaches the caller.
- Delivery from the outbox to the `AuditSink` remains the existing at-least-once
  worker (see the audit delivery runbook).

## Known limits

- Rejections raised before a request reaches this boundary (transport
  authentication, schema or rate limits) are F12's responsibility.
- Search and fetch also enqueue their own `brain.read.completed` event, so a
  read produces a domain event and a request event by design.
- Fetch deliberately hides authorization denials as `not_found`, so its
  request event reads `FAILED` / `not_found.record_not_found`; the domain
  `brain.read.denied` event is the authoritative denial signal.
- If an `elevation_required` response is lost to an outbox outage, the retry
  issues a fresh challenge and supersedes the unseen one, which simply expires.
- Request facts (operation, gateway record and approval IDs) are recorded only
  when they are short identifier-shaped strings, so a malformed request still
  produces its one rejection event.
