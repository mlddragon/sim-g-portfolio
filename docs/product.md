# Product purpose and decisions

The gateway gives an AI client one bounded knowledge interface without exposing
raw provider APIs or unrestricted provider credentials. The key product decisions
are verified human identity, server-owned scopes, deterministic routing, explicit
approval for protected actions, short-lived elevation, idempotency, and auditability.

The illustrative roles are owner/operator, steward and participant. A creator's
limited correction window does not override protected records or legal holds.
GitHub is read-only. Cloud, identity and provider dependencies remain replaceable.
The current implementation is single-organization; do not present it as a shipped
multi-tenant SaaS product, a commercial roadmap outcome or an embedded autonomous AI.
