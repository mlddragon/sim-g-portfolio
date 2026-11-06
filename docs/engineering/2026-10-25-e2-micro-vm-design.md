# SIM-G e2-micro VM deployment design (F13c)

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

**Status:** design with the owner's section 14 decisions recorded
(2026-10-27). It authorizes nothing: no resource, IAM grant or deployment is
created from it without separate F13d approval.

It implements the owner's [hosting decision](2026-10-24-e2-micro-hosting-decision.md)
within PLAN Task 13's binding safeguards. Evidence:
[capacity report](2026-10-25-e2-micro-capacity-report.md) and
[cost model](2026-10-25-e2-micro-cost-model.md).

Owner decisions are marked **[owner]**. Implementation slices are marked
**(F13c-n)**. Items to verify on the real VM are marked **[F13d check]**.

## 1. Host

- **Machine:** one non-Spot `e2-micro` in us-central1, us-west1 or us-east1
  **[owner: region]**.
  - Shielded VM is on: Secure Boot, vTPM and integrity monitoring.
  - On host maintenance, the VM live-migrates and restarts automatically.
  - Deletion protection is on.
  - Access scope is `cloud-platform`; IAM alone limits what the account can
    do. The default scopes would block Secret Manager, IAM Credentials and
    Storage writes.
- **OS:** Container-Optimized OS (COS), stable channel, x86-64.
  - It provides a read-only, verified root filesystem and automatic image
    updates within a milestone. Google's built-in Fluent Bit logging agent is
    enabled with metadata `google-logging-enabled=true`.
  - Containers start from `cloud-init` systemd units. The deprecated container
    startup agent (`gce-container-declaration`) is not used.
  - COS ships no `gcloud`, `gsutil` or `age`:
    - uploads use `curl` with a metadata-server token on the host;
    - encryption runs in a pinned container;
    - Artifact Registry pulls use `docker-credential-gcr`.
