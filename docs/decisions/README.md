# Decision archive

This sanitized mirror preserves the implementation and its product and engineering
reasoning. The archive includes full design documents, alternatives, constraints,
acceptance criteria and complete named sections of engineering rulings. Identities
and deployment identifiers are fictional. Private execution and billing records are
not a prerequisite for understanding the design and are not copied here.

## Reading order and precedence

1. [Product requirements](../product/knowledge_gateway_prd_v1.md) establish the
   users, scope, policy, non-goals and acceptance criteria.
2. [Engineering design](../engineering/knowledge_gateway_engineering_design_v1.md)
   explains the layers, ports, operational state, provider contracts and failure model.
3. [Technology selection](0001-technology-and-deployment-shape.md) records the
   original stack decision. Its Cloud Run and Cloud SQL hosting choice is historical.
4. [Low-cost hosting amendment](../engineering/2026-10-24-e2-micro-hosting-decision.md)
   supersedes that hosting choice with a single VM and locally isolated PostgreSQL.
   It preserves the other product and security requirements.
5. [Architectural decisions](architectural-decisions.md) and
   [implementation rulings](implementation-rulings.md) preserve the detailed decisions
   behind authorization, legal holds, approvals, uncertain writes and deployment.
6. [Implementation plan](../implementation/PLAN.md) and
   [acceptance matrix](../implementation/ACCEPTANCE-MATRIX.md) connect the decisions
   to implementation and validation work.
7. [Current candidate validation](../validation.md) distinguishes checks run on
   this mirror from historical source-project evidence and unresolved findings.

## Detailed design and alternatives

| Record                                                                              | Reasoning retained                                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Capacity report](../engineering/2026-10-25-e2-micro-capacity-report.md)            | Synthetic measurements, failure scenarios, headroom and limits of local evidence            |
| [Cost model](../engineering/2026-10-25-e2-micro-cost-model.md)                      | Historical project estimates, assumptions, tradeoffs and growth risks                       |
| [VM design](../engineering/2026-10-25-e2-micro-vm-design.md)                        | Ingress, IAM, database isolation, audit, deployment, recovery and owner decisions           |
| [Recovery investigation](../engineering/2026-10-26-recovery-point-investigation.md) | Recovery alternatives, recommended approach, evidence, RPO/RTO and reconciliation           |
| [Patching decision](../engineering/2026-10-29-cos-patching-decision-proposal.md)    | Alternatives, Secure Boot constraints, image replacement and the recorded decision          |
| [Production plan](../engineering/2026-11-05-task-14-production-plan.md)             | Phone-first use, rollout sequencing, decisions already made and remaining owner gates       |
| [Connector design](../engineering/2026-11-05-chatgpt-connector-design.md)           | Proposed MCP/OAuth flow, identity binding, client registration, threats and security review |
| [Threat model](../security/threat-model.md)                                         | Assets, boundaries, threats and intended controls                                           |
| [Operational lessons](operational-lessons.md)                                       | Technical findings extracted from private execution evidence                                |

## Historical decision states

An accepted architecture choice is different from permission to operate a live
environment. Approved, proposed, deferred and superseded labels are retained from
the source documents. None of those historical approvals authorize deployment,
spending, real-data use or publication of this mirror.

Production onboarding and the connector remain unfinished. The connector design
is a proposal, not evidence that its OAuth server or MCP transport is implemented.
Earlier Cloud Run, Cloud SQL and deployment claims must be read in their dated
context. Historical price estimates and third-party product descriptions were not
reverified for this export. The current implementation and validation guide describe
what this candidate actually contains and which checks passed.

Original Git history, private approvals, account eligibility checks, credential
custody details and operator-session ledgers are withheld. The technical consequences
of those boundaries remain in the design archive. See
[sanitization and refresh procedure](../release/sanitization.md).
