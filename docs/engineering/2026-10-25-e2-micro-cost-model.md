# SIM-G e2-micro recurring-cost model (F13b)

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

**Status:** Planning estimate, not a quote or an invoice cap. Prices were read
from Google's official pricing and free-tier pages on 2026-10-25 (sources
below). Re-check every figure, and the billing account's actual free-tier
eligibility, before the F13d provisioning request. Nothing has been
provisioned.

**Budget (owner, 2026-10-24):** total incremental recurring production cost
strictly below USD 10/month, preferably USD 5 or less.

## Assumptions

- **Production shape:** one non-Spot `e2-micro` in us-central1, us-west1 or
  us-east1, running the gateway and PostgreSQL, with:
  - a 10 GB **standard** persistent boot disk and a 10 GB **standard**
    persistent data disk, 20 GB in all (the VM design and Terraform; this
    line said a 20 GB boot disk until 2026-10-28);
  - one external IPv4 address on the **Standard** network tier;
  - HTTPS through a local reverse proxy with a free ACME (Let's Encrypt)
    certificate.
- **Household traffic:** fewer than 5,000 API requests a month, with responses
  of a few KB to tens of KB.
- **Backups:** compressed `pg_dump` files encrypted to Cloud Storage
  Standard in the same US region. Daily dumps are kept 35 days, and
  15-minute dumps 3 days in a separate bucket (owner-approved 2026-10-27;
  [recovery point investigation](2026-10-26-recovery-point-investigation.md),
  section 7). They are encrypted on the VM
  to an owner-held public key (for example `age`), so no Cloud KMS charge
  applies; Google's default at-rest encryption is in addition. The F13b
  capacity run measures dump sizes.
- **Images:** built in GitHub Actions under the existing GitHub plan and stored
  in Artifact Registry, keeping only a few recent digests.
- **Development:** no always-on dev compute. A temporary dev VM runs only for
  approved validation windows (assumed 20 hours/month).
- **Billing account:** the Free Tier allowances are counted per billing
  account, so they must not already be consumed by another project.

## Monthly estimate (USD)

| Item                                      | Basis                                                                                                              |        Expected | Notes                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| e2-micro VM                               | Free Tier: one non-preemptible e2-micro per billing account, eligible US regions                                   |            0.00 | **Risk:** if the allowance is already used (another e2-micro anywhere on the billing account, including a concurrent dev VM), the VM is paid at about 6.11/month. That rate comes from third-party price lists (about 0.0084/hour) and must be verified against the Cloud Billing Catalog. |
| Boot 10 GB + data 10 GB, standard PD      | Free Tier 30 GB-months standard PD; then 0.04/GB-month                                                             |            0.00 | 20 of the 30 free GB-months, leaving 10 for a temporary dev disk. Without the allowance about 0.80. A balanced PD is not covered: 20 GB would be about 2.00.                                                                                                                               |
| External IPv4                             | 0.005/hour in use on standard VMs (free for only 1 hour/month per account)                                         |       3.65–3.72 | 730–744 hours. Unavoidable for IPv4 clients.                                                                                                                                                                                                                                               |
| Internet egress                           | Standard Tier: first 200 GiB/month free                                                                            |            0.00 | Expected traffic is far below 1 GiB/month.                                                                                                                                                                                                                                                 |
| Database backups (Cloud Storage Standard) | Free Tier 5 GB-months in US regions, 5,000 Class A ops                                                             |            0.00 | About 1.1 GiB and about 2,950 Class A uploads a month across both tiers at today's size; about 0.04 without the free tier (investigation, section 7).                                                                                                                                      |
| Disk snapshots (optional)                 | Standard snapshot 0.05/GB-month; not in Free Tier                                                                  |       0.00–0.25 | Only if chosen over rebuild-from-image plus the database dump.                                                                                                                                                                                                                             |
| Cloud Logging                             | First 50 GiB/project/month ingested free; retention beyond 30 days 0.01/GiB-month                                  |       0.00–0.05 | Gateway, audit and telemetry lines total well under 1 GiB/month. Audit retention past 30 days is pennies.                                                                                                                                                                                  |
| Log-based metrics / Monitoring            | Within the monthly free metric allotment                                                                           |            0.00 | Re-check if many labels or agent metrics are added.                                                                                                                                                                                                                                        |
| Alerting                                  | Free until at least 2027-09-01; then 0.35 per metric reference per month (official pricing page, read 2026-10-25)  |            0.00 | About 0.70 from September 2027 (see below). Uptime checks are free to 1 million executions per project.                                                                                                                                                                                    |
| Secret Manager                            | 6 active versions and 10,000 accesses free per account; then about 0.06/version-month and 0.03 per 10,000 accesses |       0.00–0.12 | Prod needs 4 secrets. Dev secrets on the same account can exceed 6 versions.                                                                                                                                                                                                               |
| Artifact Registry                         | 0.5 GB-month free; then about 0.10/GB-month                                                                        |       0.00–0.02 | Measured locally: about 105 MB per image digest (arm64; layers already compressed). The free 0.5 GB holds about four digests across dev and prod combined. Same-region pulls are free.                                                                                                     |
| Builds                                    | GitHub Actions on the existing GitHub plan                                                                         |            0.00 | Existing subscription, not a new project cost.                                                                                                                                                                                                                                             |
| DNS                                       | Existing registrar DNS, or Cloud DNS at about 0.20/zone-month                                                      |       0.00–0.20 | The domain registration itself is an existing cost.                                                                                                                                                                                                                                        |
| Temporary dev validation                  | About 20 hours of paid e2-micro (about 0.17), IPv4 (0.10), prorated disk                                           |            0.30 | Only during approved windows; cleaned up afterwards.                                                                                                                                                                                                                                       |
| **Subtotal**                              |                                                                                                                    |   **3.95–4.66** |                                                                                                                                                                                                                                                                                            |
| Sales tax contingency                     | 6 % (Michigan rate) if Google applies it to the account                                                            |       0.24–0.28 | Check the invoice jurisdiction.                                                                                                                                                                                                                                                            |
| **Expected total**                        |                                                                                                                    | **≈ 4.19–4.94** | Meets the preferred USD 5 target, with little headroom.                                                                                                                                                                                                                                    |

## Checked against the F13b capacity run

These are local synthetic measurements; see the
[capacity report](2026-10-25-e2-micro-capacity-report.md).

- **Backups (observed):** a dump of 702 operations, 14,036 audit events and
  816 aliases is 0.81 MiB. Estimated growth is under 1 MiB a month at
  household volume. Both tiers (35 daily dumps and 3 days of 15-minute
  dumps) hold about 1.1 GiB today, inside the 5 GB-month free Cloud Storage
  allowance, which they outgrow at a dump of about 4 MiB.
- **Logging (estimated):**
  - **Observed:** gateway output per request is one request log line, two
    audit events and a few telemetry lines. Fluent Bit used 4–5 MiB.
  - **Estimated:** about 1–2 KB per request, so around 10 MB a month at 5,000
    requests. That is about 0.02 % of the 50 GiB free ingestion.
  - **Not measured:** Google's own logging agent (memory, and any OS log
    volume) is checked on the real VM in F13d.
