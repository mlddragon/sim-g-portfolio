# COS image replacement (patching the VM)

COS cannot update in place while UEFI Secure Boot is on (F13d Stage A), and
Secure Boot, vTPM and integrity monitoring stay on. So the VM is patched by
**replacing it from a newly pinned, exact COS LTS image**, keeping the data
disk ([decision](../engineering/2026-10-29-cos-patching-decision-proposal.md),
owner 2026-10-30).

**Authorized today:** development only, including one rehearsal of
replacement and rollback. **Production replacement needs separate owner
approval**; its outline is at the end.

## What survives, and what is rebuilt

| Where                           | What                                                                                           | On replacement                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data disk (`<name>-data`, kept) | PostgreSQL data, `host.env`, `gateway.json`, the certificate and certbot state, deploy markers | **Kept**: reattached as `google-sim-g-data`; an existing ext4 is never formatted (`data_disk_ready` `formatted: false`)                                    |
| Boot disk (recreated)           | Docker images, the recent-backup marker, the log shipper's position                            | Rebuilt: images pulled again by digest; the staleness check's 35-minute boot grace covers the first recent backup; the shipper sends everything since boot |
| `user-data`                     | The host layer                                                                                 | Unchanged; cloud-init writes it on first boot                                                                                                              |
| Instance                        | Name, service account, metadata, Shielded VM                                                   | Recreated identically by Terraform                                                                                                                         |
| Ephemeral address (development) | —                                                                                              | **Changes**; production keeps its reserved address                                                                                                         |

## Choosing the image

```sh
gcloud compute images describe-from-family cos-129-lts --project cos-cloud \
  --format='value(name,status,deprecated.state,creationTimestamp)'
```

- Use the family's newest image that is `READY` and not deprecated. Google
  deprecates every superseded build at once, so the soak is in development:
  a rehearsal, then at least 24 hours before production.
- Read its entry in the COS release notes for the milestone: no breaking
  change for Docker, systemd, cloud-init, iptables or fluent-bit.
- Monthly review; relevant high- or critical-severity fixes expedited
  (target seven days).
- Terraform accepts only `projects/cos-cloud/global/images/cos-<milestone>-<build>`
  (or `cos-stable-…`): never a family, beta, dev or other project's image.

## Development replacement (rehearsal)

Record each step's UTC time; the downtime is measured, not estimated. In
development the `dev.brain` A record stays **absent** for the whole
rehearsal (each replacement changes the ephemeral address, and a record
left on a released address could let someone else serve or certify the
name); every TLS check uses `curl --resolve`.

### 0. Preconditions (laptop)

- The new image and the **previous** pin (the rollback) are both usable:

  ```sh
  for image in <new> <previous>; do
    gcloud compute images describe "${image}" --project cos-cloud \
      --format='value(name,status,deprecated.state)'
  done
  ```

  Both `READY`; `DEPRECATED` still boots, `OBSOLETE` or `DELETED` does not.

- The exact plan reviewed (section 2) before anything stops.

### 1. Before (VM running, over IAP SSH)

