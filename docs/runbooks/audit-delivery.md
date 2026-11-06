# Durable audit delivery

In the gateway process, `AuditDeliveryLoop` (`src/runtime/audit-delivery.ts`)
runs these passes on a bounded schedule and stops cleanly on shutdown; see the
[configuration runbook](configuration.md#running-the-gateway).

`AuditOutboxService.flush(signal)` performs one bounded delivery pass through
`OperationalStateStore` and `AuditSink`. It is an internal application component,
not a public operation or a scheduler. Deployment wiring (F13) remains future
work. No additional cloud service is required.

## Ownership and delivery

1. PostgreSQL atomically selects one due row with `FOR UPDATE SKIP LOCKED` and
   commits a fresh UUID ownership token, database-time lease, and attempt count.
2. The worker sends that one metadata-only event through the confirmed sink,
   outside any database transaction. It does not preclaim the whole batch.
3. Acknowledgement and retry scheduling lock the row first, then check the token,
   pending state and current database-time expiry. A lost or expired claim cannot
   update the row, including when it expired during the lock wait.
4. A failed send retains the event and schedules its next attempt. A crashed
   worker's claim becomes eligible automatically when its lease expires; no
   cleanup job is needed. Every acquisition receives a different token.

`listPendingAuditEvents` is diagnostic only and excludes active claims. Calling it
never grants delivery ownership. The old tokenless acknowledgement/retry methods
are deliberately replaced, not retained as unsafe compatibility overloads.

## Bounds and failure behavior

Defaults: at most 100 claims per pass, one send at a time, 30-second lease,
5-second sink deadline, and exponential retries from 1 second to a 60-second cap.
The configured sink deadline must be shorter than the lease. State adapters use
their configured database connection/statement timeouts. Store time controls
leases, retry eligibility and delivery timestamps; worker host clock skew cannot
grant ownership.

Attempts count claims, including abandoned claims; retry delay uses attempt one
as the initial delay. The counter saturates at the PostgreSQL integer maximum.
The pass has a bounded claim count; failed events are not discarded after a retry
limit. The in-process loop never runs passes back to back unless the previous pass
claimed a full batch and delivered every event; a pass that deferred any event
waits for the interval.

Only `audit_sink_unavailable`, `audit_sink_timeout`, or
`audit_delivery_cancelled` may be persisted as delivery failures. Raw sink errors,
database errors, abort reasons and claim tokens must not be logged. Storage
failure stops the pass with a safe error; an uncertain acknowledgement is never
rewritten as a sink failure. A restart re-reads authoritative database state.

Cancellation before a claim emits nothing. Cancellation after a claim schedules
a retry where ownership remains valid, without starting another send or
acknowledging success. Cancellation cannot retract a database acknowledgement
already submitted after successful output. A sink deadline aborts delivery and
ends the pass. Late sink settlement never acknowledges or changes retry state.
The same worker rejects another flush while a cancellation-ignoring sink call
remains outstanding, preventing unbounded accumulation; recover the output
channel or restart that runtime if it never settles.

Delivery is **at least once**, not distributed exactly once. A crash after output
but before acknowledgement, cancellation after bytes were submitted, or lease
expiry during a paused worker can produce duplicates. Lease ownership fences
database updates; it cannot retract an external write. Consumers must correlate
stable request/operation/event metadata. Acknowledged stdout means local stream
handling, not proof of Cloud Logging retention; see [audit output](audit-output.md).

## Migration and rollout

Migration `000003_audit_delivery_claims.sql` adds nullable token/expiry columns and
a paired-state constraint. Existing events remain intact and eligible. Historical
attempt counters are retained; before this migration they counted failures, not
all acquisitions. Existing migrations remain immutable.

Apply through the existing private migration procedure before starting the new
worker. Never run old tokenless workers alongside this version: stop any old
delivery workers before enabling it. Only the isolated local test database was
migrated during this slice; dev/prod rollout is not claimed. Integration suites
share a resettable synthetic database and must run serially.

## Verification

```sh
pnpm exec vitest run tests/unit/application/audit-outbox-service.test.ts
# Inject only the test database URL as documented in root STATUS.md:
pnpm exec vitest run tests/integration/audit-outbox-delivery.test.ts
pnpm verify
pnpm test:integration
```

The tests cover simultaneous workers, locked-row skipping, lock-wait expiry,
abandoned claims and connection restart, stale/wrong ownership, callback-confirmed
output with no database lock held, safe retry codes, capped backoff, bounded batch
size, storage failures, cancellation, and non-cooperative/late sink outcomes.

The [atomic recording method](atomic-operation-audit.md) now commits an operation
transition with its metadata-only event. Application services must use it to close
that crash gap; delivery alone does not complete F6 or v1 audit acceptance. Full
API auditing, telemetry and production retention remain separate work.

Implementation references:
[PostgreSQL 17 locking clauses](https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE)
and [database time semantics](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).
