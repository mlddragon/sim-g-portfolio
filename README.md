# SIM-G Knowledge Gateway sanitized mirror

SIM-G is an authenticated, policy-controlled gateway for knowledge held in Notion,
Google Drive and approved GitHub repositories. This history-free showcase retains
the full TypeScript source, automated tests, SQL migrations, provider adapters,
infrastructure templates, operating tools and decision archives from a private
AI-assisted project. It has no automatic link to the source repository.

## Current stage

The source project is implemented and has recorded development deployment,
Notion/Drive smoke-test lifecycles, and an encrypted backup/restore rehearsal.
It is substantially beyond a scaffold. Production onboarding and the planned
ChatGPT MCP/OAuth connection remain unfinished. This separate sanitized copy
has never been deployed and contains no live account configuration.

Two known security findings remain **open and unfixed** in this portfolio snapshot:
a Drive append race can overwrite a newer edit, and an allowed Notion parent can
disclose a restricted child title. Read [KNOWN_ISSUES.md](KNOWN_ISSUES.md) for
impact, workarounds and planned fixes. This snapshot is for inspection and
synthetic evaluation; it is not cleared for use with real sensitive data.

The runtime currently composes Notion, Drive and an explicitly unavailable GitHub
provider. A functional read-only GitHub adapter and tests exist; live Registry
binding and runtime composition are separate remaining work. Checked-in governance
and Registry locks remain explicitly pending, rather than pretending to be live.

## Architecture

```text
Authenticated client -> HTTPS API -> identity -> policy and routing
                                      |-> Notion adapter
                                      |-> Drive adapter
                                      |-> read-only GitHub adapter (separate)
                                      `-> PostgreSQL operational state and audit outbox
```

The domain and application layers depend on ports rather than provider SDKs.
Provider adapters enforce configured roots. Identity comes from verified Google
issuer/subject claims. Provider service identities stay server-side. PostgreSQL
stores operational state, approval and audit metadata rather than a content mirror.
The trusted authorization/execution path does not run an autonomous model.

Operations: search_brain, fetch_record, persist_knowledge, update_record,
append_to_record, delete_record, list_approvals and resolve_approval.

## Where to look

- `src/domain/authorization/`: permissions, protected operations and correction windows.
- `src/application/`: retrieval, mutations, approvals, elevation and audit delivery.
- `src/adapters/`: Notion, Drive, read-only GitHub, identity, secrets and PostgreSQL.
- `tests/`: unit, contract, acceptance, integration and capacity evidence.
- `migrations/`: operational schema and fictional example principals.
- `infra/google/` and `deploy/vm/`: account-neutral VM, ingress, database and recovery templates.
- `docs/architecture.md`, `docs/product.md` and `docs/validation.md`: review orientation.
- `docs/decisions/README.md`: product requirements, engineering design, alternatives,
  implementation rulings and the precedence of historical decisions.
- `docs/release/sanitization.md`: what was retained, what stays private and how
  future source changes must be reviewed before updating the mirror.
- `docs/runbooks/`: sanitized operational procedures.

## Review locally

Use the Node 24 version and pnpm version pinned in package.json. Install with
`pnpm install --frozen-lockfile`, then run `pnpm verify` and
`pnpm test:acceptance`. Unit and contract tests use synthetic fixtures and need no
provider credentials. PostgreSQL integration tests need a separate loopback-only
test database; see `docs/runbooks/local-development.md`.

Do not supply live provider credentials merely to evaluate this sample. Runtime
examples are deliberately nonfunctional placeholders. Do not run deployment or
Terraform apply commands as part of reviewing the repository.

## Showcase changes

No original Git history, operational ledgers, cloud/billing evidence, private
Notion links, household names or original live domain is included. Principals
and fixtures use Operator, Steward and Participant. The three-role example
policy is illustrative, not another person's live access policy.

The deployment workflow is retained as `.github/workflows/deploy.yml.example`,
which GitHub does not run. The matching contract test reads that template.
CI and secret-scan workflows remain; no original GitHub environments, variables,
credentials, protection settings, releases, issues or artifacts are copied.
The sample keeps `private: true` to prevent package publication and uses
`UNLICENSED` metadata. It is prepared for public portfolio inspection with rights
reserved. Public viewing and GitHub forks are subject to GitHub's applicable
terms; no additional reuse license is granted. See `NOTICE.md`.
The owner intends to reconsider open-source licensing after V1 is working.
Any future license requires a separate decision.

## Authorship and limitations

This is a human-directed, AI-assisted project. The owner supplied requirements,
architecture constraints, implementation direction, review and validation; AI
tools assisted with code and documentation. No claim of unaided code authorship
is made. Fresh validation results for this copy are recorded in docs/validation.md.

Provider APIs do not provide a shared transactional boundary. Preserve documented
version-race, unknown-outcome and reconciliation limitations. Production readiness,
public-release clearance and absence of vulnerabilities must not be inferred from
the existence of tests or this documentation. The unresolved findings and their planned fixes are listed in KNOWN_ISSUES.md.
