# SIM-G low-cost cloud hosting decision

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

**Owner:** Operator  
**Source date:** 2026-10-24, the operator-selected time zone  
**Status:** Approved deployment direction; detailed feasibility and provisioning remain gated.

## Decision and precedence

Operator selected Google Compute Engine `e2-micro` as the preferred SIM-G production target, with the gateway and its operational PostgreSQL database on one VM. SIM-G must remain in the cloud, independent of the local service host and home Internet. Its total incremental recurring production cost must be designed to stay **strictly below USD 10/month, preferably USD 5/month or less**.

The [canonical cross-system owner decision](https://example.invalid/private-reference-removed) records this SIM-G-specific exception. local development host remains synthetic-data development/QA only; the local service host remains the default for other locally hosted household services.

For **hosting direction and the next F13 planning action only**, this addendum supersedes the earlier Cloud Run/Cloud SQL production prescription in Engineering Design section 2, implementation PLAN Task 13, and the unresolved host-placement wording in both STATUS files. Preserve all other PRD, engineering, security and acceptance requirements. Do not execute the old Cloud Run/Cloud SQL resource list as written. The previous topology remains an alternative, not the selected household target.

This is not evidence that a VM has been built, tested, funded, deployed or approved for real data. No resource creation, billing-account modification, credential creation, migration or infrastructure apply is authorized by this document.

## Intended shape

- One non-Spot, free-tier-eligible Compute Engine `e2-micro` in an eligible US region, subject to actual account allowance and regional availability verification. Exact region/zone remains a planning choice.
- Existing gateway and PostgreSQL colocated. Database access stays loopback, Unix socket or an equivalently isolated local container network, never a public listener. Respect existing production database transport validation; any required adaptation is reviewed and tested rather than bypassed.
- Minimal HTTPS ingress, correct proxy/IP trust and rate limiting. Do not automatically add a managed load balancer, NAT gateway, Kubernetes cluster, Cloud SQL instance or second always-on VM.
- Dedicated runtime service account, narrowly scoped Secret Manager access and dedicated Drive impersonation. Preserve individual Google OIDC identities and every authorization, approval, legal-hold and uncertain-write rule.
- Preserve the durable audit outbox and existing in-process delivery loop. Verify collection and retention away from the VM; successful stdout writes alone do not prove remote retention. Memory and cost measurements include log collection.
- Encrypted off-VM backups, documented retention and tested restore, restart/rollback procedures, host patching and disk monitoring. A single VM is not high availability; recovery-point/recovery-time expectations still need explicit acceptance before rollout.
- Separate dev/prod configuration, projects, identities, credentials, databases and provider roots remain mandatory. Local development uses fictional synthetic data. A separate dev project need not run paid compute continuously; any temporary cloud validation environment needs its own explicit resource approval and cleanup plan.

## Cost acceptance

Model the complete recurring bill: VM eligibility, standard persistent disk including the boot disk, IPv4, transfer, backup storage/operations, log collection/retention, secrets, image storage/builds, DNS and any other incremental dependencies. Include tax where applicable and distinguish existing subscriptions from new project costs. Temporary trial credits are not evidence of sustainable recurring cost. Free-tier allowances can be shared across projects on the billing account; verify availability rather than assuming a new project gets an independent allowance.

Pricing reference checked 2026-10-24: standard VM external IPv4 is USD 0.005/hour, approximately USD 3.65 in a 730-hour month (USD 3.72 in 744 hours), before other charges. Target meaningful headroom below USD 10, not a USD 9.99 estimate with uncounted costs.

Alerts-only billing budgets do not cap spending. The current documented spend-cap service list does not include Compute Engine. Quotas, resource restrictions, bounded retention and traffic, alerts and a reviewed response plan reduce risk but must not be represented as a guaranteed maximum invoice. Any automatic shutdown response needs an explicit availability/data-safety decision.

No silent instance upsize, paid dependency or safeguard reduction to make the design pass. If safe, usable operation or the complete cost model cannot meet the owner's limit, stop and present evidence and alternatives.

## Next bounded work: F13a feasibility and plan reconciliation

1. Reconcile root STATUS, detailed implementation status, Engineering Design section 2 and PLAN Task 13 with this approved direction, preserving prior deployment history. Record the exact next bounded coding slice.
2. Prepare the container/build and VM deployment design without live credentials or cloud changes. Validate any Terraform scaffolding offline/static where supported; do not claim an authenticated cloud plan or IAM check from a mocked plan.
3. Measure the complete stack against the `e2-micro` envelope of 1 GiB RAM and shared CPU using synthetic data. Include realistic concurrency, startup/provider mocks, audit backlog and sink failure, database restart, TLS/logging overhead and backup/restore. Local CPU or RAM limits are preliminary evidence, not proof of actual E2 performance.
4. Prepare an itemized recurring-cost calculation and least-privilege network/identity/backup/patching plan. Prefer building images in development/CI rather than on the small production VM.
5. Request a specifically bounded cloud-trial/resource authorization only after the design and cost evidence are ready. Complete live provider, real-client authentication and F14 acceptance through existing isolated-development and onboarding gates.

Keep changes in separate reviewed slices with normal tests, security checks, PR and exact-head CI. Do not claim F13, production or family onboarding complete from documentation or synthetic testing.

## Primary references to recheck before provisioning

- [Google Cloud Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features)
- [E2 machine characteristics](https://docs.cloud.google.com/compute/docs/general-purpose-machines)
- [VPC and external IPv4 pricing](https://cloud.google.com/vpc/pricing)
- [Billing budgets](https://docs.cloud.google.com/billing/docs/how-to/budgets)
- [Spend-cap eligible services and limitations](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)

## Slice mapping (recorded during reconciliation, 2026-10-25)

Open PR #74 already used the name F13a when this handoff was written, so the
handoff's "F13a" steps map onto PLAN Task 13 slices:

- **Step 1 (reconciliation):** done in F13a (PR #74), together with the
  target-independent container image and supply-chain checks.
- **Step 3, and the cost part of step 4:** F13b, synthetic capacity and
  recurring-cost evidence.
- **Step 2, and the network/identity/backup/patching plan of step 4:** F13c,
  VM deployment design and offline-validated scaffolding.
- **Step 5:** F13d, the bounded cloud trial request.

Root `STATUS.md` `NEXT:` names the current slice.
