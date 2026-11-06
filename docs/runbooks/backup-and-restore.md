# Backup and restore (e2-micro VM)

Tooling for the proposed VM design, sections 6 and 8
(`docs/engineering/2026-10-25-e2-micro-vm-design.md`). Nothing here has run
against a real VM, bucket or household data. It is proven only by the
synthetic round trip below.

## Pieces

| Path                                      | Role                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deploy/vm/postgres/Dockerfile`           | The VM's PostgreSQL image: the pinned upstream image plus `age` (a pinned Alpine package) and the job users `sim_g_backup` (uid 9001) and `sim_g_migrator` (uid 9002). It is built, scanned (`pnpm image:check`) and promoted by digest.                     |
| `deploy/vm/postgres/pg_hba.conf`          | Socket only. `postgres`, `gateway_migrator` and `gateway_backup` authenticate by `peer`; `gateway_runtime` by `scram-sha-256`. There are no `host` lines.                                                                                                    |
| `deploy/vm/postgres/pg_ident.conf`        | Maps only uids 9001 and 9002 to the backup and migration roles. The gateway (uid 1000) maps to none.                                                                                                                                                         |
| `deploy/vm/postgres/grant-runtime.sql`    | Run by the migration job as `gateway_migrator` after every migration run. It grants the runtime only `SELECT, INSERT, UPDATE` on tables and `USAGE` on sequences: no `DELETE`, `TRUNCATE` or sequence changes, and nothing on the migration ledger.          |
| `deploy/vm/postgres/bootstrap-roles.sql`  | Creates the three least-privilege roles and the database, and gives the runtime DML on whatever the migrator creates. It contains no password. Run it once as the bootstrap superuser; set the runtime password afterwards with `\password gateway_runtime`. |
| `deploy/vm/backup/sim-g-backup.sh`        | The backup, run by two host timers: the daily tier and the 15-minute recent tier.                                                                                                                                                                            |
| `deploy/vm/backup/sim-g-restore-check.sh` | Isolated restore validation, the drill, and the production re-check (`--production-check`).                                                                                                                                                                  |

## Image defaults and operator rules

- **Safe without run-time flags.** The image's `POSTGRES_INITDB_ARGS`
  (`--auth-local=peer --auth-host=reject`) mean `initdb` never writes a trust
  rule. Its `CMD` sets `listen_addresses=` and the shipped `pg_hba` and
  `pg_ident`.
- **Default user.** It is `65534` (no role), so a container started without
  `--user` cannot peer as the superuser. Start the server with
  `--user 70:70`; jobs use `9001` (backup) or `9002` (migrations). `gosu` is
  removed.
- **The superuser password is discarded.** The entrypoint needs a password
  only for `initdb`. Supply it once through `POSTGRES_PASSWORD_FILE`, never
  through `user-data`, then delete the file; the bootstrap sets
  `ALTER ROLE postgres PASSWORD NULL`.
- **Socket directory.** On the VM, the host socket directory must be `0755`
  and owned by uid 70. Otherwise another process could plant a fake socket
  while PostgreSQL is down. The synthetic check uses the image's default
  directory.
- **Owner key type.** Only native `age1…` X25519 recipients are accepted.
  Post-quantum and plugin (for example YubiKey) recipients fail closed; choose
  the key type when deciding key custody.

## Backups: daily and recent tiers

`sim-g-backup.sh [daily|recent]` runs the same steps for both tiers, as the
owner approved on 2026-10-27
([recovery point investigation](../engineering/2026-10-26-recovery-point-investigation.md),
section 5):

| Tier                  | Started by                                                        | Bucket                                                     |
| --------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `daily` (no argument) | `sim-g-backup.timer`, 09:15–09:30 UTC, and before every migration | `SIM_G_BACKUP_BUCKET`, 35-day retention                    |
| `recent`              | `sim-g-backup-recent.timer`, every 15 minutes                     | `SIM_G_RECENT_BACKUP_BUCKET`, a separate 3-day bucket (R2) |

Any other argument, or more than one, fails as `invalid_backup_tier` before
anything runs. A recent bucket that is missing, or equal to the daily
bucket, fails as `invalid_backup_bucket`, so 15-minute dumps never land in
the 35-day bucket.

`sim-g-backup.sh` needs:

- `SIM_G_BACKUP_BUCKET`;
- `SIM_G_RECENT_BACKUP_BUCKET`, for the recent tier only. On the VM the
  settings wrapper derives it from the project;
- `SIM_G_BACKUP_RECIPIENT` (the owner's `age1…` public key);
- `SIM_G_POSTGRES_IMAGE`, pinned by digest.

Optional variables: `SIM_G_SOCKET_DIR`, `SIM_G_BACKUP_STAGING`,
`SIM_G_DATABASE` and `SIM_G_BACKUP_MARKER` (the recent tier's completion
marker, default `/var/lib/sim-g/backup-recent.last`), plus the endpoint
overrides used by the synthetic check.

It runs these steps:

1. `pg_dump -Fc` as `gateway_backup` (uid 9001, peer authentication) over the
   socket, in a read-only container with no network and no capabilities.
2. `age --encrypt` to the recipient, in an equally isolated container. The
   private key never exists on the VM.
3. A host upload to `family-brain-gateway/YYYY/MM/DD/<UTC>.dump.age`, with a
   metadata-server token and `ifGenerationMatch=0`, so an existing object is
   never overwritten. The runtime identity can only create objects in that
   bucket.
4. Removal of the local staged ciphertext (a unique `mktemp` file),
   whatever the outcome.

- **No container logs.** Both job containers run with `--log-driver none`.
  Docker records a container's stdout even when it is piped, and these
  streams are the plaintext dump and its ciphertext. Without the flag they
  would land on the boot disk and, through the logging agent, in Cloud
  Logging. A contract test pins this for the backup and the validator.
- **The production server's log never carries row values.** PostgreSQL
  keeps its `json-file` log, which the logging agent ships, but runs with
  `log_error_verbosity=terse` and `log_min_error_statement=panic`. So no
  `DETAIL` or `CONTEXT` line (a failed COPY's whole row, a duplicate key's
  value) and no failing statement with its literals is logged.
- **Before upload**, the staged file must begin with the `age` header.
- **The token** reaches `curl` on standard input, never in process arguments.
- **Endpoint overrides** (for the synthetic check) are accepted only on
  loopback.
- **Diagnostics:** standard error from the dump and encryption containers is
  discarded, so the reason tells which step failed but not why; reproduce by
  hand.

It prints one JSON line: `backup_completed` with the object name and size, or
`backup_failed` with a fixed reason, for example `backup_dump_failed`,
`backup_token_unavailable` or `backup_upload_http_412`. It never prints the
token, the recipient or a cause.

- **Daily lines are unchanged.** Only recent-tier lines add
  `"tier":"recent"`, so the planned backup-failure alert (VM design
  section 11) can match daily and pre-migration lines alone. A single recent miss does not page;
  the staleness check (R3) does.
- **The recent completion marker.** After a successful recent upload, and
  only then, the script atomically writes the completion time (Unix
  seconds, root-only) to the marker.
  - It replaces only a regular file, never a directory or a symlink.
  - If it cannot write the marker, it fails as `backup_marker_failed`, even
    though the object was uploaded, so the host never believes a backup
    succeeded that it cannot record.
- **Staleness (R3).** `sim-g-backup-stale.timer` runs
  `sim-g-backup-stale.sh` 7 minutes after each recent backup is due.
  - **Stale:** it prints
    `{"severity":"ERROR","msg":"backup_stale","reason":…}` when the marker
    is over 35 minutes old (`backup_too_old`, with `age_seconds`), missing
    (`marker_missing`), or malformed, symlinked or in the future
    (`marker_invalid`), or not a regular file. Two consecutive misses are
    reported 35–50 minutes after the last success (about 37 when runs take
    seconds).
  - **Boot grace:** it stays quiet for 35 minutes after boot.
  - **Maintenance:** it never pauses.
  - **Not caught:** alternating failures, reboot loops, and a fault in the
    VM's own log path. The optional off-VM absence alert covers the last
    ([recovery point investigation](../engineering/2026-10-26-recovery-point-investigation.md),
    section 6).
  - **Alerting** on the line arrives with the VM design's section 11 slice.

## Restore validation and drill

Every candidate is validated in isolation before anything is restored into
production
([recovery point investigation](../engineering/2026-10-26-recovery-point-investigation.md),
section 9). The same command is the restore drill.

```sh
SIM_G_POSTGRES_IMAGE=<postgres image@sha256:...> \
SIM_G_GATEWAY_IMAGE=<gateway image@sha256:...> \
  deploy/vm/backup/sim-g-restore-check.sh <dump.age> <owner age identity file> \
  --created-at <the object's timeCreated, Unix seconds> \
  [--previous <the previous accepted summary on this timeline>]
