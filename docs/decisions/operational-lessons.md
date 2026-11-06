# Operational design lessons

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

Technical findings retained from private execution evidence. Account,
billing, credential-custody and session records are not reproduced.

## 2026-10-28-cloud-qa-readiness

## 6. What this QA will and will not prove

**Will prove (in dev, on a real e2-micro):** the VM and its hardening;
socket-only PostgreSQL with no public listener; metadata isolation; the
ingress with real certificates and request limits; anonymous denial and
Google OIDC for Operator; Notion and Drive operations on fictional roots;
durable audit delivery to its bucket; the alerts; backups, the staleness and
off-VM alerts, and (with R6) a restore with the production check.

**Will not prove:** production behaviour or production readiness; GitHub
retrieval (not composed); Steward's and Participant's live accounts and onboarding;
a real AI-client connection; post-restore reconciliation (not built; required
before family onboarding); real household load over weeks; a cost invoice
(only a billing report for the window). It is not a deployment, and it does
not make SIM-G ready for family use.

## 2026-10-29-f13d-stage-a-evidence

## Findings

1. **COS ships no sim-g host-unit log line (failed check).** COS's own
   `fluent-bit` reads the journal only for a fixed list of system units and
   for lines at priority warning or worse. The host scripts print JSON to
   stdout, which systemd records at priority 6, so **no host line reaches
   Cloud Logging**: not `host_env_failed`, `postgres_failed`,
   `gateway_failed`, `backup_completed`, `backup_failed`, `backup_stale`,
   `certificate_renewal_failed` or `reboot_check_failed`. The operational
   event alert therefore cannot fire for any host event, and the off-VM
   missing-backup metric never sees a recent `backup_completed`. A synthetic
   probe logged at priority warning did arrive, in `cos_journal_warning` with
   the raw line in `jsonPayload.MESSAGE`, which the existing filter's
   second branch matches. Container lines are decoded and lifted to
   `jsonPayload.msg` as designed. systemd's own lines about sim-g units
   (`Failed to start sim-g-backup-stale.service`, `Dependency failed for
sim-g-backup-recent.service`, priorities 3 and 4) do arrive, so a failed
   unit is visible in Cloud Logging even though its reason is not. The fix
   belongs in the host layer (priority or shipping) and needs its own
   reviewed change.
2. **The COS update engine never runs (failed check).** `update-engine.service`
   has `ConditionPathExists=!/mnt/stateful_partition/.secure_boot`, and that
   file exists because Secure Boot is on. `device_policy_manager` also stops
   the service when no `cos-update-strategy` is set. So COS never stages an
   update in place, and the weekly reboot timer would log
   `reboot_check_failed` (`update_engine_unavailable`) every Sunday after
   about a minute of retries. Patching on this design means moving to a new
   image through Terraform (the data disk survives). The VM design and the
   reboot timer need an owner decision.
3. **Runbook gap:** `/run/sim-g` does not exist until a unit creates it, so
   the first-start step `touch /run/sim-g/maintenance` fails when every unit
   has refused. The operator created it (`0755`, root). Meanwhile PostgreSQL
   refused to start (unbootstrapped), as designed.
4. **Runbook gap:** root's Docker has no registry credential helper; only the
   settings wrapper configures one, under `HOME=/var/lib/sim-g/home`. The
   bootstrap's one-off `docker run` must use that `HOME`.
5. **Audit lines are also kept in `_Default`.** The `_Default` sink has no
   exclusion for `logType=family_brain_audit`, so each audit line is stored
   twice (35-day audit bucket and 30-day `_Default`). A design review
   should decide whether to exclude it.
6. **nginx's error log carries client addresses.** `access_log` is off, but
   an error such as a missing ACME file logs the client address, which
   reaches Cloud Logging.
7. **The gateway restart loop pages (once shipping works).** With no
   `gateway.json` the gateway unit restarts every 5 seconds and prints
   `gateway_failed` each time. For Stage A the operator held it with a
   runtime drop-in (`ExecStartPre=/bin/false`, `Restart=no`), which a
   reboot removes.
8. **The owner's Google sign-in expires within hours** (Workspace
   re-authentication), interrupting both the CLI and Terraform's
   credentials during the run. Plan sessions around it.
9. **A short-lived probe container's line was lost.** `fluent-bit` tails new
   container log files on an interval, so a container removed at once can
   vanish unshipped. Long-running containers are unaffected; job containers
   already use `--log-driver none`.

## 2026-10-30-cos-replacement-rehearsal

## Findings and what changed

1. **PostgreSQL's first start can fail on a new boot disk.** The readiness
   check counted from `docker run`, so the image pull used up its attempts,
   and the unit's 90-second start timeout would have cut it off anyway.
   **Fixed in this PR:** the check waits (up to 9 minutes, by the clock) for the
   container to exist before counting readiness, ends at once if the start
   command has already exited, and the unit's start timeout is 12 minutes;
   host cases cover each path.
2. **The IAP grant's provider inconsistency** after a replacement: the
   runbook now says to re-plan and apply the one grant.
3. **A certificate run in progress** survives stopping its timer: the
   runbook now waits for it before the fingerprint.
4. **The weekly reboot timer** had nothing to act on with Secure Boot and is
   **removed** in this PR (the owner's condition: after the replacement is
   validated), with its script, cases, contract test, alert-filter entry and
   runbook references.

