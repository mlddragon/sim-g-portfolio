# SIM-G Knowledge Gateway v1 — Product Requirements Document

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

**Status:** Ready for implementation handoff  
**Date:** 2026-09-03  
**Owner:** Operator  
**Product:** SIM-G Knowledge Gateway  
**Version:** v1

## 1. Executive Summary

The SIM-G Knowledge Gateway is a secure, unified AI-facing interface to the systems that officially comprise the Example Knowledge System. Its purpose is to let authorized AI clients retrieve and persist family knowledge without exposing raw provider APIs, leaking unrelated cloud data, or forcing each client to understand Notion, Google Drive, GitHub, or future provider-specific storage details.

The gateway must make the Family Brain feel like one coherent knowledge system while preserving provider boundaries, canonical routing, source provenance, privacy, authorization, and auditability underneath.

The v1 implementation is for the Example family, with Operator as the first production operator and Steward and Participant as immediate onboarding targets. The architecture must be productizable for future Example Organization consulting engagements without requiring a rewrite for customers who use a different cloud provider or identity provider.

The permanent design principle governing the work is:

> **Build narrowly in scope, but not narrowly in architecture.**

v1 should implement only the capabilities required now, but with clean contracts and replaceable adapters so future providers, cloud platforms, identity systems, and deployment models can be added without rewriting the core gateway.

## 2. Problem Statement

The Family Brain currently spans multiple systems with different responsibilities:

- Notion for canonical structured knowledge and governance.
- Google Drive for documents and file-oriented canonical material.
- GitHub for approved repository knowledge.

Direct AI access through individual provider connectors creates several problems:

1. **Fragmented retrieval.** AI clients must decide which provider to search and may miss authoritative context in another provider.
2. **Excessive write friction.** Current connector write confirmations create enough friction that Steward and Participant are unlikely to adopt the system comfortably.
3. **Inconsistent authorization.** Provider access is not the same as Brain authorization. A technical credential may see more than the Brain is supposed to expose.
4. **Unsafe destructive actions.** Deletes and broad changes need different treatment based on user, scope, content class, and blast radius.
5. **Vendor coupling.** A solution tightly bound to Google Cloud, Notion internals, or a single AI client would be difficult to productize later.
6. **No unified operational state.** Idempotency, approvals, request state, and reconciliation require a transactional backend distinct from the knowledge stores themselves.
7. **No single policy enforcement point.** Canonical routing, privacy, approvals, and audit expectations should be applied consistently regardless of which AI client is calling.

## 3. Product Goal

Create a secure Family Brain Gateway that becomes the normal AI-facing knowledge interface for the official Family Brain.

The implementation is not considered complete when only Notion works. v1 is complete only when:

- Notion retrieval and authorized writeback work through the gateway.
- Google Drive retrieval and authorized Brain-related writeback work through the gateway where Drive is canonical.
- Approved GitHub repository knowledge is retrievable through the gateway.
- Authentication, authorization, approvals, audit, idempotency, and policy enforcement work end to end.
- Operator can use the gateway in normal AI interactions, followed by successful onboarding of Steward and Participant.

## 4. Non-Goals for v1

v1 does **not** include:

- General-purpose access to every connected Workspace or family service.
- General GitHub repository mutation.
- A generic raw Notion, Drive, or GitHub API proxy.
- A normal-purpose `move_record` operation.
- An embedded LLM or autonomous semantic routing model inside the gateway.
- Sophisticated vector infrastructure, provider mirroring, persistent content caching, or broad pre-indexing.
- A dedicated standalone approval application.
- Two-parent approval requirements.
- A production AWS deployment.
- Speculative support for identity providers beyond the Google OIDC implementation.

## 5. Users and Roles

### Operator

Operator is the owner/operator and first production user.

Operator may:

- Read all Brain content authorized to his owner/operator role.
- Create, update, append, and explicitly delete ordinary records within scope.
- Approve parent/steward requests.
- Perform explicitly elevated destructive actions when policy allows.
- Administer governance, security, schema, permissions, credentials, and control-plane configuration.

### Steward

Steward is a parent/steward and must be a full participant in routine family knowledge management, not a read-mostly user.

Steward may:

