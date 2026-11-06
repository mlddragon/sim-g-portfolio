# Infrastructure templates

Account-neutral templates retained for review. The source project has recorded
development smoke and recovery tests; this sanitized copy is not deployed.
See the root README for the precise maturity boundary.

## Layout

| Path                       | Role                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules/vm`               | One environment: APIs, network, firewall, IPv4, the e2-micro VM and its data disk, buckets, the audit log bucket and sink, telemetry log metrics. |
| `modules/vm-host`          | Provider-free: renders `deploy/vm/host` into the VM's cloud-config `user-data` ([VM host layer](../../docs/runbooks/vm-host.md)).                 |
| `environments/dev`, `prod` | Thin roots: a `gcs` backend supplied at `init`, owner inputs with no defaults, and the module with a fixed `environment`.                         |

Each root has its own state and its own project.

- **The label guard catches mistakes.** Every resource takes its project from
  a data source whose postcondition requires the label
  `family_brain_environment=<environment>`. A root pointed at the other
  environment's project therefore fails before any change, even with
  `-target`.
- **It is not the dev/prod boundary.** It cannot see which state bucket a
  root was initialised against, and anyone who can edit the project can change
  the label. The boundary is IAM: dev identities hold nothing in the prod
  project or its state bucket. Those grants are owner-gated (below).

## What the module creates (F13c-5a)

- **Network:**
  - a custom VPC with one `/28` subnet;
  - firewall rules for HTTPS (443) and HTTP (80, redirects and certificate
    validation only) to the edge tag, and SSH (22) only from Identity-Aware Proxy
    (`35.235.240.0/20`);
  - production gets one Standard-tier static IPv4. Development gets an
    ephemeral one, because a reserved address left unattached bills at about
    USD 7/month.
- **VM:**
  - e2-micro, non-Spot, live-migrating;
  - Shielded VM (secure boot, vTPM, integrity monitoring);
  - an exact Container-Optimized OS image;
  - OS Login, with project SSH keys blocked and the serial port off;
  - metadata that holds no secrets;
  - deletion protection in production.
- **Disks:** a 10 GB `pd-standard` boot disk and a separate 10 GB
  `pd-standard` data disk (PostgreSQL and the ingress certificates). Production uses 20 of
  the billing account's 30 free GB-months. A temporary dev VM adds a fraction
  of that.
- **Identities and grants (F13c-5d, VM design section 5).** No service
  account keys. Every grant is an additive member on one resource, except
  the one approved project-level role:
  - `fbg-runtime`, attached to the VM: `logging.logWriter` (the project-level
    exception, owner decision 2026-10-27); create-only on both backup
    buckets; read on the deploy-pointer bucket; read on the image
    repository; accessor on each of its three secrets individually; and
    token creator on `fbg-drive` only.
  - `fbg-drive`: no Google Cloud roles. Share only the registered Drive
    roots with it.
  - `fbg-deployer`: writer on the image repository and object admin on the
    deploy-pointer bucket only. No `actAs` on the runtime, no compute, IAP
    or metadata roles: it is runtime-equivalent, not root-equivalent.
  - The operator (`operator_email`, the owner): `compute.osAdminLogin` and
    `iap.tunnelResourceAccessor` on the instance, and `serviceAccountUser`
    on the runtime, which OS Login needs on an instance with a service
    account. OS Login requires two-step verification (`enable-oslogin-2fa`).
- **Secrets:** three empty containers (`family-brain-database-url`,
  `family-brain-notion-token`, `family-brain-github-app-key`), replicated in
  the region. Values are added out of band and never enter Terraform or its
  state. The configuration document is a file on the data disk holding only
  references, so it is not a secret.
- **Images:** one Docker repository, `sim-g`, with immutable tags; deployment
  is by digest. Development keeps the 5 newest versions of each image and
  removes older ones after 14 days; production removes none automatically.
- **Federation:** a GitHub workload identity pool whose provider accepts only
  `.github/workflows/deploy.yml` of the exact repository (by ID and name), on
  `refs/heads/main`, in this environment's GitHub environment, from a
  manual dispatch; development also accepts the run that follows CI's
  success on `main` (`workflow_run`, owner ruling 2026-11-04). Only that
  environment may impersonate the deployer.
- **Buckets:** all three have uniform access and enforced public access
  prevention.
  - Encrypted daily backups: a 35-day retention policy, 7-day soft delete
    and deletion at day 36.
  - Encrypted 15-minute backups (`<project>-sim-g-recent-backups`, the name
    the VM derives): a 3-day retention policy, 7-day soft delete and
    deletion at day 4. It is a separate bucket because a retention policy
    covers every object in its bucket
    ([recovery point investigation](../../docs/engineering/2026-10-26-recovery-point-investigation.md),
    section 5).
  - The versioned deploy pointer, keeping the last 50 versions.
- **Audit:** a dedicated log bucket whose retention is a required owner input,
  and a sink for the VM's `jsonPayload.logType="family_brain_audit"` lines.
- **Telemetry:** one log-based metric per port metric name.
- **Alerts (VM design section 11),** to `alert_email` (the owner's
  Workspace account, from approved configuration; never guessed):
  - an uptime check on `https://<domain>/healthz` and its alert;
  - `family_brain/ops_event`, one log-based metric labelled by event, and one
    alert on any event;
  - the independent off-VM alert: no recent-tier `backup_completed` for 45
    minutes (owner decision 2026-10-27). It also pages during planned
    reboots and maintenance;
  - optionally, a USD 10 monthly budget alerting at 50 and 80 % when the
    owner supplies `billing_account_id` (never committed). Budgets alert
    only; Compute Engine has no spend cap. The applier needs Billing Account
    Administrator or Costs Manager on that account; the roots set
    `user_project_override` so the Budgets API accepts user credentials.
  - The log filters match a line both as parsed JSON (`jsonPayload.msg`, the
    containers) and as a raw journal line (`jsonPayload.MESSAGE`, the host
    units), until the F13d check settles which shape COS ships.
  - The uptime alert fires from apply until DNS, the certificate (after the
    terms flag) and the gateway are live; expected during bring-up.
