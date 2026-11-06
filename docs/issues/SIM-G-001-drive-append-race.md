# SIM-G-001 Drive append can overwrite an intervening edit

- Status: open, unfixed
- Severity: medium
- Validation: source-validated; no live-provider exploit performed
- Affected component: Google Drive managed-text append

## Impact and conditions

An append operation can discard an authorized edit made concurrently to the same
already accessible Drive record. This is a data-integrity problem. A caller
allowed to append without destructive-operation approval can unintentionally or
deliberately overwrite an intervening higher-privilege edit.

The finding requires concurrent activity during the write interval. It does not
establish access to unrelated, parent-only or legal-hold records. Earlier version,
ancestry and integrity checks reject changes that they observe. They do not make
the final write atomic. Post-write verification can detect some conflicts but
cannot be relied on to preserve an edit already overwritten.

## Affected source

- Append construction and final refresh:
  [drive-knowledge-provider.ts](../../src/adapters/drive/drive-knowledge-provider.ts#L488-L516)
- Provider update request:
  [drive-client.ts](../../src/adapters/drive/drive-client.ts#L597-L625)

The adapter implements append as a full-body replacement. Its final metadata
check is separate from the update, and the update lacks an atomic version
precondition. Idempotency for one request does not serialize different requests
against the same record.

## Workarounds and limits

Evaluate the portfolio with synthetic fixtures. Avoid enabling Drive writes for
untrusted callers in a deployment that depends on strictly non-destructive append.
A one-writer discipline can reduce gateway conflicts, but it does not protect
against edits made directly in Drive or by another integration. There is no claim
that this snapshot contains a configuration switch that repairs the issue.

## Remediation direction

Use an atomic provider conditional write if a suitable supported mechanism is
available. Serialization by provider and record across the full read/check/write
interval can address gateway writers, but external writers must also be covered.
If full-body updates cannot be made safe, use an append-safe representation such
as separately stored entries rather than rewriting a shared body under append
permissions.

## Completion criteria

- Add deterministic regression coverage for concurrent operations on one record.
- Verify that an intervening authorized edit is preserved or the append fails
  safely without overwriting it.
- Cover distinct gateway operations and direct external-provider edits.
- Preserve approval, idempotency, uncertain-outcome and audit behavior.
- Demonstrate the fix before changing this issue's status to resolved.

## Tracking identity

Canonical finding ID: `csf_18f5af72b77ecc25cc9722cd`

Primary fingerprint:
`codex-security/v1:sha256:e03ce134144e0f6798cb11e1b15e1729441d8b02404e2cb112cbe1314da71879`
