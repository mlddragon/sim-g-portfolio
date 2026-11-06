# Security policy

## Known unresolved findings

The portfolio snapshot documents two open security findings in
[KNOWN_ISSUES.md](KNOWN_ISSUES.md), including bounded impact, workarounds and
completion criteria. They are intentionally disclosed and remain unfixed. The
invariants below describe the intended controls; the known findings qualify their
current implementation. This sample has not been cleared for real-data deployment.

## Reporting

Report newly suspected vulnerabilities privately to the repository owner. Apart
from the intentionally documented known findings, do not open a public issue or
paste secrets, tokens, real family content, provider payloads, or exploit evidence
into chat or repository discussions.

## Security invariants

- Every Brain operation authenticates a distinct human Google OIDC identity and maps the immutable issuer/subject binding to a Brain principal.
- Client-supplied user, role, email, ownership, timestamp, protection, or authorization claims are non-authoritative.
- Authorization and deterministic routing complete before any provider operation.
- Provider service identities are independent, least-privilege, rotatable, and never returned or logged.
- GitHub mutation capability is absent from the v1 provider type.
- Drive and Notion adapters enforce configured governed roots in addition to credential scoping.
- PostgreSQL has no public network exposure and contains only minimum operational state.
- Dev and prod use separate projects, databases, identities, credentials, secrets, and provider roots.
- Full Brain content is excluded from audit events by default; identifiers, outcomes, provider versions, and integrity hashes are preferred.
- Uncertain mutations reconcile before retry. Idempotency keys cannot silently accept a different payload.
- Protected and legal-hold records override creator ownership and age rules.
- Original evidence under legal hold is immutable through the gateway: no edit,
  title change, append, replacement, trash or deletion, even with parent
  approval or elevated privileges (owner decision, 2026-10-22). New evidence,
  commentary and updates are separate, dated, linked records or addenda. The
  `legal_hold` protection class is assigned per governed root from server
  configuration, never by clients: everything under a legal-hold root is
  immutable, so clearly identified derived working notes and indexes must live
  in a separate root that is not `legal_hold`, where normal authorization and
  retention rules apply.

## Repository data policy

Never commit real household data, provider exports, databases, backups, Terraform state, `.env` files, OAuth tokens, service-account keys, GitHub App keys, Notion tokens, request logs, audit exports, or production configuration values. Tests use unmistakably fictional identities and content.

If a secret is committed, stop using it immediately, revoke or rotate it at the provider, preserve evidence privately, remove it from reachable history through an owner-approved procedure, and validate that dependent environments use the replacement.