```

- **Choose by creation time:** take the object's server-side `timeCreated`
  from Cloud Storage, never from its name, and from before any suspected
  VM compromise.
- **Isolation:**
  - two throwaway PostgreSQL containers, a reference and the candidate;
  - `--network none`, tmpfs storage, the shipped socket-only authentication;
  - the production database and role names, bootstrapped from the image's
    `bootstrap-roles.sql`;
  - the reference is migrated with the gateway image and granted.
- **Least privilege:**
  - the dump is restored as `gateway_migrator` (uid 9002, peer), with
    `--no-owner --no-privileges --exit-on-error`, never as the superuser.
    That role cannot run programs or read server files;
  - the owner's identity is mounted read-only for decryption only;
  - the ciphertext is copied once to a private file, and only the copy is
    read;
  - the servers and job containers have no network, no capabilities and
    no stored logs, so the validator's restore errors never write row contents to host logs.
- **The validator's own superuser sessions are hardened.** The restored
  database belongs to the migrator, who can plant database settings or
  functions that shadow builtins, such as a `public.concat_ws`. So:
  - every superuser session runs with `search_path=pg_catalog,pg_temp` and
    fixed timeouts and formats (`PGOPTIONS`; client options override
    database settings), and names tables by schema;
  - database and role settings, database attributes and job-role
    attributes are checked from the `postgres` database first.

  R5's production re-check must keep the same protections.

- **The checks, in order:**
  1. The table of contents must be a subset of the reference's. This is a
     pre-filter only: a forged archive's labels prove nothing.
  2. The restored catalogs must contain none of the following. This check
     is authoritative only for what persists: SQL can create and drop
     objects during the restore without a trace.
     - functions, triggers, rules or policies;
     - extensions beyond `plpgsql`, or event triggers;
     - user types or extra schemas;
     - operators, large objects or foreign owners;
     - database or role settings.

     The database row, including grants such as `GRANT CREATE ON
