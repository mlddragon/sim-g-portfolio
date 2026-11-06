# SIM-G recovery point investigation: options for a 15-minute RPO

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

**Status:** **Approved by the owner on 2026-10-27** as revised in PR #91 (VM
design section 14, decision 3). The approval covers the recommended design
and authorizes slices R1–R5 (section 11) under the normal quality gates. It
does not cover:

- R6, which needs separate F13d authorization;
- the deterministic post-restore reconciliation slice, which needs its own
  approval;
- the optional off-VM absence alert (section 6), which is still the owner's
  choice.

Until R1–R5 land, nothing here changes production backup behaviour. The
[VM design](2026-10-25-e2-micro-vm-design.md) is updated in R5. No cloud
resource, credential or real data was used; the only experiment was a
bounded, synthetic, local one (section 3).

**Question:** what is the simplest reliable way to get an RPO of about 15
minutes for SIM-G's PostgreSQL operational state? It must keep the one
e2-micro, the PostgreSQL network isolation, the owner-held `age` key and a
cost strictly below USD 10/month, preferably USD 5 or less.

## 1. Recommendation in brief

**Run the existing encrypted logical backup every 15 minutes into a second,
short-retention bucket, and keep today's daily backup unchanged.** Add a
staleness alert: two consecutive missed runs are reported 35–50 minutes after
the last success.

- **RPO:** a **nominal** 15–16 minutes, while every run succeeds. That is a
  target, not a guarantee.
  - **Degraded:** each consecutive missed run adds 15 minutes, and the RPO
    becomes the age of the last successful backup.
  - **Alert:** the recommended threshold is 35 minutes (two consecutive
    misses). It reaches the owner 35–50 minutes after the last success,
    plus log and alert latency.
  - **Exposure the threshold permits:** up to about 50 minutes of
    unprotected changes before anyone is told, plus that latency and the
    owner's response time.
  - **Silent cases:** the alert travels the VM's own log path. A shared
    fault (metadata token, Google API egress, logging agent) can stop
    backups and the alert together, leaving the exposure silent and
    unbounded. An off-VM absence alert is recommended as an owner choice
    (section 6).
  - Each backup is complete and independent, so one corrupted object never
    invalidates the others.
- **RTO:** about 30–60 minutes to a restored database, as today, plus an
  estimated few minutes of isolated validation. Mutations and approval
  resolution stay closed until the lost window is reconciled and the owner
  acknowledges it, so full service also waits for reconciliation. The
  production procedure is not yet written. It is slice R5, needed under any
  option.
- **Restored backups are not authenticated.** A compromised VM can create a
  well-formed fake backup. Selection by server creation time and isolated,
  least-privileged validation reduce this risk but do not remove it
  (section 9).
- **Reconciliation:** after any restore, the lost window must be reconciled.
  Cloud Logging is useful evidence but not complete, and missing evidence
  never justifies replaying a mutation or assuming it did not happen.
  Before family onboarding, a deterministic, automated reconciliation report
  is a release requirement. The manual R5 runbook does not satisfy it
  (section 9).
- **Cost:** USD 0.00/month more with the free tier, about 0.04 without it.
  The expected total stays **USD 4.19–4.94/month** (at most 4.98 if Cloud
  Storage were billed).
- **Code kept:** the dump, encryption and upload script, the image, the job
  isolation and the key model. The change is:
  - one new unit pair;
  - a script argument;
  - a derived bucket name in the host-settings wrapper;
  - one line in the recovery script;
  - a bucket and its create-only grant;
  - a staleness check with one monitoring label;
  - isolated restore-validation tooling, which replaces the drill's
    superuser restore.

  Section 8 has the full list.

WAL archiving (option 2) is the right tool when the RPO must be under about
5 minutes or the database is much larger. Neither is true today. It is an
estimated 3–4 times the new code and adds a WAL chain that any single missing segment
breaks. The other options are rejected (section 4).

## 2. Current baseline (from the repository)

- **Server:** PostgreSQL 17.11 in a `--network none`, read-only, uid-70
  container. It has no TCP listener and socket-only `pg_hba`, and runs on a
  10 GB `pd-standard` data disk.
- **Backup:** `deploy/vm/backup/sim-g-backup.sh`, run daily between 09:15
  and 09:30 UTC (`sim-g-backup.timer`, which catches up after downtime) and
  before every migration:
  1. `pg_dump -Fc` as `gateway_backup` (uid 9001, peer authentication);
  2. `age` encryption to the owner's `age1…` recipient, in a second isolated
     container;
  3. a host upload with a metadata token and `ifGenerationMatch=0`.
- **Bucket:** `${project}-sim-g-backups`, with:
  - a 35-day retention policy;
  - deletion at 36 days;
  - 7-day soft delete;
  - for the runtime, a designed create-only grant (`objectCreator`, VM
    design section 5). No IAM is in Terraform yet; it is part of the
    owner-gated F13c-5d slice.
- **Restore:** `deploy/vm/backup/sim-g-restore-check.sh` decrypts with the
  owner's identity and restores into a throwaway `--network none` container,
  as the superuser with `--no-owner --no-privileges`. That is a drill only.
  There is no production restore procedure yet.
- **Objectives today:** RPO up to 24 hours; RTO about 30–60 minutes.

## 3. Evidence

| Kind           | Meaning                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| **Measured**   | Observed on this local development host (arm64, Colima VM), synthetic data. **Not e2-micro performance.** |
| **Estimated**  | Arithmetic from measurements plus a stated assumption.                                                    |
| **Documented** | From the official PostgreSQL 17 or Google Cloud documentation, read 2026-10-26 (sources in section 14).   |

### F13b capacity run (measured, 2026-10-25)

- `pg_dump -Fc` at the trial size (702 operations, 14,036 audit events, 816
  aliases) took 202 ms and produced 0.81 MiB. `pg_restore` took 226 ms.
- Estimated growth: under 1 MiB of dump per month at household volume.

### WAL experiment (measured, 2026-10-26)

**Set-up:**

- **Image and data:** the repository's PostgreSQL image (17.11) with the real
  migrations, seeded to the F13b trial size. The dump was 0.91 MiB.
- **Isolation:** the server had no network.
- **Archiving:** `archive_command` compressed each segment with `zstd -3`,
  encrypted it with `age` to a synthetic key, and wrote it atomically to a
  local spool.
- **Time was scaled:** `archive_timeout=90s` stood in for 900 s, and
  `checkpoint_timeout=30s` for 300 s. That keeps three checkpoints per
  segment, the same as the real settings.
- **Workload:** each synthetic request opens, runs and completes an
  operation, writes two audit events, delivers them, and updates an alias.
  A heartbeat row committed every 5 s measured the data loss.
- **Loss and restores:** the server was killed (`docker kill`) and its volume
  discarded. Three restores followed:
  - a full base backup plus WAL;
  - a PostgreSQL 17 incremental backup combined with `pg_combinebackup`, to
    a point in time;
  - a full base backup with one segment removed from the archive.

**Results (measured):**

