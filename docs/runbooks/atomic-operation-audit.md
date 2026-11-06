# Atomic operation audit recording

`OperationalStateStore.transitionOperationWithAudit(transition, audit)` is the
portable storage boundary for changing an existing operation's state and adding
its metadata-only audit event. PostgreSQL uses one checked-out client for
`BEGIN`, the compare-and-set update, audit insertion, and `COMMIT`. Validation,
insertion, or commit failure rolls back both writes when rollback is confirmed.
No provider or audit-sink I/O occurs inside this transaction.

## Contract and attribution

- `expectedStates` must be nonempty and must exclude `nextState`. A missing
  operation, stale state, or duplicate attempt fails without inserting an event.
  Concurrent attempts against the same expected state have one winner.
- The audit argument accepts only `eventType`, optional `reasonCode`, and optional
  `integrityHash`. These are trusted internal metadata, never raw client fields.
- Request, principal, client, operation, target, provider, versions, outcome and
  timestamp come from the updated stored operation, including retained values
  omitted from the transition. Additional runtime audit fields are ignored.
- This event attributes the transition to the **operation initiator**. A parent
  resolving another person's approval must retain their own independently
  authenticated `resolve_approval` operation and audit context; do not label the
  requester as the approving actor. Approval correlation/orchestration is F11 work.
- `src/domain/audit/serialize-audit-event.ts` validates an exact metadata allowlist
  before both outbox persistence and structured output. Known fields must have
  the required primitive type/length/enum; nested objects and serialization hooks
  cannot supply their values. Unknown payload fields are stripped. Date output
  uses the built-in ISO serializer, not an instance override.
- Transition IDs, provider metadata, versions and state enums are also validated
  and snapshotted before PostgreSQL prepares parameters, preventing its object
  serialization hooks from converting nested payloads into apparently valid text.
- Metadata validation is not arbitrary string redaction. Callers still must not
  put secrets or Brain content into identifiers, version strings, or reason codes.

The existing `transitionOperation` remains a low-level unaudited storage primitive
for foundation compatibility. Application mutation orchestration must use the
audited method, not pair that primitive with a separate `enqueueAuditEvent` call.
Standalone enqueue remains available for non-transition events and now uses the
same runtime validator.

## Failures and recovery

State conflicts use `invalid_request` / `invalid_state_transition`; malformed
audit metadata uses `invalid_request` / `invalid_audit_event`. Unexpected database
errors are sanitized to `provider_unavailable` with
`operation_audit_state_unavailable`, without SQL, payloads, or driver error text.
A client whose rollback fails is discarded, never returned in an unknown state.

A lost connection can hide a successful `COMMIT`. A retryable error therefore
does **not** prove rollback. Reload the operation through a healthy connection
before deciding what to do. Do not rerun a provider mutation in response to a
database failure. An unchanged expected-state set cannot duplicate this transition
and event, but legal transition graphs, state cycles, uncertain provider outcomes,
and full idempotency orchestration still belong to F11.

The committed event enters the existing [delivery worker](audit-delivery.md).
Durable recording is not delivery acknowledgement or Cloud Logging retention.
External delivery remains at least once. Runtime scheduling, all-eight-operation
audit coverage, approval projection and live acceptance are not implemented here.
No schema migration or provider credentials are required by this slice.

## Verification

```sh
pnpm exec vitest run tests/unit/audit
# Inject the isolated test-only TEST_DATABASE_URL as documented in root STATUS.md:
pnpm exec vitest run tests/integration/operation-audit-transaction.test.ts
pnpm verify
pnpm test:integration
pnpm audit --prod --audit-level=high
git diff --check
```

Tests use synthetic rows on loopback in a database ending in `_test`. Test-only
constraints/triggers deliberately fail audit insertion and commit, and are
removed in `finally`; production migrations remain immutable. Another test holds
a database lock to verify no partial transition becomes visible. The reusable
state-store contract verifies both records after connection restart and rejects
duplicate transitions. Run integration suites serially because they reset the
same isolated database.
Separate driver-boundary tests inject lost COMMIT acknowledgement and rollback
failure to verify safe errors, no replay, and correct client release/discard.

Implementation follows the official node-postgres guidance for
[single-client transactions](https://node-postgres.com/features/transactions)
and [releasing or discarding pooled clients](https://node-postgres.com/apis/pool).
