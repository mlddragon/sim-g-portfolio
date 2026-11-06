# Governed `persist_knowledge`

F11d adds governed creation to the existing `MutationService` state machine. It
reuses deterministic routing, the authorization engine, durable operations,
atomic transition audit, the Notion/Drive mutable adapters and PostgreSQL
aliases. It adds no HTTP surface, provider capability or deployment.

## Flow

1. Validate the authenticated operation identity and a closed request shape:
   non-empty title and body, and only the documented semantic metadata keys as
   bounded strings (`sensitivity` from the closed enum, `canonicalHint` with
   only `provider`/`containerRef`). Creator, scope and protection are never
   client input.
2. Route deterministically before opening state. `insufficient_metadata`,
   `routing_ambiguous` and GitHub's `provider_capability_unsupported` are
   returned with no operation opened, so the same request ID can be retried with
   refined metadata.
3. Open the durable operation with the canonical fingerprint of title, body and
   normalized metadata. A different payload under the same request ID is
   `idempotency_conflict`. The title and body are bounded (2,000 characters and
   1 MiB UTF-8) and are not stored in PostgreSQL: nothing resumes a create, so
   the fingerprint alone provides idempotency.
4. Derive the Brain scope server-side: the routed container must be registered
   under exactly one surface scope. Authorize that scope for the principal. An
   unregistered container or forbidden scope fails `unauthorized` without
   provider I/O.
5. Move `RECEIVED → EXECUTING` with the routed container, dispatch exactly one
   governed create (`text/markdown`, protection `none`), then validate that the
   provider reference is in the routed provider and container.
6. Commit `COMPLETED` first, then register the gateway alias idempotently from
   the provider record, recording the authenticated operation principal as the
   gateway creator (migration `000006`). Every replay re-derives the same alias,
   so an alias failure after completion is repaired by retrying the request.

## Creator attribution

Participant's 15-minute correction needs an authoritative creator. Targeted writes
now merge the alias's gateway creator into the freshly fetched provenance. If
the provider also reports a creator and the two disagree, the creator is removed
so no ownership shortcut can apply. Ensuring an alias fills a missing creator
but never overwrites an existing one, and retrieval never supplies one.

## Uncertain outcomes

A thrown non-domain error, provider `unknown` result or a completion outside the
routed container becomes `OUTCOME_UNKNOWN`. A replay reconciles by the stable
operation marker only when the request still routes to the same provider and
container and the principal is still authorized for its scope. `not_found` or
`inconclusive` keeps `outcome_unknown`: the gateway never re-creates
automatically, so a duplicate record cannot be produced.

## Known limits

- Elevation-gated creates (legal scope for parents; governance/security
  control-plane containers for Operator only) use the F11c two-call flow (F11i).
  Because no record exists, the challenge binds to a frozen route token, a
  SHA-256 of provider, container and Brain scope, plus the fingerprint and
  policy version. `ELEVATION_PENDING` stores that route and decision reason, never
  the body; the confirming call repeats the payload. Confirmation re-derives
  the route, registered scope, decision and policy version, which must match
  exactly, before the atomic consume-and-claim and one create. Drift supersedes;
  a now-forbidden route fails. Uncertain elevated creates, including stranded
  recovery, reconcile only under the exact consumed challenge. Approval-gated
  creates do not exist under current policy, and Participant never elevates; both
  fail closed.
- Creates are written with protection `none`. A governed root configured with
  another protection class (for example a legal-hold evidence root) rejects the
  create in the adapter, after an elevated create has consumed its challenge;
  it fails closed with nothing written. New evidence belongs in a separate,
  non-legal-hold root as a dated, linked record.
- A replay of a pending elevated create re-issues a challenge for the frozen
  route without re-checking policy; after an executable policy version change
  that challenge can only be superseded on confirmation. An elevated create left
  `OUTCOME_UNKNOWN` cannot reconcile after a policy version change and needs
  operator investigation.
- A stale `EXECUTING` create after a crash or lost acknowledgement is reported as
  `operation_in_progress` until the future recovery worker reconciles it.
- Notion and Drive adapter create paths remain locally proven only; isolated
  live-development validation is F7/F8 work.
- Protection is not derived from the registered surface: creates are written
  with protection `none`, and an adapter whose root policy differs rejects the
  write (`FAILED`), never silently relabels it.
- A replay of a completed request whose `canonicalHint.containerRef` no longer
  matches after a policy container remap returns `routing_ambiguous` instead of
  the stored result; the record exists exactly once.
- Create transition audits carry the provider record ID; the gateway alias is
  derived afterwards and is not in those events.
