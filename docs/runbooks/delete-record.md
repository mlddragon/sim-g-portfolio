# Governed `delete_record` (recoverable trash)

F11f adds deletion to the shared `MutationService` target pipeline. Update,
append and delete now share one request path (`runTargetChange`): durable
operation and fingerprint before provider I/O, alias resolution, existing
location routing, fresh guarded fetch, authorization, approval or elevation,
version-guarded dispatch and reconciliation. Deletion is always the adapters'
recoverable `trash`; permanent deletion does not exist in the provider ports.

## Contract

- `explicitIntent` must be the literal `true`; anything else is
  `invalid_request` (`explicit_delete_intent_required`) before state opens.
  Broad, multiple-record or inferred deletion has no request shape.
- The fingerprint is namespaced to `delete_record` over the target. No body or
  payload is stored.
- The target must expose a provider version; trash is dispatched with the
  version observed during fresh authorization or fails closed
  (`delete_version_unavailable`).
- Policy (executable `family-brain-v1.2.0`; delete rules unchanged since v1.1.0):
  - Legal-hold evidence: always denied (`legal_hold_evidence_immutable`), even
    with approval or elevation; no approval or challenge is created.
  - Operator/Steward on an ordinary record in scope: routine.
  - Protected records: parents use the F11c two-call elevation; Participant queues
    parent approval.
  - Participant on a record she created, by gateway or provider creator facts,
    within exactly 15 minutes (`0 <= elapsed <= 900000 ms`): routine
    correction. Otherwise she queues parent approval.
  - Parent-scope records are never visible to Participant.
- Approval-required deletes create the same PostgreSQL-authoritative,
  non-expiring request and safe Family Inbox summary as updates ("Move one
  Family Shared record to trash"). Either parent may approve; execution
  re-fetches and revalidates the target, policy and provider version first.

## Reconciliation

A completed trash makes the target unfetchable. An uncertain delete therefore
reconciles with provider access rebuilt from the alias, the existing route and
the principal's current surface authorization, without a fresh fetch. Only an
exact trash marker completes the operation. `not_found` or `inconclusive`
keeps `outcome_unknown`, and approved recovery never re-dispatches when neither
the target nor a marker is visible. Access revoked since the request refuses
reconciliation.

## Known limits

- The no-fetch reconciliation path cannot re-check target protection, because
  the trashed record is no longer visible; it relies on the original fresh
  authorization at dispatch plus current surface access, and only reads.
- The no-fetch path also checks only current surface scope and principal
  status, not per-record facts, role-operation changes or the consumed
  elevation challenge. If a third party trashes the target first, an uncertain
  delete has neither a visible target nor this operation's marker and stays
  `outcome_unknown`; the future recovery worker must surface it to an operator.
- `deleteRecord` reads only the documented fields. The F12 `delete_record`
  request schema must be strict and reject extra fields such as multiple
  target IDs, selectors or a non-literal `explicitIntent` at the boundary.
- Stale `EXECUTING` direct deletes after a crash or lost acknowledgement report
  `operation_in_progress` until the future recovery worker exists; approved
  deletes recover through approval resolution replay.
- Notion/Drive trash remains locally proven only; isolated live-development
  validation is F7/F8 work. GitHub has no mutation surface.