- Read ordinary family and household knowledge within her approved parent/steward scope.
- Create, update, append, and explicitly delete ordinary records within scope.
- Approve parent/steward requests independently.

Steward may not administer governance, infrastructure, security, permissions, credentials, or schema unless Operator explicitly delegates those capabilities later.

### Participant

Participant is a family participant.

Participant may:

- Read Family Shared content within her authorized boundary.
- Create, update, and append ordinary Family Shared knowledge.
- Delete or replace a record she personally created within a 15-minute correction window, unless a stricter protected-content rule applies.
- Request deletion or another protected action outside that correction window, which is then queued for Operator or Steward approval.

Participant may not access Parent & Stewardship, restricted governance/security areas, or administrative capabilities.

## 6. Identity and Authentication

Google Workspace identity is the authoritative human identity source for the Example deployment.

Requirements:

- Operator, Steward, and Participant authenticate separately using their own Example Google Workspace identities.
- The gateway validates Google OAuth/OIDC tokens and maps the verified identity to an internal Brain principal.
- Client-supplied claims such as `user=steward` must never establish identity.
- Shared family credentials are prohibited.
- Human authentication must be abstracted behind an `IdentityProvider` interface.
- Google OIDC is the only required v1 adapter, but the core gateway must consume a normalized authenticated principal rather than Google-specific identity objects.

## 7. Provider Credential Model

Human identity establishes who is asking. Provider service credentials perform the authorized operation.

Requirements:

- Notion, Google Drive, and GitHub each use dedicated machine/service identities.
- Human OAuth credentials are not reused as provider credentials.
- Provider credentials are independently scoped, rotatable, and revocable.
- Provider credentials remain server-side and are never returned through the gateway API.
- Google Drive uses a dedicated machine identity limited to registered Brain roots.
- Notion uses a dedicated integration scoped only to Family Brain content required by the gateway.
- GitHub should use a narrowly scoped, read-only GitHub App limited to approved Brain repositories rather than Operator's personal access token.

## 8. Unified Brain Retrieval

The default retrieval contract is provider-agnostic.

### `search_brain`

The AI client submits one Brain-level query. The gateway:

1. Authenticates the caller.
2. Determines the caller's authorized Brain scope.
3. Fans the query out in parallel to the approved Notion, Drive, and GitHub knowledge surfaces.
4. Filters unauthorized results.
5. Ranks and deduplicates results.
6. Returns excerpts plus provenance and canonical-location metadata.

Search results must include enough information for the AI to choose what to fetch without dumping full documents into context.

### `fetch_record`

The AI explicitly retrieves the full authorized content of a selected result.

This search-then-fetch pattern is required for speed, context efficiency, and data minimization.

### Partial Results

Reads degrade gracefully. If one provider is unavailable or times out, the gateway returns results from the successful providers plus machine-readable completeness metadata identifying the missing provider(s). It must not falsely represent a partial search as complete.

## 9. Provider Retrieval Boundaries

### GitHub

The Example Project Registry is the authoritative allowlist for GitHub repositories participating in Brain retrieval.

A repository may be searched only if:

- It is registered as part of a project's canonical Brain knowledge surface.
- The authenticated principal is authorized for the corresponding project/data.

Underlying credential access does not broaden this boundary.

GitHub is read-oriented in v1. Routine repository writes continue through native GitHub/repository workflows.

### Google Drive

The gateway may access only explicitly governed Shared Drive or folder roots registered as Brain knowledge surfaces.

It must never search an authenticated user's entire Drive or My Drive by default.

Personal and unrelated Workspace content remains invisible unless governance explicitly registers a root later.

## 10. Write and Routing Model

The gateway exposes Brain-level semantic operations rather than provider-specific mutation primitives.

### v1 Write Operations

- `persist_knowledge`
- `update_record`
- `append_to_record`
- `delete_record`
- `list_approvals`
- `resolve_approval`

The client must not normally choose Notion versus Drive. The AI client performs natural-language interpretation and supplies normalized metadata such as:

- subject/domain
- record type
- durability
- sensitivity
- provenance
- relevant context

The gateway then applies deterministic routing and authorization policy.