| Item                                                                                 | Result                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every archived segment, forced or full                                               | 16 MiB (16,777,216 bytes), as documented                                                                                                                                                                                                                           |
| A segment closed by `archive_timeout` with light activity (17 requests per interval) | **89–153 KB** after `zstd -3` and `age` (8 segments; gzip -6 gives 156–245 KB)                                                                                                                                                                                     |
| Busy interval (300 requests)                                                         | 448–687 KB, growing as the tables grew                                                                                                                                                                                                                             |
| Near-empty forced switch (after a checkpoint only)                                   | About 1–4 KB                                                                                                                                                                                                                                                       |
| Idle server                                                                          | Two switches after the last activity (one with content, one about 4 KB), then **no further segments** for the rest of the 9-minute idle phase                                                                                                                      |
| Full base backup, trial-size database                                                | 54 MiB on disk; **4.45 MB** as `tar` and `zstd -3`. It took 1.3 s; `pg_verifybackup` took 0.08 s                                                                                                                                                                   |
| PostgreSQL 17 incremental backup after 300 requests                                  | 25 MiB on disk; **0.22 MB** compressed                                                                                                                                                                                                                             |
| `pg_dump -Fc` at the same size                                                       | 0.91 MiB, in 0.19 s with `age`. F13b's slightly different data gave 0.81 MiB                                                                                                                                                                                       |
| **R1:** full base plus all archived WAL, after the kill                              | Opened in 3.0 s (1.2 s of replay for about 20 segments). The last 2 heartbeats (10 s) were lost: everything after the last archived segment. **The loss is bounded by `archive_timeout`, not 0.**                                                                  |
| **R2:** full plus incremental via `pg_combinebackup`, to a point in time             | Opened in 1.8 s at exactly the target (heartbeat 178).                                                                                                                                                                                                             |
| **R2 in the smoke run:** recovery target after the end of the archived WAL           | PostgreSQL **refused to open** ("recovery ended before configured recovery target was reached"). This is safe behaviour.                                                                                                                                           |
| **R3:** one segment removed from the middle of the archive, recovery to latest       | PostgreSQL replayed up to the gap, logged "archive recovery complete" and **opened normally**. It **silently lost** about 15 minutes of wall-clock commits (21:40:52 to the kill at 21:56:17; heartbeat 100 instead of 246), and every later segment was unusable. |

**Caveats:**

- Each `docker exec` request driver ran slower than planned, so intervals
  stretched to 3–6 minutes in places. This does not change per-segment
  sizes, but switch counts per wall-clock minute are not meaningful.
- The run was on arm64 under Colima; e2-micro CPU timing is not measured.
- The harness was ad hoc in a scratch directory and is not committed. Slice
  R4 (section 11) makes the restore test reproducible in the repository.

## 4. Options compared

### Summary

All figures are at today's trial size. Storage counts the retention period, lifecycle
lag and 7 days of soft delete. Monthly costs exclude the free tier, including
6 % tax. With the free tier, every option except snapshots costs USD 0.00;
snapshots have no free tier.

| Criterion                          | 1. Logical every 15 min (**recommended**)                                            | 2. Base backup plus WAL archiving                                                                                                      | 3. PG 17 incremental physical                                                       | 4. pgBackRest                                                                 | 5. Disk snapshots                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Achievable RPO                     | 15–16 min                                                                            | `archive_timeout` plus upload interval: 5–10 min is practical, about 15 at the same cadence                                            | Only with WAL (as option 2); incrementals alone are 15 min only if taken that often | As option 2                                                                   | **60 min** (scheduled hourly minimum); 10 min on demand at best, against Google's advice |
| Verifiable                         | Yes: each object is complete; the newest object's time                               | Only with a continuity check: a gap restores **silently** (measured, R3)                                                               | Chain plus WAL; the same gap risk                                                   | Yes (`check`, `verify`)                                                       | Snapshot list                                                                            |
| RTO change                         | None                                                                                 | Plus about 1–6 min: fetching and decrypting up to a week of segments one by one (estimated)                                            | Plus `pg_combinebackup`; similar                                                    | Similar to 2                                                                  | Possibly faster (create disk from snapshot); no `pg_restore`                             |
| Stored data                        | About 1.0 GiB (3-day tier) plus 39 MiB (daily)                                       | About 0.4–0.6 GiB of WAL at 100–150 KB per active segment, plus weekly 4.5 MB bases (estimated)                                        | Smaller still, plus WAL                                                             | Similar to 2                                                                  | Changed blocks: about 0.5–20 GB (estimated, uncertain)                                   |
| Monthly cost without the free tier | About USD 0.04 (section 7)                                                           | About USD 0.03                                                                                                                         | About USD 0.03                                                                      | About USD 0.03                                                                | About USD 0.03–1.00; no free tier                                                        |
| VM load                            | A 0.2 s dump (local) plus two short containers every 15 min; one staged dump on disk | Continuous compression per segment inside PostgreSQL's container; a weekly base; a spool on the data disk                              | As 2, plus the WAL summarizer                                                       | As 2, plus a daemon and configuration                                         | None on the VM                                                                           |
| PostgreSQL isolation               | Unchanged                                                                            | Unchanged if `archive_command` only writes a local spool and the host uploads                                                          | As 2                                                                                | **Broken** if pushing to Cloud Storage from `archive_command`; otherwise as 2 | Unchanged                                                                                |
| Least privilege                    | Unchanged roles                                                                      | **New:** a `REPLICATION` role and a `local replication` `pg_hba` line for `pg_basebackup`, or superuser use                            | As 2                                                                                | As 2                                                                          | **New:** the VM or a scheduler needs snapshot-create rights                              |
| Owner-held key                     | Unchanged                                                                            | Kept (`age` per segment)                                                                                                               | Kept                                                                                | **Broken:** symmetric passphrase on the VM (`aes-256-cbc`)                    | **Broken:** Google-managed or CMEK keys; the whole disk, including TLS keys              |
| Disk-fill risk                     | None (one staged file)                                                               | Real: a stuck spool or `archive_command` grows `pg_wal` by 16 MiB per switch until PostgreSQL PANICs                                   | As 2                                                                                | As 2, or WAL **dropped** at `archive-push-queue-max`                          | None                                                                                     |
| New code and operations            | Small (section 8)                                                                    | `archive_command` script, spool uploader, base-backup job, continuity checker, PITR restore procedure, PostgreSQL restart and settings | Option 2 plus manifests and chain retention                                         | New package, configuration and repository layout                              | IAM, a schedule or trigger, a different restore path                                     |
| Existing code kept                 | Nearly all                                                                           | Dump path kept as fallback; the rest is new                                                                                            | As 2                                                                                | As 2                                                                          | Daily dump kept; snapshots are additional                                                |
| Verdict                            | **Meets the target simply**                                                          | Viable; escalation path                                                                                                                | No benefit at this size                                                             | Rejected                                                                      | Rejected for RPO; optional RTO aid only                                                  |

### Notes per option

1. **Logical backups more often.** At a 0.81–0.91 MiB dump, a full
   consistent backup every 15 minutes costs less than a WAL chain to build,
   and needs no chain to trust. A 4-hourly schedule would cut cost but miss
   the target, with an RPO of 4 hours. A 15-minute schedule meets it. Its
   costs grow with database size × frequency, hence the revisit triggers
   (section 5).
2. **WAL archiving.** This is the standard way to reach minutes or seconds.
   The isolation-preserving form:
   - `archive_command` runs inside the PostgreSQL container and does
     `zstd | age` to a spool on the data disk, with no network;
   - a host timer uploads the spool with `ifGenerationMatch=0` and deletes
     each file only after a 200;
   - a weekly `pg_basebackup` runs as a new `REPLICATION` role;
   - restores fetch and decrypt segments through `restore_command`.

   It needs:
   - `archive_mode=on`, which requires a restart;
   - a cap on the spool, with an alert on spool age;
   - a continuity check before trusting a restore, because measured gaps
     restore silently;
   - a new base backup after any gap.

   `archive_timeout` bounds only when a segment is closed. Delivery still
   needs the uploader, verification and alerts. Its value appears once the
   RPO must be under about 5 minutes or the database is tens of MiB or
   more.

3. **PostgreSQL 17 incremental backups** shorten replay and reduce base-backup
   size (0.22 MB against 4.45 MB measured). They still need the full WAL
   archive for point-in-time recovery. They also add summaries
   (`summarize_wal`), manifests and a chain that `pg_combinebackup` must
   reassemble. At a 54 MiB cluster, replay already took seconds (measured
   locally). No benefit here.
