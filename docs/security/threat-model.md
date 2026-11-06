# v1 threat model

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

## Protected assets

- Family Shared and Parent & Stewardship knowledge.
- Governance, security, legal-hold, and protected records.
- Provider credentials and cloud identities.
- Principal bindings, operation payloads, approvals, reconciliation state, and audit metadata.
- The integrity of canonical routing and executable policy.

## Trust boundaries

The AI client and public network are untrusted. Google OIDC establishes a verified external identity, which is mapped through server-owned bindings. The gateway domain trusts only normalized values produced by its own identity, state, policy, and provider adapters. Provider APIs and PostgreSQL are separate outbound trust boundaries. Human-facing Family Inbox entries are a safe projection; PostgreSQL remains operationally authoritative.

## Primary threats and controls

| Threat                                       | Required control                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Forged client identity or role               | Verify signature, issuer, audience, expiry, nonce/flow context, hosted domain, and immutable subject; ignore client identity claims. |
| Credential scope exceeds Brain scope         | Reauthorize every operation and filter every result against registered Brain scopes.                                                 |
| Participant reads parent/restricted material | Scope policy denies search and fetch; provider roots and integration sharing provide defense in depth.                               |
| Destructive prompt or ambiguous consent      | Independent blast-radius classification, explicit intent requirement, protected-content precedence, elevation/approval decisions.    |
| Replay or duplicate mutation                 | Principal/operation/request idempotency uniqueness plus request fingerprint; reconcile unknown outcomes before retry.                |
| Stale approval executes unsafe action        | Re-fetch target and re-evaluate identity, authorization, state, ownership, age, and protection at resolution time.                   |
| Provider outage creates false confidence     | Bounded parallel calls and explicit per-provider completeness/error metadata.                                                        |
| Secret disclosure                            | Runtime secret provider, independent secret grants, structured redaction, narrow API schemas, repository scanning.                   |
| Policy drift                                 | Versioned executable policy, content hash, canonical governance marker/reference, CI and deployment validation.                      |
| Dev mutates prod                             | Separate projects, credentials, databases, roots, OAuth audiences, and environment-bound runtime checks.                             |
| PostgreSQL exposure                          | Private IP only, private runtime path, narrow database role, no authorized public network.                                           |
| Supply-chain compromise                      | Lockfile, pinned CI actions, dependency review/audit, minimal runtime image, automated updates.                                      |

## Explicit exclusions

The gateway does not make provider credentials safe merely because they are machine identities, does not use obscurity as access control, does not rely on Notion views as permission boundaries, and does not infer destructive authorization from conversational context. A health endpoint may report only liveness.