DATABASE`, which no schema dump shows, plus the job roles and role
     memberships must equal the reference server's.

  3. Before migrating, so that the validator's own ledger rows never count:
     - no record time is later than `--created-at` plus 5 minutes;
     - no table count, and not the audit identifier, is below
       `--previous`;
     - the security digests are taken.
  4. The migration ledger must be a prefix of the reference's, with no
     gaps. After migrating forward, the ledger and the schema must equal the
     reference's.
  5. The security-relevant tables (`principals`, `identity_bindings`,
     `policy_versions`, `project_registry_versions`) are compared with
     `--previous` by digest.
- **Output:** one JSON line. On success it is the summary for the owner's
  restore record:
  - `verdict` and `created_at`;
  - `sha256`, the SHA-256 of the ciphertext. Decryption is deterministic,
    so only the file with that hash may be restored;
  - `counts` and `max_audit_id`;
  - per-table `security` digests;
  - `changed`.

  It never prints table contents.

| Exit | Meaning                                                                                                          | What the owner does                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `accepted`                                                                                                       | Record the summary; it may be restored (R5).                                                                                                                                |
| 2    | `held_for_owner_review`: `changed` names the security tables that differ, or is `null` with no `--previous`      | Confirm the change is expected, for example an onboarding binding or a policy activation, then record the summary. Otherwise treat it as suspicious.                        |
| 3    | Suspicious (`"quarantine":true`), including any failure the dump could cause once read, such as `restore_failed` | Record the object as quarantined, never use it, and treat every object created at or after its `timeCreated` as suspect. Choose an earlier object by the incident timeline. |
| 1    | Anything else, such as `restore_decrypt_failed` (junk) or a tool failure                                         | The previous object may be used. A tool failure is retried.                                                                                                                 |

- **Not a guarantee:** these checks reduce the risk of a forged backup;
  they do not eliminate it. A careful forgery by someone who knows the
  schema can pass. After any suspected compromise, choose the restore point
  by the incident timeline, not by recency.
- **Resources:**
  - a drill runs two extra PostgreSQL containers (256 MiB caps,
    `shared_buffers=32MB`, 512 MiB tmpfs each) and short job containers;
  - the restored database must fit in the tmpfs, which is ample at
    household size;
  - on the e2-micro, run it off-peak; R6 measures it.
- **Future migrations:** a migration that drops or renames a table will
  make genuine older backups fail the table-of-contents subset or the
  count checks. Such a migration must version the reference, or document
  the restore plan (VM design section 10).
- **Where:** drill dev dumps in dev. The owner drills prod dumps quarterly
  inside the prod boundary. Prod data never enters dev.

## Production restore after a data-disk loss (owner)

This is the procedure from the
[recovery point investigation](../engineering/2026-10-26-recovery-point-investigation.md),
sections 6 and 9. It is owner-run, inside the prod boundary, over IAP SSH,
as root. R6 rehearsed it in dev on 2026-11-04 (fictional data, the dev key);
it has not run in production. It also
needs the F13c-5d IAM and, for the gateway, PR #79. While it runs, CI must
not promote a new image: after a reboot the deploy watcher would migrate the
unchecked restore.

It is **interim, for Operator-only production use.** Before Steward or Participant
is onboarded, a deterministic, automated post-restore reconciliation is a
release requirement (PLAN Task 14, step 6). This manual procedure does not
satisfy it.

Rules throughout:

- **Plaintext stays on the VM.** Decrypted dumps and restored database
  contents never leave the prod VM, and never reach the MacBook Pro.
  Reconciliation reads Cloud Logging and provider history where they
  already are, and records identifiers only.
- **The key is supplied briefly.** The owner's `age` identity lives on
  tmpfs (`/run/owner/identity`, 0600). It is deleted as soon as step 8
  passes, on any abort, and re-supplied only if another candidate is
  needed.
- **The VM never reads backups with its own identity**, which can only
  create objects. The owner lists them from a workstation (metadata only)
  and fetches the one chosen object with a short-lived credential, never by
  logging in on the VM.
- **The gateway stays down until step 12**, behind three gates:
  - a runtime hold (a drop-in) that `systemctl start` cannot pass;
  - no `gateway.json` on the new data disk, so the unit fails with
    `gateway_config_missing`. This survives a reboot;
  - no runtime password, so the gateway cannot connect. This survives a
    reboot too.
- **Only objects created before the loss are candidates.** Anything created
  after it, such as a backup of the empty or restored database, is never a
  restore point.

### 0. Triage

If only the VM is lost and the **data disk is intact**, there is no restore:

1. recreate the VM from Terraform;
2. reattach the disk;
3. confirm health;
4. confirm that the next recent backup and its staleness check succeed.

Stop here. The rest is for a lost or unusable data disk.

### 1. Record the incident

In the owner's restore record, note:

- the time of loss (`T_loss`);
- the start of any suspected VM compromise, if there is one.

Candidates must have been created before both.

### 2. Recreate the VM and hold everything

1. If the VM is gone too, the owner applies the reviewed Terraform plan. A
   blank data disk is formatted by the safe path ([VM host](vm-host.md)).
2. Stop everything that could start the gateway, back up or restart units:

   ```sh
   # The hold first, so nothing stopped next can start the gateway again.
   mkdir -p /run/systemd/system/sim-g-gateway.service.d
   printf '[Service]\nExecStartPre=/bin/false\nRestart=no\n' >/run/systemd/system/sim-g-gateway.service.d/hold.conf
   systemctl daemon-reload
   install -d -m 0755 -o root -g root /run/sim-g
   touch /run/sim-g/maintenance
   systemctl stop sim-g-gateway sim-g-postgres sim-g-recover.timer sim-g-deploy-watch.timer \
     sim-g-backup.timer sim-g-backup-recent.timer sim-g-backup-stale.timer
   systemctl start sim-g-gateway && echo "HOLD FAILED" || echo "hold in place"
   # Stop the restart loops the refused start began. The start also pulls in
   # sim-g-postgres, which maintenance refuses but systemd keeps restarting
   # (each attempt logs postgres_failed, which pages; R6, 2026-11-04).
   systemctl stop sim-g-gateway sim-g-postgres
   # The stopped gateway leaves an exited container, which the production
   # re-check (step 8) refuses as production_gateway_running. It holds no
   # data; the unit creates a new one when it starts.
   docker rm sim-g-gateway 2>/dev/null || true
   ```

   A drop-in in `/run` merges with the unit file in `/etc`, unlike a
   runtime mask, which the unit file shadows. With the timers stopped,
   `backup_stale` stays silent; record that.

3. Write `host.env` (0600), with the digests the VM runs and the deploy
   pointer names ([VM host](vm-host.md)). **Do not write `gateway.json`
   yet.**

**After an unexpected reboot,** cloud-init starts `sim-g.target` again. The
gateway still cannot start (no `gateway.json`, no runtime password), but
PostgreSQL and the timers can, and any backup they make is after `T_loss`,
so it is never a candidate. Repeat step 2.2 and carry on.

### 3. Choose a candidate by creation time

From the owner's workstation, list the recent bucket newest first by
server-side creation time (`timeCreated`), never by name. Use the daily
bucket only if no recent object is usable. R6 confirmed these field names.

```sh
gcloud storage objects list "gs://<project>-sim-g-recent-backups/**" \
  --sort-by=~creation_time --format='value(creation_time,name,size)'
