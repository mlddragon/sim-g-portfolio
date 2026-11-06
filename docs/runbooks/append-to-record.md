# Governed `append_to_record`

F11e adds append to the same `MutationService` target pipeline used by
`update_record`. One internal change type (update or append) flows through alias
resolution, existing-location routing, fresh guarded fetch, authorization,
elevation, version-guarded dispatch and reconciliation. Update fingerprints and
behavior are unchanged; there is no parallel mutation path.

## Contract

- Content must be a string with non-whitespace text, at most 1 MiB UTF-8. The
  fingerprint is namespaced to `append_to_record` over the target and content.
  Routine and elevated appends store no content in PostgreSQL.
- Append is classified `NON_DESTRUCTIVE` and is dispatched only through the
  adapters' `append` method with the provider version observed during fresh
  authorization. It can never become a replacement; the adapters' body-integrity
  and version checks remain authoritative. A target that exposes no provider
  version fails closed (`provider_capability_unsupported`,
  `append_version_unavailable`) because append rewrites the stored body.
- Scope, protection and creator come from the freshly fetched record and gateway
  alias metadata, never from the client. Participant may append to ordinary Family
  Shared records and never to parent-scope records.
- A parent append to a protected record uses the F11c two-call elevation flow on
  the same request ID; the confirming call repeats the identical content.
- Terminal results replay without provider I/O. Uncertain outcomes reconcile by
  operation marker (and, for elevated appends, only under the exact consumed
  challenge) before any repeat; nothing is re-appended automatically.

## Known limits

- Notion stores an append as a new block, so the body it returns may hold its
  own block separator (one or two line breaks) between the earlier body and
  the appended text rather than their exact concatenation. The adapter accepts
  only the exact earlier body, line breaks alone, then the exact appended text
  (its leading line breaks aside), then records the hash of the body Notion
  holds. Anything else reports `outcome_unknown`. Drive appends are exact.
- An append that policy routes to parent approval (for example Participant on a
  protected Family Shared record) queues the same PostgreSQL-authoritative,
  non-expiring request and safe Family Inbox summary as updates ("Append to one
  Family Shared record"). Only then is the content kept, as the minimum pending
  payload, set atomically with the `AUTHORIZATION_REQUIRED` transition; the
  store refuses a payload on any other transition, for any other operation
  kind, or on an operation that already has one. It is retained only while the
  operation can still execute or reconcile and is cleared in the same
  compare-and-set that moves it to `COMPLETED`, `FAILED`, `CANCELLED` or
  `SUPERSEDED` (declined, superseded and finished requests keep no body). The Inbox projection and audit never contain it. Either
  parent may approve; execution rebuilds the append from that payload, re-fetches
  and revalidates target, policy and provider version, and dispatches once.
  A target that became legal-hold evidence or otherwise changed supersedes the
  request without dispatch.
- Original evidence under legal hold rejects every append
  (`legal_hold_evidence_immutable`), including for parents with elevation.
  Record additions as separate, dated, linked addenda instead.
- Stale `EXECUTING` appends after a crash or lost acknowledgement report
  `operation_in_progress` until the future recovery worker exists.