4. **pgBackRest** is mature, and its `check` and `verify` would cover the
   continuity risk. But:
   - its encryption is a symmetric passphrase that would live on the VM;
   - pushing to Cloud Storage from `archive_command` gives PostgreSQL's
     container network access;
   - its queue limit deliberately drops WAL when exceeded.

   Running it locally and shipping with our uploader keeps most of the
   complexity and loses its remote checks.

5. **Compute Engine snapshots:**
   - scheduled snapshots are at best hourly;
   - Google returns an error for a second snapshot of a disk within 10
     minutes, and recommends at most hourly;
   - they would need new snapshot-create IAM on the VM or a scheduler
     (another service);
   - they use Google-managed or CMEK keys, not the owner's;
   - they capture the whole disk, including Caddy's certificate keys.

   They are crash-consistent images, which PostgreSQL recovers from. They
   remain the optional RTO aid already listed in VM design section 8, and do
   not meet the RPO or the key model.

## 5. Recommended design

**Two tiers, one script:**

| Tier                 | Schedule                                                 | Bucket                                  | Kept                                                            | Purpose                                               |
| -------------------- | -------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| **Daily** (existing) | 09:15–09:30 UTC and before every migration               | `${project}-sim-g-backups` (unchanged)  | 35-day retention policy, deletion at 36 days, 7-day soft delete | Long recovery window; the pre-migration restore point |
| **Recent** (new)     | Every 15 minutes (`OnCalendar=*:00/15`, no random delay) | `${project}-sim-g-recent-backups` (new) | 3-day retention policy, deletion at 4 days, 7-day soft delete   | The 15-minute RPO after a disk or VM loss             |

- **Same mechanism:** the recent tier runs `sim-g-backup.sh recent`. That is
  the same dump as `gateway_backup`, the same `age` recipient, the same two
  isolated job containers and the same no-overwrite upload, only to the
  recent bucket. The daily tier is the script as it is now, with no
  argument.
- **Why a second bucket:** a Cloud Storage retention policy applies to every
  object in the bucket. Keeping 15-minute dumps for 35 days would hold about
  3,400 objects, growing with the database (section 7). A separate bucket
  keeps the daily bucket's policy exactly as approved.
- **Why 3 days:** it covers a weekend before a problem is noticed. Older
  restore points come from the daily tier.
- **Staleness, not only failure:**
  - Each successful recent run records its completion time on the host.
  - The planned 15-minute monitoring timer (VM design section 11) reports
    `backup_stale` when the last success is more than 35 minutes old, that
    is, two consecutive missed runs.
  - Because that check runs every 15 minutes, the alert arrives 35–50
    minutes after the last success, plus log and alert latency.
  - For 35 minutes after boot the check stays quiet, whether the marker is
    absent or merely old from downtime; the uptime alert covers the outage
    itself.
  - It does not pause during operator maintenance, which stops PostgreSQL;
    a forgotten maintenance file must not silence it.
  - It is one more label on the existing `family_brain/ops_event` metric, so
    there is no new alerting metric reference and no new cost.
- **Recent-tier failures do not page one by one.** A recent run's
  `backup_failed` line carries `"tier":"recent"`. The existing "backup
  failure" label in VM design section 11 is defined to match only daily and
  pre-migration failures, so a transient miss (up to 96 a day) is not an
  alert; staleness is. This is a new rule to confirm with the design
  update.
- **Runs blocked before they start.** `Requisite=sim-g-postgres.service`
  fails the job before the script runs when PostgreSQL is down, including
  during maintenance. No JSON line is printed, so only the staleness check
  sees these.
- **No overlap within a tier:** each tier is a `Type=oneshot` unit. A run
  that is still going when its timer fires is not started twice.
  - The recent unit gets `TimeoutStartSec=5min`, so a hung dump (for
    example, waiting on a lock behind a stuck migration) is killed instead of
    blocking every later run.
  - A daily or pre-migration run (one unit) and a recent run may overlap:
    up to four 256 MiB-capped job containers at once. They only read, and they write
    different buckets. Concurrent runs have not been measured; R6 measures
    them.
- **Revisit triggers** (record in STATUS when hit):
  - a compressed dump above about 50 MiB;
  - a recent run taking over 30 s on the VM;
  - a required RPO under 5 minutes.

  Then move to WAL archiving (option 2), whose design is sketched in
  section 4.

## 6. RPO and RTO

**RPO (recommended design):** state committed after the start of the newest
successfully uploaded dump is lost. `pg_dump` takes one consistent snapshot
when it starts.

**Nominal:** every run succeeds. At most 15 minutes, plus the timer's
1-second accuracy, plus the duration of a run in progress at the failure:
about **15–16 minutes**. A run should take a few seconds on the VM
(estimated), against 0.2 s for the dump alone locally. This is the design
objective, not a guarantee.

**Degraded:** after missed runs, the RPO is the age of the last successful
backup of either tier.

| Consecutive missed recent runs                  | RPO if the data disk is lost then                  | Alert (recommended 35-minute threshold)                                        |
| ----------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| 0 (nominal)                                     | ≤ 15–16 min                                        | None                                                                           |
| 1                                               | ≤ about 31 min                                     | None, by design: a single transient miss does not page                         |
| 2                                               | ≤ about 46 min                                     | `backup_stale`, raised by the 15-minute check 35–50 min after the last success |
| k ≥ 2                                           | ≈ 15 × (k + 1) + 1 min                             | Stays raised; the exposure grows by 15 min per interval until it is fixed      |
| Recent tier broken for a long time, daily works | Up to about 24 h (the last daily backup)           | As above; the daily tier bounds the worst case only while it succeeds          |
| Both tiers failing                              | The age of the last success of any tier, unbounded | `backup_stale`, plus the existing daily `backup_failed` alert                  |

- **Recommended threshold:** keep **35 minutes** (two consecutive misses).
- **Exposure it permits:** up to about 50 minutes of committed changes with
  no off-VM copy before the owner is told, plus log and alert latency (a few
  minutes, estimated), plus however long the owner takes to respond. During
  that time every 15 minutes adds to the exposure.
- **When exposure grows:** only while the gateway is still accepting writes,
  that is, when backups fail but PostgreSQL works (token, network, bucket or
  timer faults). When PostgreSQL or the VM is down, nothing new is committed,
  so nothing new is exposed.
- **What the threshold does not catch:**
  - **Alternating failures:** if every other run fails, the RPO holds at
    about 31 minutes indefinitely with no alert.
  - **Reboot loops:** a loop restarts the 35-minute boot grace each time, so
    `backup_stale` never fires; the uptime check is the backstop.
  - **A shared fault in the VM's log path.** `backup_stale` is a log line
    from the VM. A metadata-token failure, broken Google API egress or a
    dead logging agent can stop the uploads and that line together, while
    the external `/healthz` uptime check stays green. The exposure is then
    silent and unbounded, not "about 50 minutes".
- **Recommended, owner choice:** close that gap with one off-VM alert on the
  _absence_ of `backup_completed` for the recent tier (for example, none in
  45 minutes).
  - It is free until September 2027; then about USD 0.37/month with tax for
    one more metric reference (section 7).
  - Unlike `backup_stale`, it has no boot grace and no maintenance
    exemption, so it also pages during planned maintenance, VM stops and
    reboots.
  - The free alternative is a periodic owner check of the recent bucket's
    newest `timeCreated`, which accepts that the silent case is caught
    late.
- **Alternative:** a 20-minute threshold (one miss) tells the owner 20–35
  minutes after the last success, but pages on every transient miss, such as
  host patch reboots or a PostgreSQL restart. Not recommended; it is the
  owner's choice.
- **Not proposed:** making the gateway refuse writes while backups are stale.
  It would bound the exposure at the cost of availability, and it is a
  gateway behaviour change outside this subsystem.
- **Verifiable:**
  - every object's name carries its UTC start time;
  - each run prints `backup_completed` or `backup_failed`;
  - the host records the last success.

  The R4 test and the R6 dev run measure the bound directly.