## 2026-10-30-cos-replacement-rehearsal

## Before proposing production adoption

- Merge this PR (the start-up fix and the timer removal) and apply it to
  development in place (no image change; only the instance's `user-data`,
  which cloud-init writes at the VM's next start). Proving the fix on a real slow
  pull would take a **second** replacement, which the decision does not
  authorize (one rehearsal); the owner decides whether to approve it.
- At least 24 hours' soak on the chosen image in development.
- A separate production approval: deletion protection lifted and restored
  in two reviewed applies, the Sunday window, T0 at the gateway stop.

## 2026-10-30-f13d-certificate-session

## A risk this session found: a dangling A record

The development address is ephemeral. Once the VM stops, Google can assign
it to another customer, and while `dev.brain` still points to it that
customer could serve the name and obtain a certificate for it (the CAA
record allows Let's Encrypt). So the `A` record must not outlive a session:
it is removed when the VM stops and added again with the new address when
the next session starts (owner-approved each time). The `CAA` record may
stay. **Done for this session:** with the owner's approval the `A` record
was deleted after the VM stopped (Squarespace asked for the owner's Google
re-verification again); the authoritative servers no longer return it, and
the `CAA`, website and mail records are unchanged. Production uses a reserved static address, which does not have this
problem.

## 2026-11-02-f13d-stage-b-evidence

## Findings

- **Authentication precedes body validation.** With the binding disabled,
  the request naming another principal was refused 401, not 400: an unbound
  caller learns nothing about request validation. Correct; noted because the
  test script had expected 400.
- **Client addresses: where they are and are not logged.** nginx's access
  log is off, and its request and connection limit rejections are logged at
  `info`, below the error log's `warn`, so normal requests and limit
  rejections write no address (upstream failures still would, see below). The gateway logs no address; nginx replaces
  `X-Forwarded-For` with the TCP peer and the gateway trusts one hop, using
  the address only for rate limiting. **But nginx's own `warn` and `error`
  lines do carry `client: <address>`**, and they reach Cloud Logging
  (`cos_containers`, the `_Default` bucket) with the container's other
  output. Since 2026-10-28 there are 73 such lines, all from 2026-10-30
  between 17:02 and 17:13 UTC, when the VM still ran its original COS 121
  image (upstream connection failures while the gateway was not running, and
  one missing ACME file). A read-only classification found every address
  public: 63 the operator's own, 10 others, none a Docker bridge address. So
  Docker kept the real client address (DNAT, not the userland proxy) **on
  COS 121**; the Stage B session on COS 129 wrote no such line, so Stage C
  rechecks it on COS 129. The ingress runbook's wording, "the gateway's logs
  must show real client addresses" (`docs/runbooks/ingress.md`), does not
  hold literally, since the gateway logs none. The
  privacy boundary: addresses appear only in nginx error lines in
  `_Default`'s retention, never in audit or telemetry. No configuration
  change is proposed here. A forged header not moving a client's rate-limit
  bucket was measured at the edge in the
  [certificate session](../engineering/2026-10-30-f13d-certificate-session.md); Stage C's
  flood from a second address covers the gateway's own limiter.
- The host journal's D-Bus `org.chromium.SessionManager` errors at SSH login
  are COS noise, not a gateway or host fault.
- The first pre-binding run did not record the refusal reason; the test
  script now prints each reason and a boolean-only token check, and the
  unbound case was re-run with the binding disabled.

## 2026-11-02-f13d-stage-b-evidence

## Review corrections (2026-11-02)

An independent review of this evidence raised four qualifications. Each is
now reflected above:

- **Client addresses** were described too broadly as never logged; nginx
  error lines do carry them (see Findings).
- **The deploy watcher** was exercised in two healthy directions only. The
  "back" step was a manual pointer reversion, not the automatic rollback of
  an unhealthy image, which was not tested live.
- **Startup's root checks** prove reachability and nesting, not the
  semantic assignment of each root to its policy container.
- **Audit delivery:** `delivered_at` in the outbox alone is not proof of
  arrival in the audit bucket. The bucket was then read directly.

### Root-to-policy mapping

Verified read-only, before any Stage C mutation:

- **Drive:** each configured folder's title, read by ID through the Drive
  API as the owner, matches its container: Family Shared to `family_shared`,
  Parent and Stewardship to `parent_and_stewardship`, Protected to
  `protected`. All three are direct children of the fictional QA Shared
  Drive (none is nested in another root).
- **Notion:** the Family Shared data source, the Parent and Stewardship
  page and the Protected page match their containers by title. Both pages
  are top-level in the fictional workspace, not under Family Shared. The
  Family Inbox data source and its six status options match the configured
  IDs.
- **Policy:** `config/policy/family-brain-v1.yaml` routes each container to
  its own policy. `protected` is scope `legal`, sensitivity `protected`,
  class `protected`; the other two are class `none`. The configuration
  schema rejects duplicate containers and duplicate Drive folder IDs, and
  the startup check rejects a root nested under a more restrictive root. So
  Protected cannot be read as a less restrictive root.

### Audit delivery

The `family-brain-audit` log bucket holds exactly the four Stage B events
(`brain.read.partial` and `brain.request.completed` for each of the two
accepted requests), with `prn_operator` and the same request IDs as the
outbox rows. This shows the path from the request through the outbox to the
sink for these events. Stage C still keeps its own end-to-end audit
correlation check.
