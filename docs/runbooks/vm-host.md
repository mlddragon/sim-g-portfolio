# VM host layer (e2-micro)

The systemd units and host scripts for the proposed single VM
(`docs/engineering/2026-10-25-e2-micro-vm-design.md`, sections 1, 2, 4, 6 and
8). **Nothing here has run on a real VM.** It is checked only offline:

```sh
pnpm host:check   # bash scripts/check-vm-host.sh (Terraform and Docker)
```

CI's Terraform job runs the same script.

## How it reaches the VM

`infra/google/modules/vm-host` renders `deploy/vm/host` and
`deploy/vm/backup/sim-g-backup.sh` into one cloud-config. The VM module sets it
as the instance's `user-data`.

- COS keeps `/etc` on tmpfs. cloud-init writes the units into
  `/etc/systemd/system` and the scripts into `/etc/sim-g/bin`, then starts
  `sim-g.target`. Nothing is enabled, so the repository is the only source of
  the host layer. Whether cloud-init does this on every boot is an F13d check.
- Every process on the VM can read `user-data`, so it holds no secrets. The
  contract tests fail on anything that looks like one.

## Units

| Unit                                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sim-g-data-disk.service`                                  | Waits for `/dev/disk/by-id/google-sim-g-data`, then mounts that device at `/mnt/disks/data` with `nodev,nosuid,noexec`. Formatting and the existing-mount check are described below. It then creates `postgres/` (uid 70, 0700), `sim-g/config/` and `backup-staging/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `sim-g-networks.service`                                   | Checks or creates three bridges, each with a fixed subnet, a fixed Linux bridge name, MTU 1460 (the VPC's) and IPv6 off: `sim-g-internal` (`172.31.250.0/28`, bridge `sim-g-int0`, `--internal`), `sim-g-gateway-egress` (`.16/28`, `sim-g-gw0`) and `sim-g-edge-egress` (`.32/28`, `sim-g-edge0`). An existing network with any other settings fails.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sim-g-firewall.service`                                   | Metadata-server isolation; see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sim-g-postgres.service`                                   | The PostgreSQL derivative as uid 70, with `--network none`, `listen_addresses=` and the shipped socket-only rules. It has a read-only root, no capabilities, 256 MiB and the F13b tuning. It refuses an unbootstrapped data directory and never runs `initdb`. It also refuses to start while `/run/sim-g/maintenance` exists, because PostgreSQL's lock cannot stop a second server in another container. The unit becomes active only once the server answers `pg_isready` on its socket, so units ordered after it never find the socket missing. The image's entrypoint makes the socket directory `3775` (writable only by uid and gid 70).                                                                                                                                                |
| `sim-g-gateway.service`                                    | The gateway image as uid 1000: read-only, no capabilities, 384 MiB, no published port. It joins `sim-g-gateway-egress`, and `sim-g-internal` at the fixed address `172.31.250.2` with `PORT=8080`, where nginx reaches it. It mounts the configuration document and the socket directory read-only, and sets `GATEWAY_HOST=0.0.0.0`, `GATEWAY_TRUSTED_PROXY_HOPS=1` and `GATEWAY_DATABASE_TRANSPORT=unix_socket`, so it refuses any TCP database URL. Its stdout and stderr go to `json-file` only, never also to the journal, so neither the logging agent nor the host log shipper can count a gateway line twice.                                                                                                                                                                            |
| `sim-g-edge.service`                                       | nginx ([ingress](ingress.md)) as uid 101: read-only, no capabilities, 96 MiB. It renders its configuration from `/etc/sim-g/edge` with the validated host name, publishes only 443 and 80 on `sim-g-edge-egress`, and joins `sim-g-internal`. Without a certificate it answers only port 80.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `sim-g-certificate.service`, `sim-g-certificate.timer`     | Twice a day and 2 to 62 minutes after boot, certbot as uid 101 obtains or renews the certificate through the HTTP-01 webroot, only once the owner has set `SIM_G_ACME_TERMS=agreed`. It restarts the ingress after the first certificate and reloads it after a renewal. Until then it prints `certificate_not_requested` and exits 0. A failure prints `certificate_renewal_failed`.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sim-g-migrate.service`                                    | Started by the operator. The deploy watcher runs the same script directly with the new image. It runs `sim-g-backup.service` (so it never overlaps the timer's backup). Then it runs `node dist/migration-cli.js` as uid 9002 (peer authentication), then `grant-runtime.sql`, each with `--network none`. One migration runs at a time (a lock), and it stops at the first failure. Its exit status says what failed: 1 means the migrations or grants (the image), 3 the backup, 4 a busy lock, 5 Docker itself.                                                                                                                                                                                                                                                                              |
| `sim-g-backup.service`, `sim-g-backup.timer`               | `sim-g-backup.sh` ([backup and restore](backup-and-restore.md)), daily at 09:15 UTC with up to 15 minutes' random delay, catching up after a missed run. It is `Requisite=` on PostgreSQL, so it never starts a server that an operator stopped. A run that falls in a PostgreSQL restart gap fails that day, and the next run is the following day; the backup alert (section 11) is what catches it.                                                                                                                                                                                                                                                                                                                                                                                          |
| `sim-g-backup-recent.service`, `sim-g-backup-recent.timer` | `sim-g-backup.sh recent`, every 15 minutes on the quarter hour with no random delay, to the separate 3-day bucket (`<project>-sim-g-recent-backups`, derived by the settings wrapper). A missed run is not caught up; the next one is due within 15 minutes. `Requisite=` on PostgreSQL, like the daily unit, so a run blocked by a stopped PostgreSQL prints nothing. `TimeoutStartSec=5min` stops the unit: its Docker clients are signalled, but the job containers run outside the unit's cgroup. Whether a hung dump's container is cleaned up is checked on a real VM in R6. A success records its completion time in `/var/lib/sim-g/backup-recent.last` for the staleness check ([recovery point investigation](../engineering/2026-10-26-recovery-point-investigation.md), section 5). |
| `sim-g-backup-stale.service`, `sim-g-backup-stale.timer`   | `sim-g-backup-stale.sh`, every 15 minutes at 7 minutes past each recent backup. It prints `backup_stale` and fails when the last recent-tier success is more than 35 minutes old (two consecutive misses), or its marker is missing, malformed (including zero-padded), not a regular file, a symlink, or more than 5 minutes in the future. Otherwise it prints `backup_recent_fresh` with the age. It stays quiet for 35 minutes after boot, and never pauses for maintenance. It runs no container and reads no settings. Alerting on the line arrives with section 11.                                                                                                                                                                                                                      |
| `sim-g-recover.service`, `sim-g-recover.timer`             | Every 5 minutes, starts PostgreSQL, the gateway, the ingress, the certificate timer, both backup timers, the staleness timer and the log shipping timer again. systemd never restarts a unit whose dependency failed (a late disk, a one-off firewall error), so without this the stack would stay down until someone acted. `touch /run/sim-g/maintenance` pauses it until the file is removed or the VM reboots.                                                                                                                                                                                                                                                                                                                                                                              |
| `sim-g-deploy-watch.service`, `sim-g-deploy-watch.timer`   | Every 2 minutes, follows the deploy pointer; see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `sim-g-log-ship.service`, `sim-g-log-ship.timer`           | Every minute, ships the host units' JSON lines to Cloud Logging; see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sim-g.target`                                             | Wants PostgreSQL, the gateway, the ingress and the seven timers (including log shipping). There is no reboot timer: COS cannot update in place with Secure Boot, so patching replaces the VM ([COS image replacement](cos-image-replacement.md)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Every container unit `Requires=` and comes `After=` `sim-g-firewall.service`,
so no container starts without the metadata rules. Failed services retry
every 5–10 seconds with no back-off. Back-off (`RestartSteps`) needs systemd
254, and the COS systemd version is an F13d check.

### Formatting the data disk

The script formats only when **both** checks say the disk is new:

- `blkid -p` exits 2 (no signature found); and
- the disk reads back as zeros, as a new persistent disk does, in all of these
  places:
  - the first and last 16 MiB, to the byte;
  - the first 64 KiB of every 8 MiB, which is the start of every ext4 block
    group, backup superblocks included, for 1, 2 and 4 KiB blocks.

`blkid` also exits 2 when it cannot read the disk, when a damaged superblock
fails its checksum, and when only the head was wiped. Such a disk still holds
recoverable data (`e2fsck` with a backup superblock), so the zero check refuses
it, and so does any read error.

- **What remains:** a disk with no surviving filesystem metadata at those
  offsets, but data elsewhere, could still be formatted. That takes damage
  beyond any single wipe of the head.
- **On a 10 GB disk** the check reads about 112 MiB once, on first boot only.
- **Fail-closed when tools are missing:** without `blockdev`, `dd` or `cmp`, a
  new disk is never formatted.

Every other case fails without formatting or mounting:

- a filesystem that is not ext4;
- a foreign label;
- a partition table;
- any other `blkid` exit.

If something is already mounted at `/mnt/disks/data`, it must be this device,
or the unit fails without touching it.

### Deploying a new gateway image

The deploy workflow writes the target digest, and nothing else, to
`gs://<project>-sim-g-deploy/family-brain-gateway/gateway.digest`.
`sim-g-deploy-watch` reads the object with a metadata-server token, which
reaches `curl` on standard input only, and accepts only a bare
`sha256:<64 hex>`. The repository is always the running image's, so the
pointer can choose a version but never a different image.

When the digest is new and PostgreSQL is running, it does this:

1. Pulls the image, bounded at 10 minutes.
2. Runs that image's migrations (`sim-g-migrate.sh`: a fresh backup, then
   migrations and grants) while the gateway keeps running the current image.
   `host.env` still names the current image, so no restart, crash or
   recovery can start the new image on the old schema.
3. Writes a `deploy-pending` marker (previous and new image), records the new
   image in `host.env` (atomically, root-only) and restarts the gateway.
4. Waits up to 2 minutes for the gateway's health check. If the restart fails
   or the gateway stays unhealthy, it restores the previous image and
   restarts again.

A run that finds `deploy-pending` finishes what an interrupted run (a crash,
kill or reboot) left:

- **If the new image was recorded**, the run restarts the gateway onto it and
  judges that container. Healthy means the running container is the expected
  image and reports healthy, so an old container or a stale status never
  counts.
- **If it was never recorded**, the deploy starts again.
- **A malformed marker** (anything but two digests of the running repository)
  stops every run with `deploy_pending_malformed` until an operator inspects
  and removes it.

`host.env` is rewritten only when the new content has exactly the expected
line. A failed rewrite leaves it untouched (`deploy_settings_write_failed`).

A digest goes into `/mnt/disks/data/sim-g/deploy-rejected` when its
migrations or its health check failed. It is not retried until the pointer
names another digest. The file holds only the last rejected digest, so
rejecting another one makes the first eligible again. To retry a fixed
problem without a new digest, delete the file.

These are not the image's fault. They are retried on the next run or
reported, and reject nothing:

- a failed pull;
- a failed backup;
- a Docker daemon error (exit 125);
- a migration already running (one at a time, by lock; an operator who sees
  `migrate_busy` simply retries);
- a stopped PostgreSQL;
- a failed restart (rolled back, `deploy_restart_failed`);
- maintenance that starts mid-run.

Migrations are forward-only and compatible with the previous image (section
10), so a rollback after migrating is safe.

- **Rollback** goes through the pointer: write the previous digest. A manual
  edit to `host.env` is undone within 2 minutes. During maintenance the
  watcher does nothing, and maintenance that starts mid-run is not held
  against the image.
- **Downgrades:** the pointer can name any digest in the repository, not only
  the previous one. Only the previous image is promised to be compatible, so
  promotion (F13c-5d) must restrict who writes the pointer.
- **Logging:** the watcher prints one JSON line when it acts, naming the
  digest, and migrations add their own. It prints nothing when there is
  nothing to do, including before any pointer exists (404).
- **Endpoints:** overrides are accepted only on loopback.
- **Access:** it needs the runtime account's read access to the deploy bucket
  (F13c-5d).
- **Pruning:** once a deploy is complete, the watcher removes this
  repository's other digest-pulled gateway images. It keeps the new image and
  the previous one, including the marker's previous image after a recovered
  deploy, so deploys never fill the boot disk's stateful partition.
  - PostgreSQL images are never touched.
  - A failed removal (for example an image a stopped container still uses) is
    counted and ignored. Every Docker call is bounded.
  - It reports one `deploy_pruned` line with the counts.
  - Only digest-pulled images are managed. On Docker's containerd image store,
    removing a digest also removes any tag an operator added to that image.
  - The disk is also monitored (section 11).

### Host log shipping

COS's own logging agent ships container logs, a fixed list of system units
and journal lines at priority warning or worse (F13d Stage A). The host
scripts print their JSON lines to stdout, which systemd records at priority
info, so the agent never ships them. `sim-g-log-ship.sh` closes that gap:

- **What:** only `sim-g-*.service` lines at priority notice to debug (what
  the agent leaves behind, so nothing ships twice), and only flat JSON
  objects in the host scripts' shape (`severity`, then `msg`, then simple
  values with no quote, backslash or control character). Text lines from
  systemd, Docker or a tool never ship. A contract case checks that every
  JSON line the host cases print has that shape.
