# Audit output

The audit-output slice implements `AuditSink` with one structured JSON line per
event on stdout. The [durable delivery worker](audit-delivery.md) connects the
PostgreSQL outbox to this sink. Atomic operation/audit recording and runtime
scheduling are still separate slices.

## Delivery and failure behavior

- `CloudLoggingAuditSink.emit` resolves only after the stream write callback
  succeeds. Starting a write, or a `true` return from `Writable.write`, is not
  acknowledgement.
- One process-lifetime `StreamJsonLineDestination` is shared by default. It
  admits one write at a time; concurrent attempts receive a retryable safe
  `provider_unavailable` error. The outbox worker delivers sequentially
  per destination and retains/retries rejected events.
- Stream failures and close events reject pending delivery with a stable code.
  Raw errors, stacks, SQL details and abort reasons are not exposed or logged.
  A failed stream is not reused; recover the runtime/output channel before retry.
- Cancellation before writing emits nothing. Cancellation after submission
  rejects the caller but cannot retract bytes. It never destroys shared stdout.
  The pending write stays bounded until its callback/close settles. Late failures
  are absorbed. Delivery may have occurred despite cancellation, so future
  retries must tolerate duplicate events.
- Success confirms the local stream handled the bytes. It is not proof that
  Cloud Logging durably retained them. Deployment must validate collection,
  retention, readers and request correlation. Do not claim distributed
  exactly-once audit delivery.

## Payload boundary

The adapter validates and projects only the `AuditEvent` fields: event type,
request/principal/client/operation identifiers, operation/outcome, provider and
record identifiers, approval/policy/provider version, integrity reference,
reason code and timestamp. It adds `severity: NOTICE` and
`logType: family_brain_audit`.

Unknown runtime keys are dropped. Known fields must have valid primitive types,
enums and bounds; object payloads, serialization hooks and invalid dates are
rejected with `invalid_request` / `invalid_audit_event`. The adapter is not a
semantic redactor: callers must construct identifiers and reason codes from
trusted metadata and must never place Brain content or tokens in allowed string
fields. PostgreSQL's metadata-only outbox boundary remains required.

## Verification

```sh
pnpm exec vitest run tests/unit/audit
pnpm verify
```

Tests use synthetic events and a real Node `Writable` with controlled callbacks.
They prove delayed success, backpressure, callback failure, closed streams,
pre-write/in-flight cancellation, late-error handling and payload exclusion.
No provider credential or cloud resource is used.

Implementation references:
[Node Writable semantics](https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback)
and [Cloud Run structured logging](https://docs.cloud.google.com/run/docs/logging#using-json).