- **GitHub environment:** derived from `environment` (`development` or
  `production`), never an input, so a production root can never accept the
  development workflow.
- **Destruction:** in production, the data disk, all three buckets, the
  audit log bucket and the static address carry
  `deletion_policy = "PREVENT"`. This policy is kept in state, so it still
  holds when a resource block is removed. Development uses `DELETE`, and
  its data is synthetic.
  - **Backup buckets are not torn down at once.** Without `force_destroy`,
    Terraform cannot delete a non-empty bucket. Objects under a retention
    policy cannot be deleted early: 3 days for recent, 35 for daily.
  - **Teardown:** stop both backup timers, let lifecycle empty the
    buckets, then destroy them. Soft-deleted objects stay billed for 7 more
    days. That tail is pennies at synthetic sizes.

## Not yet here

- **Production promotion:** the prod deployer's read on the dev image
  repository, the promotion job (copying the dev-validated digests, never
  rebuilding) and the production environment's evidence gate (VM design
  section 10). Not needed for the development QA.
- **State-bucket IAM:** each environment's state bucket readable only by
  that environment's operator and deployer; the owner creates the buckets
  (below).
- **The disk-usage timer** behind the 80 % disk event (VM design section 11).
- Locking either backup retention policy or the audit bucket (the owner chose
  unlocked), and data-disk snapshots (the owner chose off initially).
- Excluding audit lines from the `_Default` log bucket. Today they are also
  kept there for 30 days, which outlives an audit retention under 30 days.

## F13d preconditions (owner, before any apply)

- **Remove the `default` network** and its open SSH, RDP and ICMP rules.
  Enabling Compute Engine creates it unless the organisation policy
  `compute.skipDefaultNetworkCreation` applies. This VM does not use it, but
  any later VM on it would be exposed.
- **Disable or strip the default Compute Engine service account.** It is
  created with `roles/editor`. This is an IAM change, so the owner decides.
- **Enable Cloud Resource Manager and Service Usage in each environment's
  project** first: the roots send that project as the quota project
  (`user_project_override`), so a plan reads both there before the module
  can enable the rest. The applier needs `serviceusage.services.use` there
  (Owner and Editor include it; otherwise
  `roles/serviceusage.serviceUsageConsumer`).
- **Create a versioned state bucket in each environment's project**, readable
  only by that environment's operator (who applies) and deployer.
- **Plan how the boot image is updated.** COS cannot update in place with
  Secure Boot, so patching replaces the VM from a newly pinned exact LTS
  image (owner decision 2026-10-30; the
  [COS image replacement runbook](../../docs/runbooks/cos-image-replacement.md)).
  Changing `boot_image` replaces the instance only; the data disk survives.
  Production's deletion protection blocks the replacement, so production
  needs a separately approved, deliberate step.

## Rules the contract tests hold

`tests/contract/vm-infrastructure-boundaries.test.ts` reads every `.tf` file
with comments stripped. It fails on any `.tf.json` file or any resource header
it cannot parse. It also fails if the Terraform:

- defines anything but exactly one e2-micro VM (no `count`, templates or
  groups), or any disk but `pd-standard`;
- reinstates Cloud SQL, Cloud Run, Cloud NAT or a load balancer;
- drops Shielded VM, non-Spot scheduling, OS Login, the blocked project keys
  or the disabled serial port;
- puts a startup script or secret in metadata, or adds project-wide metadata;
- weakens production's deletion protection and policies, or allows
  `force_destroy`;
- takes any resource's project from anywhere but the guarded data source;
- has a firewall rule with non-literal sources, an egress or deny rule, or
  any `allow` block other than TCP 443 or 80 (public) or TCP 22 (IAP only);
- creates a service account key, primitive or public roles, an IAM policy
  or binding (only additive members), any project-level role but the
  runtime's `logging.logWriter`, or reads a secret version;
- lets the deployer act as the runtime or hold compute, IAP or token
  roles; lets anyone but the named operator log in, tunnel or act as the
  runtime; or drops OS Login's two-step verification;
- loosens the federation condition (repository ID and name, `main`, the
  environment, `deploy.yml`, manual dispatch, plus `workflow_run` in
  development only).

`.tfvars`, state and `.terraform/` are ignored. Provider lock files are
committed for `linux_amd64`, `darwin_arm64` and `darwin_amd64`.