- **How:** each line goes unchanged as `jsonPayload`, with its own severity
  and the journal's timestamp, to the `sim-g-host` log of this
  `gce_instance`, so the alert filters read `jsonPayload.msg` as they do
  for containers. It writes as the runtime account with its existing
  `logging.logWriter` role; the token reaches `curl` on standard input.
- **Delivery:** the journal is the buffer. The position (the newest line
  sent, `/var/lib/sim-g/log-ship.position`, root-only) advances only after
  Cloud Logging accepts a batch of up to 100, so an outage is caught up on
  the next run, and a resent line keeps its `insertId`. The first run after
  a lost position sends everything since boot.
- **Failures:** it prints `log_ship_failed` at journal priority err, which
  COS's agent ships, and the operational-event alert reads it in that
  shape. A shipper that never runs stops the recent backups'
  `backup_completed`, which the off-VM missing-backup alert catches.
- **Quiet:** it prints nothing on success, so it never feeds itself. It
  keeps running during maintenance.
- **Bounded:** at most two batches a run (a backlog continues the next
  minute), with 3-second metadata reads and 15-second posts inside the
  unit's 50 seconds. Cloud Logging unreachable or slow is
  `log_ship_http_000`.
- **Shipped twice, harmlessly:** the migration container runs attached, so
  `migrations_completed` and `migration_failed` reach both the journal (under
  `sim-g-migrate` or `sim-g-deploy-watch`) and `json-file`. Neither pages.