- **No paid capacity dependency was needed.** The stack fit in 1 GiB, with at
  least 445 MiB free, so no larger machine, managed database or load balancer
  is implied.

## From September 2027 (alerting charges)

The design keeps alerting to two metric references (uptime, plus one labelled
operations-event metric). They add about 0.70, or 0.74 with tax, raising the
expected total to about **4.93–5.68**. That is still well under USD 10, but at
or just above the preferred USD 5. Keeping only the operations-event alert
brings it to about 4.56–5.31. The optional off-VM backup-absence alert (VM
design section 11) would add about 0.37 with tax, giving about 5.30–6.05.

## Risk cases

- **No free e2-micro allowance:** about +6.11, plus 6 % tax on it, for a
  total of roughly 10.7–11.4. That **breaks the USD 10 limit.** F13d must confirm that the
  billing account has no other e2-micro usage, and that dev never runs a second
  e2-micro concurrently for long.
- **Balanced boot disk:** about +2.00, for a total of about 6.2–6.9. Use a
  standard PD.
- **Premium network tier:** the 1 GB Free Tier egress allowance becomes the
  only one. That is still about 0 at household volume, but Standard Tier is
  simpler to reason about.
- **Heavier log agent or chatty logs:** ingestion stays free under 50 GiB, but
  memory, not money, is the constraint (see the capacity report).
- **Budget alerts do not cap spend.** Compute Engine is not eligible for spend
  caps, so this estimate is a target, not a guaranteed maximum.

## Not cheaper without owner approval

The external IPv4 address is the largest single item. IPv6 addresses on VMs
are free, but an IPv6-only endpoint is unreachable from IPv4-only clients. A
third-party IPv4 front end would add a TLS-terminating intermediary that can
see traffic. Either change needs explicit owner review; it is not adopted here.

## Sources (read 2026-10-25)

- [Google Cloud Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features):
  - e2-micro limits;
  - 30 GB-months standard PD;
  - 1 GB North America egress;
  - Logging 50 GiB/project;
  - Secret Manager 6 versions and 10,000 accesses;
  - Artifact Registry 0.5 GB;
  - Cloud Storage 5 GB-months in US regions.
- [Network pricing](https://cloud.google.com/vpc/network-pricing): IPv4 at
  0.005/hour on standard VMs, with a 1 hour/month free tier; free IPv6 on VMs.
- [Network Service Tiers pricing](https://cloud.google.com/network-tiers/pricing):
  Standard Tier 0–200 GiB/month free.
- [Disk and image pricing](https://cloud.google.com/compute/disks-image-pricing):
  standard PD (200 GB = 8.00/month) and standard snapshots at 0.05/GB-month.
- [Cloud Logging pricing](https://cloud.google.com/stackdriver/pricing):
  0.50/GiB beyond 50 GiB/project, and retention at 0.01/GiB-month beyond 30
  days.
- [Secret Manager pricing](https://cloud.google.com/secret-manager/pricing),
  [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing)
  and [Cloud Storage pricing](https://cloud.google.com/storage/pricing).
- [Spend caps](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps):
  Compute Engine is not eligible.
- The e2-micro paid hourly rate was not shown on the official page as fetched.
  The 0.0084/hour figure comes from third-party price lists (gcloud-compute.com,
  economize.cloud) and is unverified.