```

Take the newest object created before `T_loss`, and before any suspected
compromise. If the compromise start is unknown, prefer a daily object from
before the incident window. Convert its creation time to Unix seconds:

```sh
date -u -d '<creation_time>' +%s
```

### 4. Fetch it with a short-lived credential

Fetch the one object to `/mnt/disks/data/backup-staging/candidate.age` on
the VM. Never run `gcloud auth login` on the VM, so the owner's refresh
token never reaches its disk.

R6 used no credential on the VM at all. It streamed the ciphertext from the
owner's workstation over the verified IAP SSH session, then compared the
hashes. Only ciphertext crosses the workstation, never plaintext:

```sh
gcloud storage cat "gs://<project>-sim-g-recent-backups/family-brain-gateway/<object>" |
  gcloud compute ssh <vm> --tunnel-through-iap -- \
  'sudo sh -c "umask 077; cat > /mnt/disks/data/backup-staging/candidate.age"'
gcloud storage cat "gs://<project>-sim-g-recent-backups/family-brain-gateway/<object>" | shasum -a 256
# On the VM; must equal the line above.
sha256sum /mnt/disks/data/backup-staging/candidate.age
```

A credential scoped to that object and valid for minutes (a signed URL or a
downscoped token on standard input) remains an alternative. For production,
the owner confirms the streaming mechanism before first use.

### 5. Validate it, before production PostgreSQL starts

Bring `deploy/vm/backup/sim-g-restore-check.sh` from the deployed commit.
Run it through the settings wrapper, which exports the image digests and
configures registry pulls:

```sh
bash /etc/sim-g/bin/sim-g-host-env.sh sim-g-restore-check.sh \
  /mnt/disks/data/backup-staging/candidate.age /run/owner/identity \
  --created-at <Unix seconds> --previous <last accepted summary on this timeline>