**RTO:** about **30–60 minutes** to a restored database, as today, plus an
estimated few minutes of validation. Full service also waits for
reconciliation. This covers a complete VM and data-disk loss:

1. Recreate the VM with Terraform; this is owner-run.
2. The new blank data disk is formatted by the existing safe path.
3. Bootstrap PostgreSQL (first-start runbook).
4. The owner chooses a candidate:
   - the newest recent object by its server-side creation time
     (`timeCreated`), never by name;
   - from before any suspected VM compromise (section 9).

   They fetch and decrypt it with the key, inside the prod boundary.

5. **Validate it in isolation first.**
   - Record the decrypted file's hash.
   - Restore it into a throwaway `--network none` PostgreSQL container on
     tmpfs. Use the production database and role names, as the
     least-privileged role.
   - Run the validation checks in section 9. A structurally invalid
     candidate is quarantined and the procedure stops (fail-closed).
6. **Only then restore into production**, the same file by hash.
   - `pg_restore` connects as `gateway_migrator` (peer, uid 9002) with
     `--no-owner --no-privileges`. The restored objects are then owned by
     the schema owner, as `grant-runtime.sql` expects, and the dump's SQL
     never runs as the superuser.
   - Run the grant script afterwards.
   - Repeat the catalog, schema, integrity and security-state checks on the
     production copy, since restore-time SQL could behave differently
     there.
   - **If they fail:**
     - do not start the gateway;
     - discard the restored database: stop PostgreSQL, and re-bootstrap
       from a blank data directory;
     - quarantine the object, as in section 9.

   R4 and R5 must prove that this works. The restore took about 0.2 s at
   the trial size (measured locally); estimated seconds on the VM.

7. Run migrations (expected none).
8. **Keep mutations and approval resolution closed** until the lost window
   is reconciled (section 9) and the owner acknowledges the result.
   - The lost window's operation and idempotency rows are gone. A client
     retrying a lost-window request would be dispatched as new.
   - An approval resolved in the window comes back as pending, and approving
     it again would duplicate the write.
   - Today the only way to keep them closed is to keep the gateway stopped,
     or its ingress closed, until then. A post-restore hold that reopens
     reads first would be gateway behaviour, an open point for the
     reconciliation slice (section 9).
9. Start the gateway.

Steps 1–3 dominate the 30–60 minutes. Validation adds an estimated few
minutes. Full service also waits for reconciliation, which is quick when the
lost window held no mutations, and otherwise depends on the owner. The
owner-held key means recovery waits for the owner, as it does today.

**For comparison, WAL archiving:**

- **RPO:** `archive_timeout` plus the uploader's interval plus the upload
  time. Settings of 300 s and 60 s give about 6–7 minutes when everything
  works. Measured locally: everything after the last archived segment was
  lost (R1).
- **RTO:** base restore plus segment fetches. One-by-one fetches through
  `restore_command` add an estimated 1–6 minutes for a week of segments.
- **Silent gaps:** without the continuity check, a gap makes the RPO
  silently larger (R3).

## 7. Cost

### Additional monthly cost of the recommended design

All figures are estimates in USD. Prices are from section 14.

| Item                  | Basis                                                                                                                                     | No free tier |                                                                                                         Free tier available (assumption) |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -----------: | ---------------------------------------------------------------------------------------------------------------------------------------: |
| Recent-tier storage   | 96 dumps a day × (about 5 days live, since lifecycle runs asynchronously, + 7 days soft-deleted) × 0.91 MiB ≈ 1.0 GiB, at 0.020/GiB-month |         0.02 |                                                                                                                                     0.00 |
| Recent-tier uploads   | 96 × 30.4 ≈ 2,920 Class A operations at 0.005 per 1,000                                                                                   |        0.015 | 0.00 (with the daily tier and the deploy pointer, about 3,000 of 5,000; dev-window uploads count against the same per-account allowance) |
| Lifecycle deletes     | `storage.objects.delete` is a free operation                                                                                              |         0.00 |                                                                                                                                     0.00 |
| Ingress, same-region  | No charge                                                                                                                                 |         0.00 |                                                                                                                                     0.00 |
| Logging               | About 2,900 more one-line JSON entries a month, under 1 MiB                                                                               |         0.00 |                                                                                                                                     0.00 |
| Alerting              | `backup_stale` is a label on the existing metric; no new metric reference                                                                 |         0.00 |                                                                                                                                     0.00 |
| Compute, disk         | Within the existing VM and data disk                                                                                                      |         0.00 |                                                                                                                                     0.00 |
| Tax (6 %, if applied) |                                                                                                                                           |        0.002 |                                                                                                                                     0.00 |
| **Additional total**  |                                                                                                                                           |   **≈ 0.04** |                                                                                                                                 **0.00** |

### Revised complete monthly cost

| Case                                                            | Before    | After (recommended)           |
| --------------------------------------------------------------- | --------- | ----------------------------- |
| Expected (cost model: free e2-micro, PD and Storage)            | 4.19–4.94 | **4.19–4.94**                 |
| Conservative: Cloud Storage billed, everything else as expected | 4.19–4.94 | 4.19–4.98                     |
| From September 2027 (two alert metric references)               | 4.93–5.68 | 4.93–5.68 (5.72 conservative) |
| The e2-micro allowance used elsewhere on the billing account    | 10.7–11.4 | 10.7–11.4 (**breaks USD 10**) |

The optional off-VM absence alert (section 6) costs nothing until
September 2027, then about 0.37 more with tax: 5.30–6.05, or 6.09
conservative. That
is still under USD 10, but further above the preferred USD 5.

**The budget risk is unchanged and is not caused by backups.** If another VM,
or a long-running dev VM, consumes the billing account's one free e2-micro,
the total exceeds USD 10. F13d must confirm the allowance (decision 1).

### Growth

Estimated growth is under 1 MiB of dump per month:

| Dump size                         | Tiered storage (recommended) | Monthly | All 15-min dumps kept 35 days in one bucket | Monthly |
| --------------------------------- | ---------------------------: | ------: | ------------------------------------------: | ------: |
| 0.91 MiB (now)                    |                      1.1 GiB |    0.02 |                                     3.7 GiB |    0.07 |
| 4 MiB (about 4 months, estimated) |                      4.7 GiB |    0.09 |                                      16 GiB |    0.32 |
| 13 MiB (about 1 year, estimated)  |                       15 GiB |    0.30 |                                      52 GiB |    1.05 |
| 25 MiB (about 2 years, estimated) |                       29 GiB |    0.58 |                                     101 GiB |    2.02 |
| 50 MiB (revisit trigger)          |                       58 GiB |    1.17 |                                     202 GiB |    4.03 |

Monthly figures are without the free tier. The 5 GB free storage is used up
at a dump of about 4 MiB, roughly 4 months of estimated growth; the figures
above then apply less 5 GB. The separate 3-day bucket is what keeps the
15-minute tier inside the budget as the database grows. Pruning delivered audit-outbox rows would slow the
growth, but is out of scope here.

### Other options

- **WAL archiving:** about the same today (about 0.03 without the free tier).
- **Snapshots:** an estimated 0.03–1.00, with no free tier.

None changes the total materially. Cost does not decide between the options;
simplicity and failure behaviour do.

## 8. Exact changes

All changes in R1–R6 are in the backup and recovery subsystem. Nothing in
them changes the gateway, the provider adapters, authorization, the schema or
the operational-state logic. The future reconciliation slice (section 9) may
need gateway behaviour, which is recorded there as an open point and not
designed here.