- **A stuck position:** if Cloud Logging keeps refusing a batch
  (`log_ship_http_400`, every minute), find the line with
  `journalctl -u 'sim-g-*' -p 5..7 -o short-unix --since @<position seconds>`,
  fix its source, then move the position past it (write that line's time in
  microseconds to the position file, root-only); deleting the file instead
  resends everything since boot. A position over 5 minutes ahead of the
  clock (after a large backward clock step) fails as
  `log_ship_position_invalid` every minute; correct the clock, or rewrite
  the position as above.

### Metadata-server isolation

`DOCKER-USER` sees container traffic before Docker's own rules. It sends
anything addressed to `169.254.169.254` to the `SIM-G-METADATA` chain:

1. DNS (UDP and TCP 53) returns. The metadata server is also the VM's
   resolver, and DNS issues no credentials.
2. Anything that did not arrive on `sim-g-gw0` is dropped. That covers every
   other bridge, including `docker0`, and a forged gateway address on another
   bridge.
3. Anything from outside `172.31.250.16/28` is dropped.

So only the gateway reaches the token endpoint.

- The chain is built completely before `DOCKER-USER` jumps to it.
- An existing chain must match exactly, and the jump must be the first rule
  in `DOCKER-USER` (an earlier `ACCEPT` would bypass it). Otherwise the unit
  fails closed.
