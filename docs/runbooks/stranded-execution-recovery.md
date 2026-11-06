# Stranded execution recovery (reconcile-only)

A crash, lost COMMIT acknowledgement or cancellation after a direct update,
append, delete, create or elevated confirmation has claimed `EXECUTING` leaves
the operation reporting `operation_in_progress` forever. F11h adds an explicitly
invoked recovery capability, `MutationService.recoverStrandedExecution`, to
settle such operations without ever risking a duplicate or unauthorized write.

Owner decision (2026-10-22): avoiding duplicate or unauthorized writes takes
priority over automatically resolving every interrupted operation.

## Invocation

- Only an authenticated, active owner operator (Operator) may invoke it. There is
  no HTTP route, scheduler or background worker; a future operator surface must
  call it deliberately.
- `staleAfterMs` must be a whole number of at least 900,000 ms (15 minutes),
  well above any single direct execution. An operation whose `EXECUTING` claim
  is younger is reported `not_stale` and untouched. The threshold measures time
  since the claim (application clocks), not executor liveness.
- Cancelling the operator request, or a transient state-store failure, rethrows
  and leaves the operation `EXECUTING`; it never records a misleading reason.
- Operations that are not `EXECUTING` are reported `not_executing` unchanged.
  Approval-claimed executions (approval snapshot metadata present) are reported
  `approval_recovery_required` and keep the existing approval resolution path.

## Behaviour

1. Load the persisted operation and its original principal. A missing or
   disabled principal is never treated as proof of anything: the operation
   becomes `OUTCOME_UNKNOWN` (`recovery_principal_unavailable`) with no provider
   call.
2. Resolve current provider access: the alias, existing route and the
   principal's current surface authorization for target operations, or the
   deterministic route re-derived from stored semantic metadata, which must
   equal the frozen container, plus current create authorization for creates.
   Drift or access loss gives `recovery_route_changed` or
   `recovery_access_unavailable` with no provider call.
3. Perform one read-only provider reconciliation by this operation's own marker
   and record the attempt with a metadata-only reason.
4. Only a `completed` result whose reference matches the original target, or
   the frozen route for creates, finalizes `COMPLETED` through the existing
   compare-and-set transition. That transition clears the stored payload; a
   create then registers its alias. Nothing is dispatched.
5. Any other result (`not_found`, `inconclusive`, a failed or timed-out lookup,
   a mismatched reference) moves the operation to `OUTCOME_UNKNOWN`, preserving
   the in-flight payload and metadata and adding `recoveryReason`. The absence
   of a marker is never treated as proof that no write occurred.
6. **No mutation is ever re-dispatched**, even when the provider reports no
   marker. An operator-controlled resend is a separate future design.

Every settled attempt adds a metadata-only `brain.operation.recovery` audit
event attributed to the operator, alongside the transition's own audit. No
content, payload or token is audited.

## Operator reasons

| `reasonCode` / `recoveryReason`        | Meaning                                                          |
| -------------------------------------- | ---------------------------------------------------------------- |
| `recovery_provider_marker_completed`   | Positive proof of the original write; finalized `COMPLETED`.     |
| `recovery_provider_marker_not_found`   | No marker visible yet; the write may still have happened.        |
| `recovery_reconciliation_inconclusive` | The provider could not decide; investigate manually.             |
| `recovery_reconciliation_failed`       | The lookup failed or timed out; nothing is inferred.             |
| `recovery_provider_reference_invalid`  | A marker matched but for another record or container.            |
| `recovery_principal_unavailable`       | The original principal is missing or disabled; no lookup made.   |
| `recovery_access_unavailable`          | Current access to the target or route is gone; no lookup made.   |
| `recovery_route_changed`               | A create's deterministic route no longer matches its frozen one. |

## Concurrency and replay

All settlement is a compare-and-set out of `EXECUTING`. If a live executor or
another recovery settles first, recovery reports `not_executing` and never
overwrites or claims that outcome as its own. If recovery records
`OUTCOME_UNKNOWN` while a slow live write is still in flight, the live caller
receives `outcome_unknown` (replay the same request ID), never a terminal error
that could invite a resubmission, and the replay reconciles the landed write. A lost acknowledgement is resolved by reloading durable state. A
delayed provider write after recovery recorded `OUTCOME_UNKNOWN` is completed
by the normal client replay, which reconciles before any repeat.

## Known limits

- Approval-claimed executions keep the F11b approval recovery path, triggered
  by a parent's replayed `resolve_approval`. Since the owner decision of
  2026-10-23 it is reconcile-only too: one marker lookup, `COMPLETED` only on a
  matching reference, otherwise `OUTCOME_UNKNOWN` with the same metadata-only
  `recoveryReason` codes, keeping the payload and approval snapshot. It never
  re-dispatches, and a changed or newly protected target is recorded as
  `OUTCOME_UNKNOWN`, not `FAILED`, because it does not prove the claimed write
  did not happen. Access loss records `recovery_access_unavailable`;
  cancellation and transient failures leave the claim untouched.
- An `OUTCOME_UNKNOWN` operation with no marker stays unresolved until the
  client replays it after a delayed write or an operator investigates. There is
  no operator resend.