- **Disks**, all standard persistent disk (balanced is not free); together 20
  GB of the free 30 GB-months, leaving room for a temporary dev disk:
  - **Boot disk:** 10 GB, the COS minimum, recreated freely.
  - **Data disk:** 10 GB, with `auto_delete=false` and protected from deletion
    in production by Terraform's `deletion_policy = "PREVENT"`, which is kept
    in state (development's is deletable). It holds only PostgreSQL data and
    the ingress certificates.
    - It is mounted at `/mnt/disks/data` (`nodev,nosuid,noexec`) from its
      own device, `/dev/disk/by-id/google-sim-g-data`, after its filesystem
      label is checked, never from whichever disk carries the label.
    - It is formatted only when it has **no** filesystem. Automation never runs
      `mkfs` on a disk that has one.
- **Access:**
  - OS Login is required, with two-step verification **[owner]**, and
    project-wide SSH keys are blocked.
  - The serial port is disabled.
  - SSH works only through IAP TCP forwarding. Only the owner holds
    `iap.tunnelResourceAccessor` and `compute.osAdminLogin`.
- **No secrets in metadata.** Every process on the VM can read every instance
  metadata attribute, including `user-data`. Role passwords are loaded into
  Secret Manager out of band, never into `user-data`.

## 2. Workloads (systemd units)

| Unit                        | Image (by digest)                                                                              | Networks                                 | Purpose                                                                                                                                                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sim-g-firewall`            | host                                                                                           | host                                     | Installs the netfilter rules in sections 3 and 4. Every container unit has `Requires=` and `After=` on it, so containers never start without the rules. If installation fails, the unit fails and nothing starts (fail closed). It is re-applied at every boot, because COS `/etc` is stateless. |
| `sim-g-postgres`            | `postgres:17.x-alpine` (CI-built derivative, section 6)                                        | `none`                                   | PostgreSQL with **no TCP listener** (`listen_addresses=''`). It listens only on a Unix socket in a host directory shared with the gateway and the job containers.                                                                                                                                |
| `sim-g-gateway`             | `family-brain-gateway@sha256:…`                                                                | `sim-g-gateway-egress`, `sim-g-internal` | The gateway: read-only, no capabilities, no new privileges, memory-limited, uid 1000. It publishes no host port.                                                                                                                                                                                 |
| `sim-g-edge`                | a CI-built derivative of `nginxinc/nginx-unprivileged` (pinned base, security updates applied) | `sim-g-edge-egress`, `sim-g-internal`    | The TLS ingress with request limits before the gateway; the only published service (F13c-3, [ingress runbook](../runbooks/ingress.md)). Hardened in section 4.                                                                                                                                   |
| `sim-g-certificate.timer`   | a CI-built derivative of `certbot/certbot` (likewise)                                          | `sim-g-edge-egress`                      | Obtains and renews the Let's Encrypt certificate twice a day through the HTTP-01 webroot, once the owner accepts the terms.                                                                                                                                                                      |
| `sim-g-backup.timer`        | the PostgreSQL derivative, then an encryption container                                        | `none`, then a host upload               | Daily encrypted logical backup (section 8). Before every migration, `sim-g-migrate` starts the same backup service.                                                                                                                                                                              |
| `sim-g-backup-recent.timer` | the same two containers                                                                        | `none`, then a host upload               | The same backup every 15 minutes, to the 3-day bucket (section 8).                                                                                                                                                                                                                               |
| `sim-g-backup-stale.timer`  | host script                                                                                    | host                                     | Reports `backup_stale` after two consecutive missed 15-minute backups (sections 8 and 11).                                                                                                                                                                                                       |
| `sim-g-deploy-watch`        | host script                                                                                    | host                                     | Follows the deployment pointer and restarts the gateway (section 10).                                                                                                                                                                                                                            |

- **Networks:**
  - `sim-g-internal` is a Docker `--internal` bridge, with no egress, used
    only between nginx and the gateway.
  - The two egress bridges are separate subnets, so the gateway's and nginx's
    outbound traffic can be told apart.
  - Docker IPv6 is off.
- **Memory limits (F13c-5):** about 256 MiB PostgreSQL, 384 MiB gateway and
  96 MiB nginx. These sit above the F13b peaks (68 / 136 / 18 MiB) with
  margin, and they stop one runaway container from exhausting the VM.
- **Docker logs:** the `json-file` driver with rotation (for example 10 MB × 5
  files per container), sized against how far the logging agent can fall
  behind (section 9).
- **PostgreSQL tuning:** as tested in F13b: `shared_buffers=64MB`,
  `max_connections=25`, `work_mem=2MB`. The gateway pool stays at 10.
- **Restarts:** every unit uses `Restart=always` with back-off.

## 3. Network and ingress

- **VPC:** a custom VPC with no automatic subnets and no default firewall
  rules. The project's auto-created `default` network (open SSH, RDP and
  ICMP) is removed before any apply, an F13d precondition
  (`infra/google/README.md`).
- **Firewall:**
  - allow `tcp:443` from anywhere to the `sim-g-edge` tag;
  - allow `tcp:80`, only for HTTPS redirects and the ACME HTTP-01 challenge
    (owner decision 2026-10-27);
  - allow `tcp:22` from `35.235.240.0/20` (IAP) only;
  - everything else is implicitly denied, including any database port.
- **Address:** one static external IPv4 on the **Standard** network tier
  (about USD 3.65–3.72 a month, the largest cost). Egress stays open for
  Google APIs, Notion, GitHub and ACME.
- **DNS:** an A record and a CAA record (Let's Encrypt only) at the owner's
  existing DNS provider for `brain.example.invalid` (the provider is still to
  be confirmed; no DNS change is authorized). certbot obtains and renews the
  certificate, and nginx sends HSTS.
- **Proxy trust (F13c-3):**
  - nginx is the only hop. It replaces any `X-Forwarded-For` with the TCP
    peer and clears the other forwarding headers. The gateway trusts one hop
    (`build-app.ts` uses the socket peer, nginx, as hop 0), so `request.ip`
    is the real client.
  - It is set **explicitly**: `GATEWAY_TRUSTED_PROXY_HOPS=1` and
    `GATEWAY_HOST=0.0.0.0` inside `sim-g-internal`, where nothing else can
    reach the gateway.
  - This depends on Docker keeping the client's source address (iptables
    DNAT, with the userland proxy disabled) **[F13d check: logs show real
    client addresses]**.
- **Flood protection (F13c-3, owner decision: nginx):**
  - **Request limits before Node.** nginx's `limit_req` zones, keyed on the
    TCP peer only: 2 requests/s per address (burst 30), 15 requests/s
    across all addresses (burst 60), and the health check's own bucket.
    Rejections are cheap `429`s in the gateway's JSON shape, with
    `Retry-After`, and are not logged.
  - **Connection limits.** nginx allows 16 connections per address. Host
    rules in a `SIM-G-INGRESS` chain, jumped to from `DOCKER-USER` for new
    connections to nginx's published ports after DNAT, allow per source 20
    new connections a second (burst 40) and 32 open at once.
  - **Timeouts and sizes.** Short header, body and keep-alive timeouts,
    header buffers sized for the gateway's longest token, and the gateway's
    body limits (64 KiB; 2 MiB for its three content mutations, streamed).
    HTTP/1.1 only.
  - **Verified offline:** `pnpm edge:check` (the real pinned nginx) and the
    F13b capacity harness's flood-with-household phase. On the VM,
    re-measured in F13d **[F13d check]**.

## 4. Metadata-server isolation

Every process on a VM can request the attached service account's token from
`169.254.169.254`. Least privilege at the process level:

- **PostgreSQL and the job containers** run with `--network none`, so they
  have no route to it.
- **Only the gateway reaches it.** `DOCKER-USER` sends container traffic
  for `169.254.169.254` to one chain (F13c-5b,
  [VM host layer](../runbooks/vm-host.md)). Except DNS, which issues no
  credentials, the chain passes only packets that both arrive on the
  gateway's fixed bridge (`sim-g-gw0`) and come from its subnet. The edge
  bridge (nginx and certbot), `docker0` and a forged gateway address on another bridge
  are all dropped. `sim-g-internal` has no egress at all.
- **nginx and certbot are hardened:**
  - they run as uid 101; nginx listens on high ports inside the container
    (published as 443 and 80);
  - `--cap-drop=ALL`, so it has no `NET_RAW` for spoofing;
  - read-only root filesystem with tmpfs scratch;
  - `no-new-privileges`;
  - memory limit.
- **The host itself** (the logging agent, the upload step and the deploy
  watcher) keeps metadata access.

Residual risks:

- Anything running as root on the host can mint the runtime account's tokens.
- A compromised nginx can still read and replay user bearer tokens within
  their lifetime. It terminates TLS, so this is inherent.

## 5. Identities and IAM

- **No keys anywhere.** The runtime account is attached to the VM; deployment
  uses GitHub workload identity federation.
- **`fbg-runtime`** (attached to the VM):
  - `secretmanager.secretAccessor` on each of its own secrets individually
    (F13c-5d: `infra/google/modules/vm/secrets.tf`):
    - the `gateway_runtime` database URL;
    - the Notion token;
    - the GitHub App key.

    The configuration document is a file on the data disk holding only
    references, not a secret (engineering ruling, F13c-5d).

    It holds **no** migration or backup credentials (section 6).

  - `iam.serviceAccountTokenCreator` on `fbg-drive` only;
  - `artifactregistry.reader` on the prod repository;
  - `storage.objectViewer` on the deploy-pointer bucket;
  - `storage.objectCreator` on the two backup buckets only, daily and recent
    ([recovery point investigation](2026-10-26-recovery-point-investigation.md),
    section 8, item 5). It cannot read, list, overwrite or delete backups.
  - **Exception:** `logging.logWriter`, which Google grants only at project
    level. It is write-only and needed by the logging agent. Accepted by the
    owner (2026-10-27); the infrastructure contract test allows exactly this
    one project-level role.
- **`fbg-drive`:** no Google Cloud roles. It is shared only with the
  registered Drive roots.
- **`fbg-deployer`**, federated from the exact repository ID and name,
  `refs/heads/main`, the GitHub environment, the deploy workflow file, and
  push or dispatch events only. **There is no instance `setMetadata` and no
  `actAs` on the runtime.**
  - **Dev (F13c-5d):** writer on its own repository and object admin on its
    pointer bucket; the development deploy workflow (`deploy.yml`, manual
    dispatch from `main` after CI) builds and pushes by digest.
  - **Prod (later slice, before production):**
    - `artifactregistry.writer` on the prod repository, used only to copy the
      dev-validated digest in;
    - `artifactregistry.reader` on the dev repository, so CI, not the prod VM,
      bridges dev to prod;
    - `storage.objectAdmin` on the deploy-pointer bucket only.
- **The operator** (the owner): `compute.osAdminLogin` and
  `iap.tunnelResourceAccessor` on the instance, and `serviceAccountUser` on
  the runtime, which OS Login requires on an instance with a service
  account. OS Login requires two-step verification (`enable-oslogin-2fa`).

  So the deployer can make the VM run any image that is in the prod
  repository, as the runtime account. It is **runtime-equivalent, not
  root-equivalent**: it cannot change the VM's metadata, SSH keys, OS Login,
  logging or start-up configuration. The production GitHub environment's
  required reviewers guard it, along with the acceptance and readiness
  evidence (section 10).

## 6. Database

- **Transport (F13c-2, PR #79, held for owner review):** the VM uses only the
  socket form,
  `postgresql://gateway_runtime:<password>@/family_brain_gateway?host=/run/postgresql`.
  `/run/postgresql` is the only accepted socket directory and the retired
  `/cloudsql/` form is refused. **Owner decision 2026-10-27, Option A:**
  retain general production TCP transport support for named hosts only with
  certificate-verified TLS (`sslmode=verify-full`), but the **current E2 Micro
  deployment must enforce Unix-socket-only configuration** and PostgreSQL
  must have no TCP listener. Acceptance of this design choice does not merge
  PR #79; its code and tests remain subject to reviewed quality gates.
  Any later remote-production-database design requires separate owner approval.
- **Image** (`deploy/vm/postgres/`): a small CI-built derivative of the
  pinned PostgreSQL image, built, scanned and promoted by digest like the
  gateway image. It:
  - adds `age` and passwd entries for the two job users (uids 9001 and
    9002), which peer authentication needs;
  - removes `gosu`;
  - defaults to the no-role uid 65534, with the server run as uid 70;
  - bakes in safe `initdb` and server defaults.
- **Authentication (`pg_hba`, `local` only):**
  - `gateway_runtime`, the gateway at uid 1000, uses `scram-sha-256` with its
    password in Secret Manager.
  - `gateway_migrator` (uid 9002) and `gateway_backup` (uid 9001) use `peer`
    with a `pg_ident` map from those uids only. They have **no passwords**, so
    nothing on the VM, including the runtime account, can fetch migration or
    backup credentials. Only the host starts these job containers.
  - The bootstrap superuser `postgres` uses `peer` through `docker exec`
    inside the PostgreSQL container, uid 70.
  - The gateway's uid 1000 maps to none of these.
- **Roles**, following [database migrations](../runbooks/database-migrations.md):
  - `gateway_migrator` owns the schema and is `NOSUPERUSER NOCREATEDB
NOCREATEROLE NOREPLICATION`;
    - `gateway_runtime` has `SELECT, INSERT, UPDATE` only. A post-migration
      grant script gives it this and keeps it off the migration ledger;
  - `gateway_backup` has `pg_read_all_data` and nothing else.
- **Migrations:** a one-shot container of the gateway image digest, as uid
  9002, runs after a fresh backup and before the gateway restarts. Never at
  gateway start-up. This needs a compiled migration entry point in the image
  (F13c-4b).

## 7. Audit and observability

The PLAN Task 13 binding safeguards: durable audit with verified remote
collection and explicit retention, and the log-based metrics.

- **Collection:**
  - the gateway writes structured JSON to stdout, and Docker's `json-file`
    driver rotates it;
  - COS's Fluent Bit agent ships it to Cloud Logging;
  - [F13d check] that JSON lines arrive as `jsonPayload` with `severity` and
    `logType` intact, because every filter and metric below depends on it;
    and the same for a host unit's line (a recent-tier `backup_completed`),
    which goes through the journal, not Docker's `json-file`. The alert
    filters match both shapes until this is settled (F13c-5d).
- **Audit bucket:** `family-brain-audit` in the VM's region, with retention an
  explicit input **[owner: days; whether to lock the bucket]**. It is
  protected from deletion.
  - A sink routes
    `resource.type="gce_instance" AND jsonPayload.logType="family_brain_audit"`
    (the filter is finalized after the F13d check) into it.
  - The archived Cloud Run sink used `cloud_run_revision`, so its filter
    changes here.
- **Telemetry:** one log-based metric per telemetry metric name, as in the
  archived module, filtered on `jsonPayload.logType="family_brain_telemetry"`.
- **Delivery risk:** the outbox counts a successful stdout write as delivered.
  Events can therefore be lost after that point:
  - if Docker log rotation outruns the agent;
  - if the agent's buffer is lost in a reboot.

  Mitigations:
  - rotation is sized generously, and the agent's backlog is watched;
  - **[F13d check]** a synthetic audit event written on the VM appears in the
    audit bucket;
  - a periodic reconciliation compares outbox delivery counts with bucket
    counts (F14).

  Until then this is a stated residual risk.

## 8. Backups and recovery

The owner approved this section's design on 2026-10-27 (decision 3), as
revised in the
[recovery point investigation](2026-10-26-recovery-point-investigation.md)
(PR #91). Built in R1–R5; R6, the real-VM checks, needs F13d authorization.

- **The backup (F13c-4b, R1):** one script, `sim-g-backup.sh [daily|recent]`.
  1. `pg_dump -Fc` runs as `gateway_backup` (uid 9001, peer authentication)
     over the socket, in a `--network none` container.
  2. An encryption container encrypts it with `age` to an **owner-held public
     key**. The private key's designated primary custody is Apple Passwords
     (owner decision 2026-10-27); it is not stored persistently on the VM.
     The owner supplies it briefly for an authorized restore or drill, then
     removes it. Its vault storage format and independent emergency recovery
     procedure must be verified before production use.
  3. The host uploads it with `curl` and a metadata token to a Cloud Storage
     Standard bucket in the same region, never overwriting.
- **Two tiers:**

  | Tier   | Schedule                                                                | Bucket                                                                     |
  | ------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
  | Daily  | 09:15–09:30 UTC, catching up after downtime, and before every migration | `<project>-sim-g-backups`: 35-day retention, deletion at 36 days           |
  | Recent | Every 15 minutes, no catch-up, `TimeoutStartSec=5min`                   | `<project>-sim-g-recent-backups` (R2): 3-day retention, deletion at 4 days |

  Both buckets have uniform access, public access prevention, 7-day soft
  delete (billed) and Terraform deletion protection in production. F13b
  measured about 0.8 MiB per dump at the test volume.

- **Staleness (R3):** a host check 7 minutes after each recent backup is due
  reports `backup_stale` after two consecutive misses, 35–50 minutes after
  the last success. It is quiet for 35 minutes after boot, and never pauses
  for maintenance.
- **Restore validation (R4a):** `sim-g-restore-check.sh` validates every
  candidate in isolation before anything reaches production:
  - the owner chooses the candidate by `timeCreated` and passes that time
    as `--created-at`;
  - the dump's SQL runs only as the migrator, and the validator's own
    superuser sessions are hardened;
  - it checks the table of contents (a pre-filter), the catalogs
    (authoritative), integrity, the ledger and schema against a
    reference, and security-state digests;
  - verdicts: accepted, held for owner review, or quarantined.

  It reduces the risk of a forged backup; it does not eliminate it.

- **Restore drills, never crossing environments, with the same validator:**
  - **Dev:** dev dumps are validated in dev at every schema-changing
    release, and monthly.
  - **Prod:** quarterly, inside the **prod** boundary. The owner supplies the
    key briefly; the throwaway containers are destroyed.
  - Prod data never enters dev.
- **Production restore after a data-disk loss:** the procedure in
  [backup and restore](../runbooks/backup-and-restore.md) (R5). The gateway
  stays stopped until the lost window is reconciled and the owner
  acknowledges it.
- **Objectives:**
  - **RPO:** nominally 15–16 minutes while every recent run succeeds; a
    target, not a guarantee. After k consecutive misses it is about
    15 × (k + 1) + 1 minutes: the age of the last success. The daily tier
    bounds the worst case only while it succeeds.
  - **Exposure:** about 50 minutes, plus alert latency, before
    `backup_stale` reaches the owner.
  - **Not caught by `backup_stale`:** alternating failures (about 31
    minutes indefinitely), reboot loops, and a fault in the VM's own log
    path.
  - **RTO:** about 30–60 minutes to a restored database, plus a few
    minutes of validation. Full service also waits for reconciliation.

  A single VM is **not** highly available.

- **Reconciliation:** Cloud Logging is useful evidence but not complete.
  Missing evidence never authorizes a replay. Before family onboarding, a
  deterministic, automated post-restore reconciliation is a release
  requirement (PLAN Task 14, step 6). It is a separate slice.
- **Optional:** a weekly data-disk snapshot schedule (about USD 0.10–0.25 a
  month) to shorten recovery. Off by default; it does not meet the RPO or
  the key model.

## 9. Patching and maintenance

- **OS (owner decision 2026-10-30, [COS patching decision](2026-10-29-cos-patching-decision-proposal.md)):**
  COS cannot update in place with UEFI Secure Boot on (F13d Stage A), and
  Secure Boot, vTPM and integrity monitoring stay on. Patching is a
  **controlled replacement of the VM** from an exact, reviewed `cos-cloud`
  LTS image (COS 129 LTS first): the data disk is kept, a fresh backup and a
  temporary snapshot come first, the previous image is the rollback, and
  each new image is rehearsed in development before production. Production
  replacements use the Sunday 03:00 the operator-selected time zone window; patches are
  reviewed monthly, and high- or critical-severity fixes are expedited
  (target seven days). The uptime and missing-backup alerts may be snoozed,
  bounded and self-expiring, during supervised maintenance; the
  operational-event alert never is.
  - The weekly reboot timer (`sim-g-reboot.timer`) had nothing to act on
    and was removed after the development rehearsal validated replacement
    (2026-10-30).
  - Milestone upgrades use the same replacement.
- **Images:** CI rebuilds the gateway and PostgreSQL images weekly, so they
  pick up Debian and Alpine security updates, scans them, and promotes them by
  digest.
- **Host maintenance:** Google live migration and automatic restart.
- **Disk:** both the data disk and the boot disk's stateful partition (images
  and logs) are monitored (section 11).

## 10. Deployment, restart and rollback

- **Deploy (F13c-5):**
  1. The deploy workflow writes the target digest to the deploy-pointer
     object.
  2. `sim-g-deploy-watch` polls the pointer and accepts only a well-formed
     `sha256` digest. The repository is always the running image's, so the
     pointer names only a version (F13c-5c,
     [VM host layer](../runbooks/vm-host.md)).
  3. It pulls the digest and runs its migrations after a fresh backup, while
     the current image keeps running. Only then does it switch, restart the
     gateway and check its health, restoring the previous digest if health
     fails. A digest whose migrations or health failed is not retried until
     the pointer changes.
- **Promotion:** CI copies a dev-validated digest into the prod repository,
  then the production GitHub environment gate requires:
  - the reviewers' approval;
  - the automated acceptance evidence;
  - the manual-readiness artifact.

  Only then is the prod pointer written. Promotion never rebuilds.

- **Rollback:** write the previous digest. Migrations are forward-only and
  expand/contract, so the previous image stays compatible. A destructive
  schema change needs an explicit restore plan.
- **Development:** the same Terraform with dev variables in a separate
  project. The dev VM runs only during approved validation windows, with an
  ephemeral IP, and is deleted afterwards. A stopped VM still bills its disk.

## 11. Monitoring and alerts

Alerting is free until at least 1 September 2027. From then, Google charges
USD 0.35 a month **per metric reference** in an alerting policy, so the
design keeps references few:

- **Uptime:** one Cloud Monitoring uptime check on `https://<domain>/healthz`,
  with one alert condition. One metric reference.
- **Operational events:** one log-based metric, `family_brain/ops_event`,
  labelled by event. The labels are:
  - `startup_failed`;
  - audit delivery failed or deferred;
  - `database_idle_client_error`;
  - backup failure: daily and pre-migration lines only. A recent-tier
    `backup_failed` carries `"tier":"recent"` and does not page;
  - `backup_stale`: two consecutive missed recent backups (section 8);
  - deploy rollback;
  - disk usage above 80 %, from a 15-minute host timer covering both disks;
  - certificate renewal failure.

  One threshold condition on it alerts per event. One metric reference.

- **Recipient:** the owner's Workspace account (owner decision 2026-10-27),
  an input (`alert_email`) read from approved configuration. Both conditions
  together cost about USD 0.70 a month once alerting charges begin.
- **Off-VM missing-backup alert (owner decision 2026-10-27: enabled):** an
  alert on the absence of recent `backup_completed` lines for 45 minutes. It catches a
  fault that stops both the backups and the VM's own log line. That costs
  one more metric reference, about USD 0.37 a month with tax from
  September 2027. It pages during planned maintenance and reboots.
- **Budget:** alerts at USD 5 and 8 a month. These are alerts only; Compute
  Engine has no spend cap.

## 12. Invariants preserved

The design preserves Engineering Design section 23:

- PostgreSQL is never publicly reachable. It has no TCP listener at all.
- There are no provider secrets in logs, responses or metadata.
- There are no service-account keys, and grants are per-resource, except the
  one write-only logging role.
- Dev cannot mutate prod: separate projects, identities, secrets, roots and
  federation environments.
- No embedded autonomous LLM.
- The gateway alone authenticates and authorizes every Brain operation.

## 13. Risks

| Risk                                       | Mitigation                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single VM, no HA                           | Documented RPO/RTO, restore drills, automatic restart and live migration.                                                                                           |
| Free e2-micro allowance consumed elsewhere | F13d gate: confirm the billing account before provisioning. Without it the cost exceeds USD 10.                                                                     |
| Flood, single or spread source             | nginx request and connection limits before Node, host connection limits; a spread flood can still crowd out household users (it protects the VM, not availability). |
| Audit loss between stdout and the bucket   | Rotation sizing, the F13d arrival check, later reconciliation (section 7).                                                                                          |
| Root on the host can mint runtime tokens   | Container metadata isolation; job credentials not held by the runtime; deploy rights not root-equivalent.                                                           |
| Weekly reboot outage                       | Short, scheduled, and only when needed.                                                                                                                             |
| ACME or renewal failure                    | Certificates persist on the data disk; renewal-failure alert.                                                                                                       |

## Owner decision record — 2026-10-27 (offline design scope only)

Operator approved the following defaults for implementation planning, without authorizing provisioning, expenditures, production access, credential handling, DNS changes, deployment, or irreversible changes:

- **Region:** `us-central1` (Iowa); the billing account's remaining free-tier eligibility is **unverified** and is a separate F13d gate.
- **Hostname:** `brain.example.invalid`; the authoritative DNS provider and existing records are **not yet confirmed**. No DNS modifications authorized.
- **Quarterly production restore drill:** Operator is the initial operator.
- **Backup decryption-key custody (owner approval, 2026-10-27):** Apple Passwords is the intended primary vault for Operator's `age` X25519 private key, superseding the prior offline-storage assumption. This is an owner-controlled, iCloud-synced vault, **not an independent offline copy**. No key has been generated, stored or handled by this approval. Confirm faithful key storage/retrieval, and design emergency access independently, before real backups or drills. No grant to other agents or systems is implied.
- **Database transport (owner approval, 2026-10-27):** Option A retains `sslmode=verify-full` TLS/TCP support in the general validator, while enforcing `/run/postgresql` Unix socket and no PostgreSQL TCP listener for the present E2 Micro deployment. Review and regression tests on draft PR #79 remain required. No deployment or credential use authorized.
- **Post-restore reconciliation (owner decision 4, Option A, 2026-10-27):** authorize an offline deterministic, fail-closed reconciliation **design and synthetic test plan only**, grounded in the recovery investigation section 9 and PLAN Task 14. The design must address read-only evidence, positive proof, lost-window mutation/approval safety, operator review, and service-resumption gates. No executable implementation or tests, production data, F13d/R6 rehearsal, or deployment is authorized; the implementation slice needs separate approval.
- **Ingress:** nginx with pre-Node request-rate limits. Test the F13b overload case under synthetic load before treating this as production-ready; this is not approval of a particular implementation or security exception.
- **Audit bucket:** 35-day retention, **unlocked**; no permanent retention lock authorized.

Prior owner approvals already recorded in the Example Knowledge System: HTTP 80 for redirects and certificate validation only; mandatory administrative OS Login two-step verification; the minimum project-scoped `roles/logging.logWriter` exception; off-VM missing-backup alert design; weekly snapshots disabled initially; fail-closed quarantine of unrestorable backups; offline production restore-check implementation; Sunday 03:00 the operator-selected time zone maintenance; and Operator's verified Workspace account as alert recipient (do not guess the address).

**Still blocked or open:** Google billing/free-tier verification; authoritative DNS provider confirmation; backup-key vault format, recovery access and operational safeguards; audit retention implementation details (the duration/unlocked policy is approved); owner-approved PR #79 transport direction pending technical/security review and merge; post-restore reconciliation **design/test planning approved, implementation still separately gated**; separate F13d resource/spend/cleanup approval and R6 real-VM rehearsal. Existing repository security/review gates continue to apply. This is an owner-decision record, not implementation approval beyond offline design and reviewable preparation.

## 14. Owner decisions

Status of each decision after the owner's 2026-10-27 approvals (see the
decision record above). Decided means the design choice only: each still
needs reviewed implementation, and none authorizes provisioning, spending,
DNS changes or F13d.

