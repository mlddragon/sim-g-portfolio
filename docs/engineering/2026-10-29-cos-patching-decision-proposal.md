# COS patching with Secure Boot: decision

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

**Proposed:** 2026-10-29. **Status: Option A approved by Operator on
2026-10-30, with the conditions in "The decision" below**, recorded in the
Example Knowledge System (SIM-G, owner decision 2026-10-30). The approval covers
the offline implementation and **one development-only replacement
rehearsal** within the F13d limits; **no production change** is approved.
Evidence goes to the owner before production adoption is proposed.

## The problem

F13d Stage A ([evidence](2026-10-29-f13d-stage-a-evidence.md), finding 2)
found that the COS update engine never runs on our VM:
`update-engine.service` has
`ConditionPathExists=!/mnt/stateful_partition/.secure_boot`, and that file
exists because UEFI Secure Boot is on. Google's documentation agrees:

- In-place updates are not supported on VMs with UEFI Secure Boot enabled.
- From milestone 117, automatic updates are disabled by default anyway
  (`cos-update-strategy` enables them).
- Automatic updates stay within a milestone and need a reboot to apply; a
  new milestone always means recreating the VM from a newer image.
- LTS milestones are supported for 26 months. Today `cos-cloud` publishes
  the LTS families 121 (support ends March 2027), 125 (February 2028), 129
  (July 2028) and 133. Our pin, `cos-stable-121-18867-652-12`, is a 121 LTS
  build, so **a milestone change is needed before March 2027 whatever is
  decided here.**

So the VM design's section 9 (weekly reboot only when an update is staged)
cannot work as written, and the weekly reboot timer would log
`reboot_check_failed` (`update_engine_unavailable`) every Sunday.

## Options

**A. Keep Secure Boot; replace the VM from a newly pinned image
(recommended).** Patching becomes a reviewed change of the pinned image,
rehearsed in development, then applied to production in the Sunday 03:00
the operator-selected time zone window. The data disk is never touched.

**B. Disable Secure Boot; enable in-place updates.** Set
`enable_secure_boot = false` and `cos-update-strategy=update_enabled`; the
existing reboot timer then applies staged updates weekly.

**C. Leave it.** No patches until a milestone change. Not acceptable for an
internet-facing host.

|                          | A. Secure Boot + replacement                                               | B. No Secure Boot, in-place                                                                                          |
| ------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Boot-chain security      | Kept: only Google-signed boot components boot, measured into the vTPM      | Lost: an unsigned bootloader or kernel would boot; vTPM and integrity monitoring still detect, but no longer prevent |
| Within-milestone patches | Monthly, or within 7 days of a high or critical fix                        | Weekly, automatic                                                                                                    |
| Milestone upgrades       | The same procedure                                                         | Still need A's replacement procedure                                                                                 |
| Downtime                 | One planned window, about 5–10 minutes (to be measured in dev)             | 1–2 minutes a week when an update is staged                                                                          |
| Rollback                 | Re-apply the previous pin (same procedure)                                 | COS's A/B partitions roll back a failed boot automatically                                                           |
| Complexity               | A reviewed runbook and a two-step apply for production deletion protection | Already built (the reboot timer)                                                                                     |
| Cost                     | The same single e2-micro; a temporary snapshot costs cents                 | The same                                                                                                             |

**Recommendation: A.** Secure Boot is part of the approved Shielded VM
posture and the only control that _prevents_ a tampered boot chain. Option B
saves a monthly window but still needs A's procedure for every milestone
change, so it adds a second patching path rather than replacing one. A
monthly cadence with a 7-day path for urgent fixes is proportionate for one
household VM.

## How option A would work

### Detecting and selecting a release

- Pin an exact image from an **LTS family** (`cos-129-lts` proposed, support
  to July 2028), not `cos-stable`, which moves between milestones.
- Monthly, and when the COS release notes announce a high or critical
  security fix, the operator (or a scheduled read-only check) reads the
  family's newest image: `gcloud compute images describe-from-family