```

| Exit | Next                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Keep the summary line as `summary.json`. Go to step 6.                                                                                                                                                                   |
| 2    | Review `changed`. If every change is expected, keep the summary and go to step 6. Otherwise treat it as exit 3.                                                                                                          |
| 3    | Record the object as quarantined. Suspect a compromise: update the step 1 timeline, treat every object created at or after it as suspect, and go back to step 3 for an earlier object, preferring a daily one if unsure. |
| 1    | `restore_decrypt_failed` is junk, so try the previous object (step 3). A tool failure: fix it and retry. Bad arguments: correct them.                                                                                    |

### 6. Start production PostgreSQL, still without a runtime password

Bootstrap PostgreSQL as in the first-start runbook ([VM host](vm-host.md),
step 3), but **do not set the runtime password**. Then start PostgreSQL
alone; the hold, the stopped timers and the missing `gateway.json` keep
everything else down:

```sh
rm /run/sim-g/maintenance
systemctl start sim-g-postgres
```

### 7. Restore a private copy of exactly that file, as the migrator

```sh
set -o pipefail
# The digests the VM runs, from host.env (the same images the validator used).
SIM_G_POSTGRES_IMAGE="$(sed -n 's/^SIM_G_POSTGRES_IMAGE=//p' /mnt/disks/data/sim-g/host.env)"
SIM_G_GATEWAY_IMAGE="$(sed -n 's/^SIM_G_GATEWAY_IMAGE=//p' /mnt/disks/data/sim-g/host.env)"
private="$(mktemp -d)"
cp /mnt/disks/data/backup-staging/candidate.age "${private}/dump.age"
# Must equal the summary's sha256.
sha256sum "${private}/dump.age"
docker run --rm -i --network none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --user "$(stat -c %u:%g /run/owner/identity)" --memory 256m --pids-limit 64 --log-driver none \
  --mount type=bind,source=/run/owner/identity,target=/run/age-identity,readonly \
  "${SIM_G_POSTGRES_IMAGE}" age --decrypt --identity /run/age-identity <"${private}/dump.age" |
  docker run --rm -i --network none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --user 9002:9002 --memory 256m --pids-limit 64 --log-driver none \
    -v /run/sim-g/postgresql:/run/postgresql:ro "${SIM_G_POSTGRES_IMAGE}" \
    pg_restore -h /run/postgresql -U gateway_migrator -d family_brain_gateway \
    --no-owner --no-privileges --exit-on-error &&
  echo restored || echo RESTORE FAILED