If routing metadata is incomplete, contradictory, or too ambiguous, the gateway returns a structured response such as:

- `insufficient_metadata`
- `routing_ambiguous`

The response must explain what information is needed for a safe retry.

No LLM runs inside the gateway for semantic classification in v1.

## 11. Canonical Routing and Governance

Human-readable governance remains canonical in the Family Brain. Executable routing policy is technical truth in the gateway repository.

Requirements:

- The gateway must not silently drift from canonical governance.
- Executable policy must be versioned.
- The engineering implementation must include validation or synchronization controls capable of detecting mismatches between executable policy and authoritative governance.
- Provider adapters execute only after authentication, authorization, and routing are resolved.

## 12. Destructive Action Policy

### Routine actions

Operator and Steward may perform routine authorized reads, creates, updates, appends, and single clearly identified deletions that they explicitly requested.

Participant may perform routine reads, creates, updates, and appends inside Family Shared.

### Participant correction window

For 15 minutes after creation, Participant may delete or replace a specific record she created herself if:

- She is still authorized for the record's scope.
- The record has not entered a protected class.
- No stricter governance rule applies.

The 15-minute rule is evaluated at request time. No timer job is required.

### Protected and broad deletion

The following are not routine actions:

- Multiple-record or broad deletion.
- Inferred deletion not explicitly requested by the user.
- Destructive migrations or bulk cleanup.
- Governance/schema/security/permission/credential changes.
- Legal-hold or other protected-record deletion.

Operator or Steward must explicitly elevate high-blast-radius destructive operations where allowed. Participant cannot independently elevate.

Legal holds and protected classes remain subject to stricter policy and are never made routinely deletable by the correction window.

## 13. Approval Workflow

The existing Notion Family Inbox is the human-facing approval queue.

When Participant requests an action that requires parent approval:

1. The gateway records the exact operational state in PostgreSQL.
2. The gateway creates a Family-Shared-safe pending request in the existing Family Inbox.
3. The Family Inbox record contains a stable request/operation ID and safe human-readable description, but no parent-only or secret payload.
4. Participant is told the request has been queued.
5. Operator or Steward may later ask their AI client to list pending approvals and review them one at a time.
6. Either Operator or Steward may approve or decline independently.
7. Approval does not expire merely because it was ignored.
8. Before executing an approval, the gateway revalidates authorization, target identity/state, and protected-content rules.

A request remains pending until approved, declined/cancelled, superseded, or made impossible by later state change.

## 14. Operational State

PostgreSQL is part of v1 from the start.

PostgreSQL stores gateway operational state only. It is not a duplicate knowledge corpus.

Expected responsibilities include:

- idempotency records
- request/correlation records
- pending protected-operation state
- approval execution state
- principal/identity mappings where appropriate
- policy/configuration version references
- reconciliation state for uncertain provider outcomes

The gateway accesses PostgreSQL through an `OperationalStateStore` or repository boundary so the core is not tied to a specific managed database product.

For Example, managed PostgreSQL on Google Cloud is acceptable. A future customer may use AWS RDS, another managed PostgreSQL provider, or self-hosted PostgreSQL.

## 15. Idempotency and Failure Behavior

Every mutation carries a stable idempotency/request ID.

Repeating the same request ID must return the original result or current reconciled state rather than executing the mutation again.

Writes fail conservatively:

- The gateway does not blindly retry when a provider result is ambiguous.
- It reconciles against provider state and known identifiers where possible.
- It returns structured states such as `completed`, `failed`, `approval_required`, or `outcome_unknown`.

The goal is client-visible exactly-once behavior as far as practical despite provider APIs that may not provide true distributed exactly-once semantics.

## 16. Audit Requirements

Auditing is abstracted behind an `AuditSink` interface.

For the Example deployment, Google Cloud Logging may be used as the initial implementation. A future AWS implementation may use CloudWatch or another suitable append-oriented system.

Audit events must capture, at minimum:

- authenticated principal
- client identity where available
- operation type
- stable request/correlation ID
- target/canonical record identifier
- provider
- timestamp
- authorization/approval context
- outcome/error classification

Full sensitive Brain content must not be logged by default.