1. **A fresh, usable backup.** Run one daily backup and note its object:

   ```sh
   sudo systemctl start sim-g-backup.service
   sudo journalctl -u sim-g-backup -n 3 -o cat | grep backup_completed
   ```

   On the laptop, validate that object with the isolated restore check
   ([backup and restore](backup-and-restore.md), "Restore validation and
   drill"): throwaway `--network none` containers, the images of the
   deployed commit pinned by digest, the dev `age` identity, and the
   object's `timeCreated`. This restores into throwaway containers only; it
   is not a restore into the VM (R6).

2. **Hold the gateway and the certificate timer** so nothing writes during
   the fingerprint and the snapshot:

   ```sh
   sudo install -d -m 0755 /run/sim-g && sudo touch /run/sim-g/maintenance
   sudo mkdir -p /run/systemd/system/sim-g-gateway.service.d
   printf '[Service]\nExecStartPre=/bin/false\nRestart=no\n' |
     sudo tee /run/systemd/system/sim-g-gateway.service.d/hold.conf >/dev/null
   sudo systemctl daemon-reload
   sudo systemctl stop sim-g-gateway sim-g-certificate.timer
   # Stopping the timer does not stop a certificate run already under way
   # (rehearsal: one finished just after the fingerprint and rewrote certbot's
   # renewal settings), so wait for it.
   while systemctl show --property ActiveState --value sim-g-certificate |
     grep -q activating; do sleep 5; done
   ```

3. **The data fingerprint** (compared after replacement and after
   rollback). Hashes only, never contents:

   ```sh
   sudo blkid -s UUID -o value /dev/disk/by-id/google-sim-g-data
   sudo tune2fs -l /dev/disk/by-id/google-sim-g-data | grep 'Filesystem created'
   sudo sh -c 'cd /mnt/disks/data && sha256sum postgres/PG_VERSION sim-g/host.env \
     $(ls sim-g/config/gateway.json 2>/dev/null) \
     sim-g/edge/certs/archive/*/*.pem sim-g/edge/certs/renewal/*.conf'
   sudo docker exec -i sim-g-postgres psql -qtA -U postgres -d family_brain_gateway <<'SQL'
   SELECT format('SELECT %L, count(*), md5(coalesce(string_agg(t::text, %L ORDER BY t::text), %L)) FROM %I.%I t',
                 schemaname || '.' || tablename, '|', '', schemaname, tablename)
   FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
   \gexec
   SQL
   ```

4. **Bounded snoozes** (owner-approved): only the uptime and missing-backup
   policies, ending at most 90 minutes later. Never the operational-event
   policy. Creating a snooze **closes** incidents already open on those
   policies, and one still failing re-opens when the snooze ends (one extra
   resolve-and-reopen email pair).

   ```sh
   gcloud monitoring snoozes create --project <project> \
     --display-name 'COS replacement <date>' \
     --criteria-policies projects/<project>/alertPolicies/<uptime>,projects/<project>/alertPolicies/<missing-backup> \
     --start-time "$(date -u +%FT%TZ)" --end-time "$(date -u -v+90M +%FT%TZ)"   # macOS date
   ```

5. **Clean shutdown** of the data's writer, then a snapshot:

   ```sh
   # Let a running backup finish (a run cut short fails without paging).
   # (a running oneshot is "activating", not "active")
   while systemctl show --property ActiveState --value sim-g-backup-recent sim-g-backup |
     grep -q activating; do sleep 5; done
   sudo systemctl stop sim-g-postgres   # T0 in development: the database stops
   sudo journalctl -u sim-g-postgres -n 8 -o cat | grep 'database system is shut down'
   sync
   ```

   Then, from the laptop, a temporary snapshot (deleted at cleanup):

   ```sh
   gcloud compute snapshots create sim-g-dev-pre-replacement-<date> --project <project> \
     --source-disk <name>-data --source-disk-zone <zone> --storage-location <region>
   ```

### 2. Replace

1. Set `boot_image` to the new exact image in the (uncommitted) tfvars.
2. `terraform plan` must show **exactly three replacements and nothing
   else**: `google_compute_instance.gateway`, and the instance-level
   `google_compute_instance_iam_member.operator_logs_in` and
   `google_iap_tunnel_instance_iam_member.operator_tunnels` (deleting an
   instance deletes its IAM policy). The data disk, buckets, other IAM,
   alerts and secrets must be unchanged. Review it, then apply that saved
   plan: Terraform destroys the instance (the data disk is detached, never
   deleted) and creates it again with the same name.
3. **If the apply ends with "Provider produced inconsistent result after
   apply" for the IAP grant** (seen once in the rehearsal: the grant was
   written, then briefly read back as absent), wait half a minute and plan
   again: the plan must show only that grant to create. Apply it, then
   confirm a fresh plan shows no changes.

### 3. After (new VM)

Cloud Logging carries the host events; only the fingerprint needs SSH.

- `data_disk_ready` with `formatted: false`; `networks_ready`,
  `firewall_ready`; `edge_starting` with `mode: serving` (the certificate
  survived).
- **T1:** the first moment PostgreSQL is ready on the existing data and the
  ingress serves TLS with the preserved certificate
  (`curl --resolve <name>:443:<new address> https://<name>/healthz`, plus the
  certificate's issuer, name and expiry). Downtime is T1 − T0. In
  development there is no `gateway.json`, so `/healthz` answers with an
  error status from nginx; T1 there is the TLS handshake with the preserved
  certificate and PostgreSQL ready.
- The next recent `backup_completed` and its freshness metric; the log
  shipper and both alert metrics.
- The fingerprint again (a new IAP SSH session), **before any
  `gateway.json` exists** (development), so nothing has written: identical
  filesystem UUID and creation time, hashes, and table counts and hashes.

### 4. Rollback (rehearsed once)

A new bounded snooze (1.4), then sections 1.2, 1.5, 2 and 3 with the
previous image. The data disk never depended on the OS image, so rollback is
the same replacement in reverse.

### 5. Cleanup

- Delete the temporary snapshot once the final state is verified.
- Let the snoozes expire (or delete them).
- Stop the VM; the `dev.brain` A record stays absent while it is stopped.
- **If a replacement fails:** the data is on the kept disk and in the
  snapshot; apply the previous image; if the disk itself is damaged, create
  a disk from the snapshot, or follow the
  [backup and restore](backup-and-restore.md) runbook.

## Measured in the development rehearsal (2026-10-30)

|                                                    | Forward (121 → 129) | Rollback (129 → 121)                                                                                                                                                                          |
| -------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0 → T1 (database stopped → ready and TLS serving) | 2 min 31 s          | 4 min 58 s                                                                                                                                                                                    |
| Apply start → PostgreSQL ready                     | 1 min 28 s          | 4 min 33 s                                                                                                                                                                                    |
| Why the difference                                 | —                   | the PostgreSQL image pull onto the new boot disk took 2 min 40 s, longer than the unit's start-up wait, so the first start failed (`postgres_not_ready`, which paged) and the retry succeeded |

The first PostgreSQL start now waits for the container (its image pull,
up to 9 minutes) before counting readiness, with a 12-minute start timeout, so a slow pull
no longer fails the first start. Plan for about 5 minutes of downtime.

## Production (not authorized yet)

After a successful development rehearsal and at least 24 hours' soak, a
separately approved change in the Sunday 03:00 America/Detroit window:
sections 0–3 as above, with T0 at the **gateway** stop and T1 at a healthy
`/healthz` (the gateway serves there), and the fingerprint adapted to a
serving gateway, plus lifting the instance's deletion protection for
the replacement and restoring it afterwards (two reviewed applies), with the
reserved address unchanged. A failed health check within 30 minutes rolls
back to the previous image.