- **A run interrupted mid-build** leaves the chain incomplete. Every later run
  then fails, and the recovery timer cannot repair it. Flush it by hand
  (`iptables -F SIM-G-METADATA && iptables -X SIM-G-METADATA`, after removing
  the jump) or reboot.
- The host's own traffic (the logging agent, uploads) uses `OUTPUT` and is
  unaffected.
- A second chain, `SIM-G-INGRESS`, bounds connections to nginx. `DOCKER-USER`
  jumps to it (second, after the metadata jump) for TCP to the edge bridge's
  subnet on ports 8080 and 8443, which is where Docker's DNAT sends 80 and 443. Per source it drops new connections above 20 a second (burst 40) and
  any beyond 32 open at once. It is built and checked exactly like the
  metadata chain, and a rule between the two jumps fails closed.

## Host settings

Each container unit runs its script through `sim-g-host-env.sh`. systemd never
loads the settings itself (no `EnvironmentFile`), so nothing in the file acts
before it is checked. The wrapper reads `/mnt/disks/data/sim-g/host.env`
without evaluating it, and requires:

- a regular file (not a symlink) owned by root, not group- or world-writable;
- unquoted `KEY=value` lines (blank lines and `#` comments allowed), each key
  at most once, and only these keys:
  - `SIM_G_GATEWAY_IMAGE`, `SIM_G_POSTGRES_IMAGE`, `SIM_G_EDGE_IMAGE` (nginx)
    and `SIM_G_CERTBOT_IMAGE`: in this project's Artifact Registry, pinned by
    digest. The project is read from the metadata server.
  - `SIM_G_BACKUP_BUCKET`: exactly `<project>-sim-g-backups`.
  - `SIM_G_BACKUP_RECIPIENT`: a native `age1…` public key.
  - `SIM_G_DOMAIN`: the ingress host name, a lowercase DNS name.
  - `SIM_G_ACME_TERMS`: optional; `agreed` once the owner accepts the Let's
    Encrypt Subscriber Agreement.

  The recent-tier bucket is never read from the file. The wrapper exports
  `SIM_G_RECENT_BACKUP_BUCKET` as `<project>-sim-g-recent-backups`, and the
  key is refused if the file sets it.