For mutations, provider record/version identifiers and integrity references/hashes should be retained where practical instead of raw before/after content copies.

Audit retention must be configurable.

## 17. Network and Security Posture

The v1 gateway may be internet-reachable, but no Brain operation is anonymous.

Requirements:

- Assume the service URL is discoverable.
- Every normal Brain operation requires successful authentication and server-side authorization.
- PostgreSQL must not be publicly internet-accessible.
- Secrets and provider credentials remain private to the server environment.
- Admin/control-plane actions should not share the ordinary public client surface unless separately authenticated and explicitly authorized.
- Managed HTTPS ingress, rate limiting, and standard cloud protections should be used.
- Security must not depend on obscurity.

## 18. Cloud Portability

Cloud portability is a product requirement.

Core business logic must not depend directly on Google-specific SDKs or persistence models.

Cloud-sensitive concepts must be behind replaceable interfaces, including:

- `IdentityProvider`
- `OperationalStateStore`
- `AuditSink`
- secrets access
- deployment/runtime infrastructure

The Example deployment can use Google Cloud implementations. A future AWS deployment should require replacement adapters and infrastructure configuration, not changes to Brain semantics, MCP/API contracts, routing, authorization, approvals, or provider behavior.

## 19. Environments

v1 requires separate `dev` and `prod` environments from the beginning.

They must use separate:

- configuration
- credentials
- provider scopes
- PostgreSQL databases/state
- test versus production content roots

Dev must initially use designated test Notion content, test Drive roots, and fixture/test GitHub material.

Production cutover occurs only after automated acceptance tests and manual validation pass.

## 20. Performance Posture

v1 should include low-cost, low-complexity performance improvements during initial implementation:

- parallel provider fan-out
- bounded result sets
- search-then-targeted-fetch
- connection reuse where supported
- short provider timeouts with graceful partial results
- deterministic deduplication/ranking before expensive enrichment
- avoidance of unnecessary model calls inside the gateway
- instrumentation sufficient to identify real bottlenecks

Deeper optimization is intentionally targeted for v1.1 after Operator, Steward, and Participant generate real household usage data.

Do not delay v1 for speculative vector infrastructure, provider mirroring, persistent content caching, or broad pre-indexing.

## 21. v1 Acceptance Criteria

v1 must include automated tests for:

- Operator/Steward/Participant authentication and principal mapping.
- Permission-boundary enforcement.
- Unified Notion/Drive/GitHub search.
- Search provenance, canonical location, stable identifiers, and completeness metadata.
- Targeted full fetch.
- Notion/Drive canonical write routing.
- Structured ambiguous-routing retry behavior.
- GitHub read-only enforcement.
- GitHub Project Registry allowlist.
- Drive registered-root restrictions.
- Dedicated provider service-identity isolation.
- Participant's 15-minute correction window.
- Protected-content override of that window.
- Durable, non-expiring Family Inbox approval workflow.
- Either-parent approval.
- Stale/superseded approval revalidation.
- Idempotent mutations across service restarts.
- Ambiguous-provider-outcome reconciliation.
- Graceful partial reads.
- Audit emission through `AuditSink`.
- Rejection/elevation of unauthorized or broad destructive operations.
- PostgreSQL operational-state persistence.
- Dev/prod isolation.
- Executable policy/governance drift detection.
- Core portability boundaries being testable without Google-specific implementations.

Manual pre-production validation must include:

- Internet endpoint reveals no Brain data anonymously.
- PostgreSQL is not public.
- Provider secrets cannot be retrieved through the API.
- Real AI-client authentication flow works.
- Conversational approval review works.
- Representative unified search quality is acceptable.
- Provenance is understandable to the AI client.
- Operator's end-to-end day-to-day workflow works before Steward and Participant onboarding.
- Steward and Participant can be onboarded without repeated technical intervention from Operator.

## 22. Definition of Done

v1 is done when the gateway is deployed through the dev-to-prod process, all automated acceptance tests pass, the manual production-readiness checklist passes, and the real AI-client workflow successfully supports Operator followed by practical onboarding of Steward and Participant.

Notion-only completion is not sufficient. The official Brain knowledge surface must be wired through Notion, Google Drive, and approved GitHub retrieval.