1. **Region: decided** (`us-central1`). Still to verify: that the billing
   account has no other e2-micro using the Free Tier allowance (F13d gate).
2. **Domain: decided** (`brain.example.invalid`), with port 80 only for
   HTTPS redirects and certificate validation. Still open: confirming the
   authoritative DNS provider before any DNS change.
3. **RPO: decided 2026-10-27** (PR #91), with a 35-minute staleness
   threshold. Weekly data-disk snapshots: **decided, off initially**. The
   off-VM missing-backup alert: **decided, enabled** (design and
   configuration; its paid operation starts with F13d).
4. **Key custody: decided** (Apple Passwords as the primary vault; Operator
   runs the quarterly drill). Still open: the vault's storage format,
   independent emergency recovery, and agent-access risk.
5. **Decided:** maintenance on Sundays at 03:00 the operator-selected time zone; Operator's
   Workspace account as the alert recipient (read from approved
   configuration, never guessed); OS Login two-step verification required.
6. **Decided:** the one project-level `logging.logWriter` exception.
7. **Ingress: decided** (nginx with request-rate limits before Node);
   implemented in F13c-3 and checked offline against the F13b overload case.
8. **Audit retention: decided** (35 days, unlocked).
9. **Database transport: decided 2026-10-27 (Option A):** keep verified
   production TCP capability (`sslmode=verify-full`) in the general
   validator, but require socket-only transport on E2 Micro. PR #79 remains
   a draft pending normal code/security review and merge gates; it is not
   deployment approval.

Also decided: an unrestorable backup is quarantined, fail-closed (the R4a
ruling), and the tested production restore-check mode is authorized before
the F13d rehearsal. The inline **[owner]** markers in sections 1–11 predate
these decisions; this section supersedes them.

## 15. F13c slices

1. **F13c-1:** this design (proposed).
2. **F13c-2:** the database transport (PR #79, held for owner review).
3. **F13c-3:** explicit VM proxy and listen settings, ingress limits, and the
   restart, rollback and backup runbooks. Waits for decisions 2, 6 and 7.
4. **F13c-4a:** the remaining database-outage mappings, test-first. Not
   blocked.
5. **F13c-4b:** a compiled migration entry point, and backup and restore
   tooling. Not blocked.
6. **F13c-5:** Terraform (VM, disks, firewall, identities, secrets, federation,
   the deploy-pointer, backup and audit buckets, logging sink and metrics,
   alerts) plus the cloud-init units, validated with `fmt`, `validate` and
   mocked `terraform test` only. Also an amd64 image smoke run. Its IAM,
   contract-test and proxy parts wait for decisions 1, 6, 7 and 8.