It then configures `docker-credential-gcr` for those registries, with a
writable `HOME` of `/var/lib/sim-g/home`, and runs the script with exactly
those values exported. It configures the helper only when it is not already
configured, because units start together and the helper rewrites its file in
place. Pulls also need the runtime account's Artifact Registry
read access, which arrives with the other grants in F13c-5d.

Other files:

- `/mnt/disks/data/sim-g/config/gateway.json` is root-owned and mode 0644, so
  uid 1000 can read it but not change it. It holds only references and handles
  ([configuration](configuration.md)).
- The database URL is in Secret Manager.

## First start (F13d, owner)

These steps need the transport of PR #79 (the IAM of F13c-5d is merged). They are
recorded here so F13d can rehearse them in dev, over IAP SSH:

1. Write `host.env` (0600). Write `gateway.json` (0644) only when the
   gateway should start (Stage B); until then, see "Holding the gateway"
   below.
2. Create the runtime directory, which does not exist until a unit has
   started (F13d Stage A), then hold PostgreSQL and the gateway:

   ```sh
   install -d -m 0755 -o root -g root /run/sim-g
   touch /run/sim-g/maintenance
   systemctl stop sim-g-gateway sim-g-postgres
   ```

   While the file exists, neither unit starts, and the recovery timer does
   nothing.