cos-129-lts --project cos-cloud`.
- Choose it only if it is `READY`, not deprecated, at least 7 days old
  (unless the fix is urgent), and its release-notes entry has no breaking
  change for Docker, systemd, cloud-init, iptables or fluent-bit.

### Provenance and compatibility

- **Provenance:** the image comes only from Google's `cos-cloud` project,
  named exactly. Secure Boot then verifies the signed boot chain on every
  boot; integrity monitoring takes a new baseline at the new VM's first boot,
  which is checked to pass. Terraform's validation would accept only
  `projects/example-project/global/images/cos-<milestone>-<build>` (today it
  accepts only `cos-stable-…`).
- **Compatibility:** the new pin goes to development first and must pass
  the affected Stage A checks there: unit start-up and cloud-init, the exact
  `iptables` chains, metadata isolation, socket-only PostgreSQL, backups,
  log shipping and alerts, the ingress, and the systemd and Docker versions.
  It then soaks for at least 24 hours before production.

### Preserving the data disk

- PostgreSQL data, the certificate state and deploy markers are on the
  separate data disk (`google_compute_disk.data`), which production already
  protects with a `PREVENT` deletion policy. Only the boot disk is
  recreated.
- What the boot disk loses is rebuilt on its own: Docker images (pulled
  again by digest), the recent-backup marker (the staleness check's 35-minute
  boot grace covers the first new backup) and the log shipper's position
  (it sends everything since the new boot).

### The production procedure (Sunday 03:00 the operator-selected time zone)

1. **Before:** fresh recent backups; run `sim-g-backup.service` once and
   validate that object with the isolated restore check
   (`sim-g-restore-check.sh`); take a data-disk snapshot (deleted after
   success).
2. **Hold:** maintenance file and gateway hold as in the restore runbook;
   stop the gateway, then PostgreSQL cleanly.
3. **Replace:** production's instance has deletion protection, so a reviewed
   change lifts it, replaces the instance with the new pin
   (`terraform apply -replace`), and restores it. One VM exists at a time
   (destroy, then create), so the free e2-micro allowance holds.
4. **Start:** cloud-init writes the host layer; the data disk mounts (an
   existing ext4 is never formatted); PostgreSQL starts on its data; no
   migration runs, because the gateway image is unchanged.
5. **Health:** `/healthz` through the ingress and the uptime check; a recent
   backup completes and is fresh; `iptables` and metadata isolation as in
   Stage A; log lines arrive.
6. **Rollback:** if health fails within 30 minutes, apply the previous pin
   the same way. The database never depended on the OS image. If the data
   disk itself is damaged, create a disk from the snapshot, or follow the
   restore runbook.

A failed replacement therefore leaves the data on the protected disk and the
snapshot, a known previous pin, and paging alerts. The gateway is down only
until the rollback finishes.

### Alerts during the window

The uptime and off-VM missing-backup alerts page during any planned outage.
Proposed: a Cloud Monitoring snooze of those two policies only, with an end
time no later than the window plus one hour. Never snooze the
operational-event alert. In development, the same procedure covers
intended VM stops between QA sessions (snooze ending at the planned
restart). Each snooze needs the owner's approval when created.

### What happens to the Sunday window and the reboot timer

- The Sunday 03:00 the operator-selected time zone window stays the owner's maintenance
  window, now for planned image replacements.
- The weekly reboot timer has nothing to act on with Secure Boot and would
  page weekly once host logs ship, so it would be **removed**, with its
  contract and host cases.

### Changes needed (after approval)

- **Terraform:** accept exact `cos-cloud` LTS image names; move dev, then
  production, to the chosen LTS pin; document the deletion-protection steps
  for production replacement.
- **Host layer:** remove `sim-g-reboot.timer` and its service, script, cases
  and contract assertions; update the VM design's section 9.
- **Runbook:** a COS image replacement runbook (detection, dev rehearsal,
  production window, health, rollback, snooze).
- **CI (optional):** a scheduled read-only check that reports when the
  pinned family has a newer image.
- **QA:** rehearse a replacement in development as the Stage A
  "reboot and update strategy" check, measuring the real downtime.

## The decision (owner, 2026-10-30)

1. **Option A.** Keep UEFI Secure Boot, vTPM and integrity monitoring;
   patch by controlled VM replacement from an exact, reviewed COS LTS image,
   not in-place updates.
2. **Image:** COS 129 LTS first, after a brief evaluation of 133 LTS;
   proven compatibility and maintainability come before the newest version
   (evaluation below).
3. **Window and cadence:** Sunday 03:00 the operator-selected time zone stays the
   production window; a monthly patch review, and relevant high- or
   critical-severity fixes expedited, targeting seven days.
4. **The weekly reboot timer** is removed once the replacement mechanism is
   reviewed and validated.
5. **Snoozes:** narrowly bounded, automatically expiring snoozes of the
   uptime and missing-backup alerts during supervised maintenance; the
   operational-event alert is never suppressed.
6. **The rehearsal** (development only, once) must first verify a fresh
   usable backup, confirm the recovery options and review the exact
   Terraform plan; the data disk and its contents must survive unchanged;
   any temporary snapshot stays within the spending and cleanup limits. It
   must prove clean shutdown, replacement, reattachment without formatting,
   successful startup, preserved configuration and certificates, working
   backups and monitoring, and a viable rollback, and record the actual
   downtime.
7. **Not authorized:** production changes, broader IAM or new recurring
   services; the 48-hour/seven-day window and the USD 2 and USD 5
   thresholds still apply.

## Image evaluation (2026-10-30)

|            | COS 129 LTS                                            | COS 133 LTS                                                                                |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Maturity   | Stable builds since May 2026                           | LTS since its 2026-08-31 refresh; Google's notes call its newest build (2026-10-27) a beta |
| Docker     | 27.5.1                                                 | 29.4.3 (two major versions newer)                                                          |
| Kernel     | 6.12                                                   | 6.18                                                                                       |
| cloud-init | 25.1.4 (the offline host check validates against 25.1) | 26.1                                                                                       |
| fluent-bit | 4.2.8                                                  | 4.2.8                                                                                      |
| iptables   | 1.8.13                                                 | 1.8.13; an nftables restore unit masked                                                    |
| Support    | to July 2028                                           | later                                                                                      |

**Selected: COS 129 LTS, exactly `cos-129-19506-578-21`** (released
2026-10-27; it fixes an expat CVE). 133's larger Docker, kernel and
cloud-init jumps add host-layer risk for no current need; it is the
candidate for the next milestone move, before 129's support ends.

**Engineering ruling, image age:** Google deprecates every superseded build
as soon as a newer one is published (all earlier 129 builds are
`DEPRECATED`), so "at least 7 days old" would force a deprecated pin. The
pin is therefore the family's newest `READY`, non-deprecated image, and the
soak happens in development instead: the rehearsal, then at least 24 hours
before any production use.

## Sources

- [COS automatic updates](https://docs.cloud.google.com/container-optimized-os/docs/concepts/auto-update)
- [COS versioning and LTS support](https://docs.cloud.google.com/container-optimized-os/docs/concepts/versioning)
- [COS support policy](https://docs.cloud.google.com/container-optimized-os/docs/resources/support-policy)
- [Shielded VM overview](https://cloud.google.com/compute/shielded-vm/docs/shielded-vm)
