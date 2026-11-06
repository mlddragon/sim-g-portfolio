# Elevated `update_record` confirmation

F11c completes the two-call elevation flow for `update_record`. It reuses the
F11a state machine, the existing five-minute `ElevationService` challenge and
the authorization engine; it adds no HTTP surface, provider capability or
deployment.

## Flow

1. A parent's update reaches `ELEVATION_REQUIRED` (protected or control-plane
   target, legal scope, or empty-body replacement). The operation moves
   `RECEIVED → ELEVATION_PENDING` with the frozen provider record, provider
   version, policy version, decision reason, scope and protection class.
2. The response is `elevation_required` plus a grant: challenge ID, a 256-bit
   confirmation token and `expiresAt` (exactly five minutes). PostgreSQL stores
   only the token's SHA-256 hash. The token is never audited or persisted.
3. The client repeats the same request ID and identical mutation with
   `elevation: { challengeId, confirmationToken }`. The confirmation is not part
   of the request fingerprint; any payload change is `idempotency_conflict`.
4. Before consuming anything, the gateway re-resolves the alias, re-fetches the
   target through the guarded adapter and re-evaluates policy. The target must
   still produce the same elevation decision with the same policy version,
   provider record/version, scope and protection class.
5. One store transaction locks the operation row, consumes the exact live
   challenge, moves `ELEVATION_PENDING → EXECUTING` and enqueues the
   metadata-only `elevated_action_confirmed` audit. Any mismatch changes
   nothing. Only the transaction winner dispatches one version-guarded update.

## Rejections and terminal outcomes

| Situation                                                       | Result                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Forged, unknown, expired, consumed or superseded challenge      | `elevation_required` error; operation stays pending; `brain.elevation.rejected` audit. |
| Challenge presented by another principal or for another request | Same rejection; the owner's challenge stays live.                                      |
| Replay without `elevation` while pending                        | Fresh grant; every older live challenge for the operation is superseded.               |
| Target version, protection, scope or policy version changed     | `SUPERSEDED` (client `failed`); no dispatch; start a new request.                      |
| Target now forbidden (for example legal-hold evidence)          | `FAILED` / `unauthorized`; elevation never overrides a forbidden action.               |
| Target gone or access lost                                      | `SUPERSEDED` or `FAILED`, mirroring stale approval handling.                           |
| Transient fetch/provider failure before consumption             | Error returned; operation and challenge stay usable.                                   |
| Concurrent confirmations                                        | Exactly one claims execution; others see the stored result or `operation_in_progress`. |
| Uncertain provider outcome after confirmation                   | `outcome_unknown`; a replay reconciles only under the exact consumed challenge.        |
| Participant                                                     | Never receives a challenge; an elevation-required decision fails closed.               |

## Known limits

- A lost COMMIT acknowledgement on the confirmation transaction leaves the
  operation `EXECUTING` without dispatch. The gateway never dispatches on an
  ambiguous claim; like F11a's routine path, recovery of a stale direct
  `EXECUTING` operation awaits the future recovery worker.
- Re-issuing a challenge on replay writes one row per call. F12 request and
  principal rate limits must bound this.
- Reconciliation of an uncertain elevated write is refused after an executable
  policy version change; that operation remains `outcome_unknown` for operator
  reconciliation.
- The rejection audit is best-effort; the rejection itself never depends on it.
- Cancellation between the confirmation commit and provider dispatch also leaves
  the operation `EXECUTING` with its challenge consumed and nothing dispatched.
  It is safe and shares the recovery-worker dependency above.
- Expiry is evaluated against the gateway clock read after the operation and
  target revalidation, immediately before the transaction. Connection and lock
  waits (bounded by pool and statement timeouts) can let a confirmation that
  started inside the window commit seconds after it, never minutes.
- A permanent provider/route mismatch (`provider_capability_unsupported` or a
  provider reference mismatch) is returned without settling, mirroring F11b; the
  operation stays pending and harmless until the client starts a new request.
- Issuance re-checks under the operation lock that the operation is still pending
  elevation for the same principal. A replay racing a completed confirmation
  receives the stored result, never a fresh grant. At most one live challenge per
  operation is also enforced by a unique partial index.