```

Neither stream reaches a container log, and the server logs terse errors
without failing statements, so no row values are logged. If the restore
fails, take the failure path in step 8.

### 8. Re-check the production copy, fail-closed

Run the validator's production-check mode, through the settings wrapper, with
the summary kept in step 5 and the same previous summary:

```sh
bash /etc/sim-g/bin/sim-g-host-env.sh sim-g-restore-check.sh --production-check \
  --summary summary.json --dump "${private}/dump.age" \
  --previous <last accepted summary on this timeline>
```

It runs the validator's checks on the production copy (`sim-g-postgres`),
with its hardened superuser sessions and a throwaway reference server from
the same images:

0. **The file and the hold:** it refuses to run unless the private copy
   restored in step 7 hashes to the summary's `sha256` (the database cannot
   show which file it came from), or while a `sim-g-gateway` container exists,
   while `gateway.json` exists, or once the runtime has a password (the
   job-role comparison is valid only while it has none).
1. **Before migrating:** the catalog check, then the integrity summary, which
   must equal the accepted summary exactly, because it is the same file.
2. **Then** `systemctl start sim-g-migrate`. It takes a backup (created after
   `T_loss`, so never a candidate), applies any migrations (usually none; an
   older genuine object can be a prefix) and runs the grants.
3. **After migrating:** the ledger and the schema must equal the
   reference's, the catalogs are checked again, and the runtime still has no
   password.

| Exit | Line                                          | Next                                                                                                                                                                       |
| ---- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `production_recheck_passed` with the `sha256` | Go to step 9.                                                                                                                                                              |
| 3    | `production_recheck_failed` with a reason     | The copy is not the accepted object, or it changed: take the failure path below.                                                                                           |
| 1    | `production_recheck_failed` with a reason     | A precondition, an argument or a tool failed (the hold, the migration run, a server that stopped answering): fix it and rerun, from a fresh restore if the migrations ran. |

- `production_dump_mismatch` (exit 1) takes the failure path unless the
  `--dump` path was simply mistyped: it means the file at hand is not the
  accepted one.
- **If exit 1 repeats after a fresh restore on a healthy host,** treat it as
  exit 3: the copy, not the environment, is failing.
- **Once the migrations have run, a rerun needs a fresh restore** (step 6):
  the migrated copy no longer equals the accepted summary.
- **What it proves:** the row counts of every table, the highest audit
  identifier and the four security tables' digests, the catalogs, the
  schema and the ledger. Other tables' contents are not compared; the
  restore from the hashed private copy in step 7 is what binds them.
- On the VM it also requires the gateway hold drop-in and stopped
  deploy-watch and recovery timers, and refuses its two test-only settings.

It is tested offline, against a restored throwaway copy, by
`pnpm backup:check` (`scripts/backup-check/production-check.sh`): a faithful
copy passes; a changed security-table row, an extra row, a planted
function, an escalated job role, an extra column, another file or another
object's summary, a failed migration, a stopped gateway container, a
runtime password or a configuration document present all fail closed. It
replaces the R5 interim snippet (engineering ruling, R5).

- **If the restore fails or the re-check exits 3:**
  1. do not go further;
  2. `touch /run/sim-g/maintenance`;
  3. `systemctl stop sim-g-postgres`;
  4. move `/mnt/disks/data/postgres` aside, never deleting it;
  5. quarantine the object (step 5's exit 3);
  6. start again from step 2.2.
- **When it passes:** record the summary in the restore record as the new
  timeline start. Delete `/run/owner/identity` and the private copy.

### 9. Reconcile the lost window by hand

The lost window runs from the restored object's snapshot (its `created_at`,
less a margin) to `T_loss`.

1. **Gather evidence:**
   - **Restored state:** operation and request IDs, states and targets of
     non-terminal operations, and pending approvals. Read them through a
     hardened superuser session on the VM, never their contents.
   - **Cloud Logging:** audit events in the window, by operation and
     request ID, read with the owner's log-read access. The VM runtime only
     writes logs.
   - **Providers:** the Notion and Drive history of each target named in
     that evidence.
2. **Apply the rules**
   ([stranded execution recovery](stranded-execution-recovery.md)):
   - The absence of an audit event or a provider marker never proves that
     an operation did not happen.
   - **Missing evidence never authorizes replaying a mutation.** Nothing is
     re-dispatched.
   - An operation is settled only on positive provider proof. Everything
     else stays unresolved and is listed.
   - **Restored `EXECUTING` and approval-claimed rows** stay unresolved
     unless provider inspection gives positive proof.
     `recoverStrandedExecution` is only reachable after step 12.
   - **Lost-window approvals:** an approval resolved in the window comes
     back as pending. It is never approved again; reject it or let it
     expire.
   - **Lost-window request IDs:** list them. A client retry would look new
     to the restored gateway, so ask the clients not to retry them.
   - **Audit redelivery:** audit events delivered in the window may be
     delivered again, with the same `event_id`.
3. **Record** the IDs, principal, type and target, the evidence found and
   missing, and each decision, in the restore record. Never record content.

### 10. Acknowledge

The owner acknowledges the reconciliation in the restore record. Until
then, the gateway stays down.

### 11. Set the runtime password

Run `\password gateway_runtime` with a **new** value, and add it as a new
version of the runtime database URL secret. Restoring after a loss is a
reason to rotate.

### 12. Reopen

1. Write `gateway.json`.
2. Remove the hold and start everything:

   ```sh
   rm -rf /run/systemd/system/sim-g-gateway.service.d
   systemctl daemon-reload
   systemctl start sim-g.target
   ```

3. **Check the service:**
   - confirm health;
   - confirm that the next recent backup and its staleness check succeed.
     On a recreated VM there is no marker yet, so one `marker_missing`
     page may come before the first recent backup;
   - repeat the provider checks for the lost window, to catch delayed
     writes;
   - once the gateway is up, `recoverStrandedExecution` can settle restored
     `EXECUTING` rows that have positive proof.
4. **Clean up:** delete the fetched object, and revoke or let expire the
   short-lived credential.

## Synthetic round trip

```sh
pnpm image:check     # builds family-brain-gateway:check and the PostgreSQL image
pnpm backup:check    # bash scripts/check-backup-roundtrip.sh [gateway image]
```

It runs entirely on local containers with fictional data, and checks each of
these:

- **Server:** a socket-only server with the shipped `pg_hba` and `pg_ident`
  starts, and the role bootstrap succeeds.
- **Migrations:** the compiled migration command applies all migrations as
  `gateway_migrator` by peer authentication.
- **Runtime role:** it can insert rows but **cannot** run DDL.
- **Grants:** the migrator's grant script runs. The runtime is refused, with
  "permission denied", on DDL, `TEMP` tables, `DELETE`, and writes to the
  migration ledger. It cannot connect without its password.
- **Peer mapping:** uid 1000 cannot take the backup role, uid 9001 cannot
  take the migrator role, uid 9002 cannot take the backup role, and the
  image's default user cannot peer as the superuser. Each is refused for the
  right reason.
- **Upload:** the backup uploads through a local stand-in for the metadata
  token and Cloud Storage APIs. The uploaded object begins with the `age`
  header and contains no `pg_dump` magic. (Custom-format data is compressed,
  so the restore's need to decrypt is the stronger proof.)
- **No overwrite:** a refused upload (412) fails the backup instead of
  overwriting.
- **Restore validation:** both objects pass the isolated validation and
  reproduce exactly the source row counts. Then
  `scripts/backup-check/restore-validation.sh` covers:
  - **genuine backups:** held without `--previous`; accepted against their
    own, a later one's, and an older-ledger summary;
  - **integrity:** rows after the creation time, counts below the previous
    summary, and a previous summary that is not earlier;
  - **security state:** a new identity binding is held, and its contents
    are never printed;
  - **planted objects:**
    - a planted function (the pre-filter);
    - a function relabelled as an existing table, which only the catalog
      inspection catches;
    - forgeries aimed at the validator itself: a function shadowing its
      builtins, a database `search_path`, a statement timeout, and a
      connection limit;
    - a database grant to the runtime, a changed job role, and a large
      object;
    - a dump that does not restore (quarantined);
    - each catalog kind planted directly, including an extension, an event
      trigger and a role setting;
  - **size:** a genuine dump of over 5 MiB;
  - **backdating:** an older backup validated an hour after it was made;
  - **schema and ledger:** a missing index (schema), an extra ledger row,
    and a tampered checksum (ledger);
  - **bad inputs:** corrupted ciphertext (junk), an encrypted non-archive,
    and bad arguments.
- **Tiers:** the stand-in keeps each bucket apart.
  - A daily run writes only to the daily bucket and no marker.
  - A recent run writes only to the recent bucket, prints its tier and
    records its marker. Its object restores to the same counts.

CI's Container image job runs it on every PR.

## Recovery point test (15-minute RPO)

```sh
pnpm backup:rpo-check   # bash scripts/check-backup-rpo.sh [gateway image]
```

The synthetic recovery test from the
[recovery point investigation](../engineering/2026-10-26-recovery-point-investigation.md),
section 12. It runs in scaled time: an interval of `SIM_G_RPO_INTERVAL`
seconds (default 15, at least 6) stands in for 15 minutes. It uses local
containers and fictional data only, and CI's Container image job runs it on
every PR.

1. **Set up:** a socket-only server, the production roles, the migrations
   and grants.
2. **Load:** household-like operations and a heartbeat committed every
   second, both through `gateway_runtime`. Commit times and counts come
   from the server, never the client. Both loops must still be running at
   the failure.
3. **Back up:** the real `sim-g-backup.sh recent` every interval, against
   the local Cloud Storage stand-in. An object's file time stands in for
   its `timeCreated`. Each run's object comes from its own
   `backup_completed` line, not from the listing the recovery uses. The
   first object is validated and becomes the owner's previous summary.
4. **Fail:** at a random moment, from just after the fourth run until 2
   seconds after the fifth run is due. A fifth run in progress is killed
   with the server, and its object never appears. The server is killed
   and its data volume deleted.
5. **Recover, as the production procedure above does:**
   - choose the newest object by creation time;
   - validate it with `sim-g-restore-check.sh` against the previous
     summary. Only undecryptable junk falls back; anything else stops;
   - restore a private copy of exactly that file, by hash, as
     `gateway_migrator`;
   - run the production re-check (`--production-check`, step 8), which
     migrates (nothing to apply) and grants the copy itself, against a
     reference from the same images, fail-closed;
   - set the runtime password, and the runtime must be able to write.
6. **Assert:**
   - the restored heartbeat and operations count lie within their run's
     start-to-completion window;
   - the data lost is at most one interval, plus 10 %, plus the slowest
     run, plus 2 seconds.

   It prints the measured loss as `rpo_check_bound`.

7. **Negative cases:**
   - with the newest object corrupted (one byte complemented, its creation
     time kept), the previous one is used, within two intervals;
   - a planted far-future name with an old creation time is never chosen;
   - with an empty bucket, or only junk, recovery stops with an explicit
     error and starts no server or volume.

**Not modelled:**

- reconciliation and the owner's acknowledgement (in production the gateway
  stays stopped until then);
- the gateway's own health check, which needs the VM database transport
  (draft PR #79);
- the staleness thresholds, which `pnpm host:check` covers at real scale;
- planted objects, identity bindings and older ledgers, which the
  restore-validation cases cover (above).

The scaling choices are engineering rulings, recorded in
`docs/implementation/STATUS.md`.

## Not yet covered

- The timers, the host socket directory and the daily bucket are now defined
  (`deploy/vm/host`, [VM host layer](vm-host.md); `infra/google`), but only
  checked offline. The recent bucket is slice R2.
- Real Cloud Storage behaviour (authentication, soft delete, the retention
  policy) is an F13d check.