3. Bootstrap PostgreSQL once, as the
   [backup and restore](backup-and-restore.md) runbook describes. Root's own
   Docker has no registry credential helper; the settings wrapper configures
   one under `/var/lib/sim-g/home`, so a one-off `docker run` uses that
   `HOME`. As rehearsed in Stage A (the password exists only on tmpfs and is
   never printed):

   ```sh
   (
   set -euo pipefail
   # Always removes the password, whatever fails.
   trap 'docker rm -f sim-g-postgres-bootstrap >/dev/null 2>&1 || true; rm -rf /run/sim-g/bootstrap' EXIT
   export HOME=/var/lib/sim-g/home
   image="$(sed -n 's/^SIM_G_POSTGRES_IMAGE=//p' /mnt/disks/data/sim-g/host.env)"
   install -d -m 0700 -o 70 -g 70 /run/sim-g/bootstrap
   (umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >/run/sim-g/bootstrap/pw)
   chown 70:70 /run/sim-g/bootstrap/pw; chmod 0400 /run/sim-g/bootstrap/pw
   install -d -m 0755 -o 70 -g 70 /run/sim-g/postgresql
   docker run -d --name sim-g-postgres-bootstrap --network none \
     --read-only --cap-drop=ALL --security-opt=no-new-privileges --user 70:70 \
     --memory 256m --memory-swap 256m --pids-limit 128 --tmpfs /tmp:size=16m \
     --log-driver local \
     --volume /mnt/disks/data/postgres:/var/lib/postgresql/data \
     --volume /run/sim-g/postgresql:/run/postgresql \
     --volume /run/sim-g/bootstrap/pw:/run/bootstrap-pw:ro \
     --env POSTGRES_PASSWORD_FILE=/run/bootstrap-pw "${image}"
   # The final server, not the entrypoint's temporary one.
   for _ in $(seq 1 120); do
     docker logs sim-g-postgres-bootstrap 2>&1 | grep -q 'init process complete' &&
       docker exec sim-g-postgres-bootstrap pg_isready -q 2>/dev/null && break
     sleep 1
   done
   docker exec sim-g-postgres-bootstrap pg_isready -q
   docker exec sim-g-postgres-bootstrap psql -q -v ON_ERROR_STOP=1 -U postgres \
     -f /etc/sim-g/bootstrap-roles.sql
   docker stop -t 30 sim-g-postgres-bootstrap
   )
   ```

   (`--log-driver local` keeps its log readable with `docker logs` for the
   readiness wait, but out of the logging agent's `json-file` path.)

   Then, when the gateway is to start (Stage B): `\password gateway_runtime`,
   store the runtime URL in Secret Manager, and never write the password to
   a file.

4. Remove the maintenance file, then `systemctl start sim-g-postgres` (it
   returns once the server is ready), then `systemctl start sim-g-migrate`.
5. `systemctl start sim-g.target`.

### Holding the gateway (no `gateway.json` yet)

Without its configuration document (or during maintenance) the gateway
exits with status 3 and `gateway_failed` (`gateway_config_missing`, or
`maintenance_mode`): the unit does not restart it,
and the recovery timer starts it again every 5 minutes, so a missing
document in production keeps paging. For a deliberate hold (Stage A, or a
restore), use the runtime drop-in, which a reboot removes:

```sh
mkdir -p /run/systemd/system/sim-g-gateway.service.d
printf '[Service]\nExecStartPre=/bin/false\nRestart=no\n' \
  >/run/systemd/system/sim-g-gateway.service.d/hold.conf
systemctl daemon-reload
systemctl stop sim-g-gateway
```

## Restore after a data-disk or VM loss (owner)

- **VM lost, data disk intact:** recreate the VM and reattach the disk. No
  restore is needed.
- **Data disk lost:** follow [backup and restore](backup-and-restore.md),
  "Production restore after a data-disk loss". It keeps the gateway down
  until the lost window is reconciled and the owner acknowledges it, behind:
  - a runtime drop-in hold;
  - stopped timers;
  - no `gateway.json`;
  - no runtime password.

  The last two survive a reboot.

## Checks

`pnpm host:check` renders the cloud-config with Terraform, offline. It then
runs the checks below in a throwaway container from the repository's pinned
Debian base, with validators installed from Debian at check time (CI-only,
never shipped). The container gets `NET_ADMIN` only inside its own network
namespace.

- `cloud-init schema` (cloud-init 25.1).
- `systemd-analyze verify` (systemd 257), with the files written as
  cloud-init would and stub `docker.service` and `/usr/bin/docker`.
- `shellcheck` over every host script.
- 377 behaviour cases:
  - the blank-disk test with the real `blkid`, `mkfs.ext4`, `dd` and `cmp` on
    image files. It includes three disks that `blkid` reports as having no
    signature although they hold an ext4: one with a damaged checksum, and
    one with a wiped head for each of 1 and 4 KiB blocks. It also includes an
    unaligned disk with data in its last sector;
  - the firewall with the real `iptables`: the exact chain, one jump at the
    top, idempotence, and failing closed on a missing or altered chain or a
    rule ahead of the jump;
  - the remaining paths with stubbed `docker`, `systemctl`, `curl` and mount
    tools: every data-disk branch, network mismatches, every host-settings
    refusal, the PostgreSQL and gateway preconditions, the migration order and
    its stops, recovery and maintenance, the backup tiers, and the deploy
    watcher. The backup-tier cases cover:
    - an unchanged daily line, with daily writing only to the daily bucket;
    - recent writing only to the recent bucket, with its tier in the line and
      a root-only completion marker;
    - no marker after a failed upload;
    - unknown, empty and extra tier arguments, and a daily run without a
      recent bucket;
    - a missing recent bucket, or one equal to the daily bucket;
    - a marker path that is a directory or a symlink, and a planted
      temporary name, which is never written through.

    The staleness cases cover:
    - fresh, one miss (quiet), just under 35 minutes (quiet), and over it;
    - maintenance, which never silences a stale or missing marker;
    - a missing or old marker within the boot grace (quiet), its last
      second, and after it;
    - a malformed, zero-padded, non-file, symlinked or future marker, and
      up to 5 minutes of skew (quiet, age 0);
    - an unreadable or zero-padded uptime, which still checks.

    The watcher cases cover:
    - pointer handling: unchanged, malformed, missing, refused, unreachable,
      and no token;
    - PostgreSQL being down;
    - a failed pull, success, and migrations before the switch;
    - rollback after an unhealthy image or a failed restart, and an unhealthy
      rollback;
    - a remembered rejection and a failed migration;
    - deferral after a failed backup or a busy migration;
    - every kind of interrupted deploy, including a stale old container and
      malformed markers;
    - a failed settings rewrite, a Docker daemon error, and maintenance
      during migrations;
    - pruning: what is removed, what is kept, and that it never fails or
      runs after a rollback;
    - maintenance, and refused and loopback endpoints.

    The log shipping cases use real journal files (written by
    `systemd-journal-remote`), the real `journalctl` and `curl`, and a
    loopback server for the metadata server and Cloud Logging. They cover
    which lines ship (unit, priority, shape, boot window, a clock step), the
    request as Cloud Logging reads it, the position, a refused request and
    its catch-up with the same `insertId`, batches, refused endpoints,
    missing metadata, a malformed position, and that every JSON line the
    other cases print has the shipped shape.

`tests/contract/vm-host-boundaries.test.ts` fails if:

- a container (counted exactly, however `docker run` is spelled) runs without
  any of `--read-only`, `--cap-drop=ALL`, `no-new-privileges`, a fixed
  non-root uid, memory and PID limits, or an image from the validated
  settings;
- a container has more than one `--network`, host networking, a published
  port, `--privileged`, added capabilities or the Docker socket;
- PostgreSQL or a job container has a network, or PostgreSQL has a listener;
- a unit loads environment directly;
- the blank-disk or metadata rules weaken;
- anything resembling a secret appears in the host layer.

## Not yet here, and F13d checks

- **Ingress, on the real VM:** that Docker keeps client addresses through
  DNAT, the real Let's Encrypt exchange, and the flood measurements
  ([ingress](ingress.md)).
- **The deploy workflow** that writes the pointer, and promotion (section
  10). Both need workload identity federation (F13c-5d).
- **COS behaviour, checked on the real VM:**
  - whether cloud-init rewrites the files and starts the target on every boot;
  - that `docker`, `docker-credential-gcr`, `iptables` (legacy or nft, and
    `DOCKER-USER`), `blkid`, `blockdev`, `dd`, `cmp`, `mkfs.ext4`, `findmnt`
    and `mountpoint` are present and behave as checked;
  - that the disk appears as `/dev/disk/by-id/google-sim-g-data`;
  - that the gateway's read-only socket mount works;
  - whether Docker's embedded DNS needs the port 53 exception;
  - the systemd version, for back-off;
  - what the logging agent reads: settled in Stage A (`json-file`, and the
    journal at priority warning or worse); see host log shipping.