1. **`deploy/vm/backup/sim-g-backup.sh`:**
   - takes an optional tier argument: `daily` (the default, today's behaviour)
     or `recent`;
   - `recent` uploads to `SIM_G_RECENT_BACKUP_BUCKET`, and any other value
     fails as `invalid_backup_tier`;
   - adds `"tier":"recent"` to the recent tier's JSON lines only. Daily lines
     stay byte-for-byte unchanged, so the daily-failure alert can match them
     alone;
   - after a successful `recent` upload, writes the completion time atomically
     to `/var/lib/sim-g/backup-recent.last`.

   The dump, encryption, header check, token handling and no-overwrite upload
   are unchanged.

2. **`deploy/vm/host/bin/sim-g-host-env.sh`:** exports
   `SIM_G_RECENT_BACKUP_BUCKET`, derived as `${project}-sim-g-recent-backups`.
   There is no new `host.env` field.
3. **New units in `deploy/vm/host/systemd/`:**
   - `sim-g-backup-recent.service`: as `sim-g-backup.service`, with
     `Requisite=sim-g-postgres.service`, `TimeoutStartSec=5min` and
     `ExecStart=… sim-g-host-env.sh /etc/sim-g/bin/sim-g-backup.sh recent`;
   - `sim-g-backup-recent.timer`: `OnCalendar=*:00/15`, `AccuracySec=1s`,
     no random delay, `Persistent=false`, since a missed interval is simply
     the next one;
   - `sim-g.target` wants the timer.

   `infra/google/modules/vm-host` already renders every file in that
   directory into `user-data`. `deploy/vm/host/bin/sim-g-recover.sh`, which
   restarts `sim-g-backup.timer` after a failed dependency, starts the
   recent timer too.

4. **`infra/google/modules/vm/storage.tf`:** a new
   `google_storage_bucket.recent_backups`, set up like the backup bucket:
   - same region and class, uniform access, public access prevention
     enforced, and the same labels;
   - `retention_period = "259200"` (3 days), deletion at 4 days, and 7-day
     soft delete;
   - `deletion_policy = local.protection`.

   Plus an output, and assertions in `tests/vm.tftest.hcl`.

5. **IAM, in the owner-gated F13c-5d slice:** `fbg-runtime` gets
   `storage.objectCreator` on the recent bucket. That is the same create-only
   grant VM design section 5 already plans for the daily bucket; neither
   exists in Terraform yet.
6. **Monitoring, with the section 11 slice:**
   - the 15-minute host check reports `backup_stale` when
     `backup-recent.last` is over 35 minutes old, or absent 35 minutes after
     boot;
   - one new label on `family_brain/ops_event`.
7. **Tests:**
   - `pnpm host:check` cases: the tier selects its bucket, an unknown tier
     fails, the timer's cadence, `Requisite`, and the recovery script's
     updated command (`scripts/vm-host-check/cases.sh` asserts it exactly);
   - contract updates in `tests/contract/vm-host-boundaries.test.ts`:
     - the unit list;
     - a `containerUnits` entry for `sim-g-backup-recent.service` whose
       matcher accepts the ` recent` argument. The daily unit's `ExecStart`
       is unchanged.

     The container-invocation count stays 6, because the script is
     counted once;

   - `pnpm backup:check` runs both tiers against the local stand-in.
8. **Documentation:**
   - VM design sections 2 (the unit table), 5 (the grant), 8, 11 (the
     labels) and 14 (decision 3);
   - the [backup and restore](../runbooks/backup-and-restore.md) and
     [VM host](../runbooks/vm-host.md) runbooks;
   - the [cost model](2026-10-25-e2-micro-cost-model.md);
   - both STATUS files.

   Also a new **production restore after a disk or VM loss** procedure in
   the backup runbook. Only the drill exists today, so this gap is there
   whichever option is chosen.

9. **Restore validation (R4), replacing the drill's superuser restore:**
   - `deploy/vm/backup/sim-g-restore-check.sh` restores as `gateway_migrator`
     with production names, in isolation, recording the decrypted file's
     hash;
   - a reference schema, built from the same image by bootstrap, migration
     and grant;
   - the catalog, schema, integrity and security-state checks in section 9;
   - a quarantine record for suspicious objects.

## 9. Security and failure scenarios

### Security implications of the recommended design

- **No new privilege.** It is the same job uid (9001), the same peer-mapped
  role, the same `--network none` containers and the same create-only grant,
  on one more bucket. The VM still cannot read, list, overwrite or delete any
  backup.
- **The key model is intact.** Only the owner's public recipient is on the
  VM. Every recent object is `age` ciphertext that the VM cannot decrypt.
- **More copies, shorter life.** About 380–480 live recent objects of the same
  encrypted operational state. Its content is unchanged and minimized by the
  schema (VM design section 6). Retention is shorter than the daily tier's.
- **Unchanged residual risks:**
  - A compromised VM can upload junk or large objects, as it already can to
    the daily bucket. The budget alerts (USD 5 and 8) are the backstop.
  - A compromised owner account can remove an unlocked retention policy;
    7-day soft delete mitigates it. Locking either backup bucket is
    irreversible and stays an owner decision.
  - Losing the owner key loses every backup (decision 4).
- **A forged backup (existing risk, made likelier).**
  - A compromised VM holds the create grant and the public recipient. It
    can upload a well-formed encrypted dump of its own making.
  - The daily tier has the same exposure today. Routinely restoring "the
    newest" makes it likelier.
- **What `timeCreated` does and does not do.** Choosing by the server's
  creation time defeats name manipulation, such as a forged `2099/…` object
  sorting newest. It does **not** establish provenance:
  - `age` to a public recipient is encryption, not a signature, so anyone
    holding the recipient and the create grant can make a valid object;
  - a signature made on the VM would not help, because a compromised VM
    holds that signing key too;
  - a forgery created during the compromise has a genuine, recent
    `timeCreated`.

  There is no way to authenticate a backup beyond the integrity of the host
  that made it, at the time it made it.

- **Required: isolated, least-privileged restore validation** (R4 and R5),
  before any candidate reaches production:
  1. **Isolation:**
     - restore into a throwaway `--network none` container on tmpfs, never
       the production data directory;
     - use the production database and role names, so restore-time SQL
       cannot tell the copies apart by name;
     - restore as `gateway_migrator`, a non-superuser with no
       `pg_execute_server_program` or server-file roles, so dump SQL cannot
       reach the host;
     - record the decrypted file's hash; only that exact file may be
       restored into production.

     The drill's superuser restore is replaced.

  2. **Table of contents, a cheap pre-filter only:** `pg_restore --list` is
     compared with the list from a reference dump. The reference is built
     from the same image by bootstrap, migration (including the
     `gateway_schema_migrations` ledger) and the grant script.
     - Any function, trigger, rule, policy, extension or unknown schema
       entry rejects the candidate.
     - In a forged archive these entries are only labels; the SQL that runs
       is not shown. Passing this step proves little.
  3. **Catalog inspection after restore, authoritative:**
     - no non-system rows in `pg_proc`, `pg_trigger`, `pg_rewrite`,
       `pg_policy`, `pg_extension` (beyond the built-in `plpgsql`) or
       `pg_event_trigger`;
     - only the expected schemas in `pg_namespace`, and the expected
       ownership;
     - `pg_db_role_setting` empty, which catches `ALTER DATABASE` or
       `ALTER ROLE … SET`.

     The migrations create none of these objects, so a genuine dump passes.

  4. **Schema:**
     - the migration ledger must be a **prefix** of the image's migrations,
       with matching checksums, because older daily and pre-migration
       backups are legitimate;
     - the restored schema must equal a reference migrated to that same
       version, with an empty `pg_dump --schema-only` diff. The migration
       runner (`migrate.ts`) has no target-version option today. Building
       that reference, or using the older image digest, is possible extra
       R4 work;
     - the restore then migrates forward as usual.
  5. **Integrity:**
     - constraints and foreign keys hold;
     - no record-time column is later than the object's `timeCreated` plus
       a clock-skew tolerance: `created_at`, `updated_at`, `activated_at`,
       `attempted_at`, `resolved_at`, `consumed_at`, `delivered_at`,
       `applied_at`;
     - forward-looking columns are excluded, such as `expires_at`,
       `claim_expires_at` and `available_at`;
     - identifiers and counts do not go backwards relative to the previous
       accepted backup **on the same timeline**: only accepted objects with
       an earlier `timeCreated` than the candidate, since the last
       production restore.

     A deliberate restore to an older point is legitimate and must not fail
     this check. Each production restore therefore records a new timeline
     start (the object restored, its hash and `timeCreated`) in the owner's
     restore record. Later backups are compared only within that timeline.

     A forger chooses these values, so this only catches careless
     forgeries.

  6. **Security-relevant state:** `principals`, `identity_bindings`,
     `policy_versions` and `project_registry_versions` are compared with
     the previous accepted backup and the owner's expected configuration.
     - The "previous accepted backup" is the latest object, on the
       candidate's timeline and created before it, that passed validation
       or a drill. It is recorded with its hash and `timeCreated` in the
       owner's restore record.
     - If no such object is recorded, compare with the expected
       configuration only.
- **Fail-closed handling:**
  - A candidate that fails decryption is junk, not a forgery. The procedure
    may fall back to the previous object automatically.
  - A candidate that decrypts but fails a structural check (steps 2–5) is
    **suspicious**. It is quarantined: recorded and never used. The
    procedure stops, and every object created at or after its
    `timeCreated` is treated as suspect too.
  - A security-state difference (step 6) is **held for owner review**, not
    quarantined automatically, because legitimate changes also differ: a
    new policy activation, or a binding added at onboarding. The owner
    accepts it as expected or declares the object suspicious.
  - The owner then chooses an earlier object, ideally from before the
    earliest suspected compromise. If that time is unknown, a daily object
    from before the incident window is preferred.
- **Residual risk, stated plainly:** validation detects crude and careless
  forgeries. It cannot detect a careful one by an attacker who knows the
  schema, for example plausible but false operation rows. It also cannot
  detect a forgery inside the compromise window that touches no
  security-relevant table. These checks reduce malicious-backup risk; they
  **do not eliminate it**. After any suspected compromise, choose the
  restore point by the incident timeline, not by recency.

### Failure scenarios

| Scenario                                                                                | Effect                                                                                                                                                                      | Detection                                                                                                                                                        | Handling                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One run fails (token, network or 5xx) or is blocked (PostgreSQL down or in maintenance) | That point is missing; the RPO grows by 15 minutes until the next success                                                                                                   | A failed run prints `backup_failed` (`"tier":"recent"`, no page). A blocked run prints nothing (`Requisite`). `backup_stale` follows after two misses.           | The next run retries. The staged file is always removed, so nothing accumulates on disk.                                                                                                                                                      |
| Runs keep failing                                                                       | The RPO grows without bound                                                                                                                                                 | `backup_stale` alert 35–50 minutes after the last success, unless the fault also breaks the VM's log path (then silent; see the off-VM absence alert, section 6) | The owner investigates. The daily tier and older recent objects are untouched.                                                                                                                                                                |
| A run hangs (a lock wait, a stuck container)                                            | Later runs queue behind it                                                                                                                                                  | `TimeoutStartSec=5min` kills it and prints nothing; staleness if it repeats                                                                                      | Next run.                                                                                                                                                                                                                                     |
| Upload interrupted part-way                                                             | No object: a single-request media upload creates the object only when complete                                                                                              | `backup_failed`                                                                                                                                                  | Next run.                                                                                                                                                                                                                                     |
| Object corrupted or truncated at rest                                                   | `age` authenticates every chunk, so decryption fails                                                                                                                        | The restore step fails loudly                                                                                                                                    | Use the previous object, 15 minutes older. No other object depends on it.                                                                                                                                                                     |
| A dump that decrypts but does not restore (tool fault)                                  | That point is unusable                                                                                                                                                      | Restore drills (dev monthly, prod quarterly) and the restore step                                                                                                | Use the previous object.                                                                                                                                                                                                                      |
| A dump that decrypts but fails a structural check (suspicious)                          | Possible forgery                                                                                                                                                            | Isolated validation (above)                                                                                                                                      | Quarantine it and stop. Treat every later object as suspect. The owner chooses an earlier point by the incident timeline. A security-state difference is held for owner review instead.                                                       |
| VM lost, data disk intact                                                               | Nothing lost                                                                                                                                                                | Uptime alert                                                                                                                                                     | Recreate the VM and reattach the disk; no restore.                                                                                                                                                                                            |
| Data disk lost (or VM and disk)                                                         | Nominally up to 15–16 minutes of state lost; after missed runs, the age of the last success (section 6)                                                                     | Uptime alert                                                                                                                                                     | The production restore procedure (section 11, R5), using the newest recent object.                                                                                                                                                            |
| Logical damage noticed late (a bug writes bad state)                                    | Depends on when it is noticed                                                                                                                                               | Operator                                                                                                                                                         | 15-minute points for 3 days, then daily points for 35 days.                                                                                                                                                                                   |
| Zone outage                                                                             | The zonal disk is unavailable; the regional bucket survives                                                                                                                 | Uptime alert                                                                                                                                                     | Restore in another zone of the region. A regional outage is out of scope, as today.                                                                                                                                                           |
| The VM is compromised                                                                   | The attacker can read live state, as today, and can **add** forged backups                                                                                                  | —                                                                                                                                                                | Cannot delete or rewrite backups (create-only grant plus retention policies), and cannot decrypt past ones. Restore from before the compromise, with isolated validation. A careful forgery inside the window may still pass (residual risk). |
| **After any restore:** state written after the restored backup is gone                  | Provider writes made after the backup exist in Notion or Drive with no operation row; idempotency keys are lost; audit rows delivered after the backup become pending again | Partial evidence only: Cloud Logging audit events and provider markers. Neither is complete (below).                                                             | Reconcile as below. Nothing is re-dispatched, and missing evidence proves nothing. Redelivered audit events carry the same `event_id`. This applies to every option with a non-zero RPO, WAL archiving included.                              |

### Reconciliation after a restore

**Cloud Logging is useful evidence, not a complete record of the lost
window:**

- Audit events are queued in PostgreSQL's outbox and delivered
  asynchronously. Events still queued at the loss are lost with the
  database.
- Delivery can be deferred for as long as the sink is unavailable. In F13b,
  a 60-second sink outage left 325 events pending.
- The logging agent and ingestion can delay or drop entries, and retention
  can expire.
- A provider write can succeed and the process die before its completion
  event is queued.

**Rules, consistent with the existing reconcile-only recovery**
([stranded execution recovery](../runbooks/stranded-execution-recovery.md)):

- The absence of an audit event, or of a provider marker, never proves that
  an operation did not happen.
- **Missing evidence never authorizes replaying a mutation.** Nothing is
  re-dispatched automatically.
- An operation is settled only on positive evidence. Anything else stays
  unresolved for the operator.
- After a restore the idempotency rows for the lost window are gone, so a
  client retrying a lost-window request ID looks new. Such request IDs must
  be listed, and must not be executed again without an explicit operator
  decision.
- An approval resolved in the lost window comes back as pending. It must not
  be resolved again until reconciled.
- Until reconciliation is acknowledged, mutations and approval resolution
  stay closed (section 6, step 8).

**Release requirement before family onboarding.** Before Steward or Participant is
onboarded to production (PLAN Task 14, step 6), SIM-G must have a
deterministic post-restore reconciliation. A manual runbook (R5) is
acceptable only while Operator is the sole production user. It does **not**
satisfy this requirement. The requirement, stated narrowly:

1. **Trigger:** every production restore from backup.
2. **Automated, read-only evidence collection** for the window from the
   restored backup's snapshot (less a margin) until after service resumes,
   to catch delayed provider writes. Reading Cloud Logging needs a log-read
   identity, which must be the operator's and never the VM runtime's (the
   runtime only writes logs). The evidence covers:
   - restored operations in non-terminal states;
   - Cloud Logging audit events by operation and request ID;
   - provider markers through the existing read-only reconciliation
     lookups.
3. **Deterministic classification:** the same inputs always give the same
   result. An outcome is settled only on positive proof; everything else is
   unresolved, never inferred from absence.
4. **An operator report** of every unresolved outcome:
   - the operation and request IDs, principal, operation type and target;
   - the evidence found, and the evidence missing.

   The restore is not declared complete until the owner acknowledges it.

5. **No automatic re-execution:** of any mutation, or of any lost-window
   request ID, without an explicit operator decision.
6. **Proven** by a synthetic loss-and-restore test before onboarding.

This document records the requirement only. Its design and implementation
are a separate future slice, sized on its own and reusing the F11h recovery
path. It is not part of R1–R6.

**Open point for that slice, not designed here:** blocking lost-window
request IDs, and a post-restore hold that reopens reads before mutations,
probably need gateway behaviour. Until then, the gateway stays stopped
until reconciliation is acknowledged.

With the gateway stopped, the F11h `recoverStrandedExecution` path is not
reachable: it runs in-process and has no route. The interim R5 procedure
must therefore say how restored `EXECUTING` and approval-claimed rows are
handled. They stay unresolved, and are checked by hand through provider
inspection; the owner records the result. They are never finalized by
assumption.

## 10. What stays unchanged

- The PostgreSQL image, its socket-only `pg_hba` and `pg_ident`, and the
  three roles. `gateway_backup` keeps only `pg_read_all_data`; no role gains
  `REPLICATION`.
- PostgreSQL's configuration. There is no `archive_mode` or
  `summarize_wal`, and no restart.
- The backup's dump, `age` encryption, header check, token-on-stdin upload
  and `ifGenerationMatch=0`.
- The daily timer, the pre-migration backup, the 35-day bucket and its
  policies.
- The synthetic backup round trip. Every recent object is a full logical
  backup, restored and validated exactly like a daily one. The restore drill
  itself changes (section 8, item 9).
- The owner-held key model and the quarterly prod drill.
- The deploy watcher, migrations, metadata isolation, the firewall and the
  data-disk safeguards. The recovery script gains one unit name and nothing
  else.
- The machine type, the disks and every other cost item.

## 11. Implementation and verification plan (if approved)

Each slice uses the normal workflow:

- test-first, with the failing check observed;
- `pnpm verify`, acceptance, integration, `pnpm audit --prod`,
  `git diff --check`, and the infrastructure, host, image and backup checks;
- a separate-context review;
- its own PR, with exact-head CI and merge.

R1–R5 need no cloud resource and are repository work. R6 runs on the dev VM
and needs the separate F13d authorization.

| Slice  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Done when                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | Tier argument in `sim-g-backup.sh`; derived recent bucket in `sim-g-host-env.sh`; `sim-g-backup-recent.service` and `.timer`; the recovery script; host cases; contract updates; `backup:check` for both tiers                                                                                                                                                                                                                                                               | A recent run writes only to the recent bucket stand-in, records its completion, and fails closed on an unknown tier. The daily output is byte-for-byte unchanged.                                                                                                                                                                                                                              |
| **R2** | The recent bucket in `infra/google/modules/vm`, with `terraform test` assertions                                                                                                                                                                                                                                                                                                                                                                                             | Mocked plans show the 3-day policy, deletion at 4 days, soft delete, public access prevention and prod `PREVENT`. The daily bucket's plan is unchanged.                                                                                                                                                                                                                                        |
| **R3** | The host-side staleness check (`backup_stale`), offline only; wired to alerting with the section 11 slice                                                                                                                                                                                                                                                                                                                                                                    | Host cases: fresh, one miss (quiet), two misses (stale), missing or old marker within the boot grace (quiet), and after it (stale), including during maintenance.                                                                                                                                                                                                                              |
| **R4** | The synthetic 15-minute recovery test (section 12) as `pnpm backup:rpo-check`, in CI's Container image job, including the isolated restore validation (section 9)                                                                                                                                                                                                                                                                                                            | The test passes. It fails when the measured loss exceeds the bound or the newest object is corrupted without fallback. Section 12's planted test objects are rejected, quarantined or held as specified (the far-future-name one is simply not chosen); a careful forgery is not claimed to be detected. Restores choose by creation time and run as `gateway_migrator` with production names. |
| **R5** | Documentation: the production restore procedure, plus updates to the VM design, cost model, runbooks and STATUS. The procedure covers the restore role and ownership, choosing by creation time, the timeline record, isolated validation and quarantine, the production re-check and its failure path, the grant script, keeping the gateway stopped until reconciliation is acknowledged, and the manual reconciliation of restored `EXECUTING` and approval-claimed rows. | The procedure is reviewed against the first-start runbook and the restore drill. It states that it is interim, for Operator-only production use; the automated reconciliation (section 9) is required before family onboarding.                                                                                                                                                                |
| **R6** | F13d, separately authorized: on the dev VM, run the real timer for at least 2 hours                                                                                                                                                                                                                                                                                                                                                                                          | One object every 15 minutes, a stopped PostgreSQL raises `backup_stale`, and the newest object restores in dev. CPU, memory and run time are measured on a real e2-micro, including overlapping daily and recent runs, the lock wait between a dump and migration DDL, and that a `TimeoutStartSec` stop leaves no job container running.                                                      |

Estimated size:

- **R1–R3:** about one F13c sub-slice, a few hundred lines including tests.
- **R4:** with the catalog, schema, integrity and security-state validation,
  an estimated several hundred to about a thousand lines including tests. It
  may be split into a recovery test and a validation slice.

**Not in R1–R6:** the deterministic post-restore reconciliation (section 9).
It is a release requirement before family onboarding, to be designed and
approved as its own slice.

## 12. Synthetic restore test: recovery within about 15 minutes

**Goal:** prove that after a complete loss of the database, recovery returns
every change committed more than one backup interval, plus a small run
allowance, before the failure. It must use only the production tooling and
fictional data.

The test is `pnpm backup:rpo-check` (slice R4). It runs on local containers
in scaled time, with a 90-second interval standing in for 15 minutes. The
dev-VM run (R6) repeats it in real time.

1. **Set up** with the existing round-trip harness:
   - start the socket-only server and bootstrap the roles;
   - apply the migrations as `gateway_migrator`;
   - seed fictional data at the F13b trial size;
   - generate a synthetic `age` identity for the run.
2. **Generate load and a probe:**
   - household-like requests (operation, audit events, delivery, alias);
   - a heartbeat row committed every 5 s, with its commit time.
3. **Back up on the schedule** by running the real `sim-g-backup.sh recent`
   every interval against the local Cloud Storage stand-in. For each object,
   record its name, its start time and the heartbeat value it should
   contain.
4. **Fail at a random moment.** Pick a time T_fail between 3 and 4 intervals
   in. `docker kill` the server, delete its data volume, and stop the load.
   Record the last committed heartbeat H_last at T_fail.
5. **Recover as the production procedure will:**
   - create a new data volume and bootstrap again (initdb and roles);
   - choose the newest object in the stand-in by creation time, not name;
   - decrypt it with the owner identity, mounted read-only for that step
     only;
   - `pg_restore` it as `gateway_migrator` with `--no-owner --no-privileges`,
     then run the grant script;
   - run the migration command, which must report nothing to apply;
   - start the gateway image against it, which must become healthy.

   Before the restore, validate the candidate in an isolated container, as
   section 9 requires, and re-check the restored copy before the gateway
   starts. The test does **not** model reconciliation or the owner's
   acknowledgement: it starts the gateway at once to prove the restored
   database works. In production the gateway stays stopped until
   reconciliation (section 6, step 8).

6. **Assert the bound:**
   - the restored heartbeat's commit time is at least
     T_fail − (interval + 10 % + run time);
   - the restored heartbeat lies between the last heartbeats recorded at
     that run's start and at its completion, since the dump's snapshot falls
     between them; the row counts lie in the same window;
   - the data lost is the heartbeats after the object's start, reported as
     seconds and rows;
   - nothing is restored that was committed after that object's start.
7. **Negative cases:**
   - skip one backup: the bound is two intervals, and `backup_stale` is
     **not** reported;
   - skip two: the staleness check (R3) reports `backup_stale`. The
     threshold is scaled with the interval (about 210 s against 90 s);
   - a planted object with a far-future name: it is not chosen;
   - a planted, validly encrypted object that creates a function or
     trigger, including inside an entry labelled as a table: the catalog
     inspection quarantines it, and the procedure stops without falling back
     automatically;
   - a planted object whose SQL sets a database or role setting: caught by
     `pg_db_role_setting`;
   - a genuine pre-migration backup with an older migration ledger: it
     passes as a prefix;
   - a planted object that adds an identity binding: held for owner review;
   - no negative case claims to detect a careful forgery (residual risk,
     section 9);
   - flip one byte in the newest object: decryption fails, the procedure
     falls back to the previous object, and the reported loss reflects it;
   - remove every object: recovery stops with an explicit error and never
     starts an empty database as if it were restored.

On the dev VM (R6), the same steps run with the real timer:

- 15-minute intervals for at least 2 hours, with real Cloud Storage;
- a stopped PostgreSQL for the staleness alert;
- the restore inside the dev boundary.

**Pass:** data lost is at most about 16 minutes, the restored database is
healthy, and the alert fires.

## 13. Answers to the owner's questions

- **A 15-minute RPO without another VM, managed database or paid service?**
  Yes, as a nominal objective while runs succeed; degraded behaviour is in
  section 6. The recommended design uses the existing VM, Cloud Storage and timers.
- **The minimum new infrastructure?** One Cloud Storage bucket, plus a
  create-only grant on it, designed into the not-yet-built F13c-5d IAM.
- **Can the existing logical backups stay as an independent fallback?** Yes,
  under every option. Under the recommendation, the daily tier is unchanged
  and each recent object is itself a full logical backup.
- **Archiving WAL without giving PostgreSQL network access?** Only option 2
  needs this. `archive_command` writes `zstd | age` output to a local spool
  inside the `--network none` container, and a host unit uploads it.
  pgBackRest's direct push would break the isolation.
- **Keeping the owner-held key model for incremental data?** `age` to the
  same public recipient, per dump or per WAL segment. Nothing on the VM can
  decrypt it. pgBackRest's passphrase and snapshot keys would not fit the
  model.
- **Stopping failed WAL uploads from filling the disk?** For option 2:
  - a spool cap at which `archive_command` refuses;
  - an alert on spool age and on `pg_stat_archiver.failed_count`;
  - the existing 80 % disk alert.

  WAL then accumulates in `pg_wal` at 16 MiB per switch (up to about
  1.5 GiB a day at 96 switches), so the alert must come well before the
  10 GB disk fills and PostgreSQL PANICs. The recommended design has no such
  risk: it stages one dump and always removes it.

- **Does a 15-minute `archive_timeout` guarantee the objective?** No. It only
  closes a segment when there has been activity. Delivery depends on the
  uploader and Cloud Storage. Verification needs:
  - the newest archived segment's age;
  - a continuity check;
  - restore tests.
- **How large is WAL under our workload?**
  - Every segment is 16 MiB uncompressed. Compressed, a lightly active
    15-minute segment was 89–153 KB, a busy one up to 687 KB.
  - An idle server stops switching after two segments.
  - Estimate: up to 96 active segments a day, so 9–14 MiB a day.
- **Accumulation over 35 days:**
  - **WAL, compressed** (estimated): about 0.4–0.6 GiB, including soft
    delete and weekly bases.
  - **WAL, uncompressed:** about 63 GiB, about 1.26 USD a month.
  - **Recommended logical tiers:** about 1.1 GiB compressed. The dump
    format is already compressed (F13b), so "uncompressed" does not apply.
- **A missing, corrupted, delayed or partial WAL segment?**
  - **Missing:** recovery to latest stops at the gap and opens without an
    error. This was measured: about 15 minutes of wall-clock commits and
    every later segment lost.
  - **Recovery target beyond the available WAL:** PostgreSQL refuses to
    open (measured).
  - **Corrupted:** PostgreSQL halts on corrupt WAL that reaches it
    (documented). With `age` per segment, a corrupted object fails
    decryption first, so `restore_command` exits non-zero. PostgreSQL then
    treats the segment as missing and opens silently at that point, as
    above. This strengthens the case for the recommendation.
  - **Delayed:** the RPO widens.
  - **Partial:** cannot happen for single-request uploads, and `age` rejects
    truncation.

  For logical backups, each of these affects one object, and the previous
  one is used.

- **Restore after complete VM and data-disk loss?** Section 6. The
  procedure itself is slice R5.
- **Does the new process materially increase the 30–60-minute RTO?** Not
  to a restored database: validation adds an estimated few minutes. Full
  service also waits for reconciliation, which is owner-dependent when the
  lost window held mutations. For WAL archiving, an estimated 1–6 minutes more.

## 14. Sources

Read 2026-10-26 unless noted:

- **PostgreSQL 17:**
  - [Write-ahead log settings](https://www.postgresql.org/docs/17/runtime-config-wal.html):
    `archive_timeout` ("still the same length as completely full files"),
    `archive_command`, `summarize_wal` and `wal_summary_keep_time`;
  - [Continuous archiving and PITR](https://www.postgresql.org/docs/17/continuous-archiving.html):
    command exit status, a failing archive filling `pg_wal` and the PANIC,
    incremental backups needing WAL, missing and corrupted WAL during
    recovery;
  - [`pg_basebackup`](https://www.postgresql.org/docs/17/app-pgbasebackup.html):
    `REPLICATION` and a replication `pg_hba` entry are required, plus
    `--incremental` and the manifests.
- **pgBackRest:** [configuration reference](https://pgbackrest.org/configuration.html):
  - `repo-cipher-type` is `none` or `aes-256-cbc` with a passphrase;
  - `repo-gcs-key-type=auto` uses the instance service account;
  - `archive-push-queue-max` drops WAL when exceeded.
- **Compute Engine snapshots:**
  - [About snapshot schedules](https://docs.cloud.google.com/compute/docs/disks/about-snapshot-schedules):
    hourly, daily or weekly, with hourly intervals of 1–23 hours, and no
    CSEK disks;
  - [Troubleshooting snapshots](https://docs.cloud.google.com/compute/docs/troubleshooting/troubleshooting-snapshots):
    more than one snapshot of a disk in 10 minutes, or more than six bursts
    in 60 minutes, returns `RESOURCE_OPERATION_RATE_EXCEEDED`, and at most
    hourly is recommended;
  - [Disk and image pricing](https://cloud.google.com/compute/disks-image-pricing),
    read 2026-10-25: standard snapshots at USD 0.05/GB-month.
- **Cloud Storage:** [pricing](https://cloud.google.com/storage/pricing):
  - Standard regional storage at USD 0.000027397/GiB-hour (about
    0.020/GiB-month);
  - Class A at USD 0.005 and Class B at USD 0.0004 per 1,000 operations;
  - `storage.objects.delete` is a free operation;
  - soft-deleted data is billed like live data;
  - Always Free: 5 GB-months, 5,000 Class A and 50,000 Class B operations
    across us-west1, us-central1 and us-east1.
- **SIM-G:**
  - [cost model](2026-10-25-e2-micro-cost-model.md);
  - [capacity report](2026-10-25-e2-micro-capacity-report.md);
  - [VM design](2026-10-25-e2-micro-vm-design.md);
  - [backup and restore runbook](../runbooks/backup-and-restore.md).
