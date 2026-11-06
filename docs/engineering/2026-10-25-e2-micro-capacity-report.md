# SIM-G e2-micro synthetic capacity report (F13b)

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

**Status:** Preliminary local evidence, from the run of record on 2026-10-25
(trial 5). This is **not** proof of Compute Engine e2-micro performance.
Fictional data only; no cloud resource, credential or real family data was
used. Method and reproduction: [capacity testing runbook](../runbooks/capacity-testing.md).
Costs: [recurring-cost model](2026-10-25-e2-micro-cost-model.md).

## Conclusion

On this evidence, a single e2-micro looks feasible for SIM-G's household
workload without changing machine type, architecture or any safeguard.

- **Memory:** VM memory in use peaked at about 511 MiB of 956 MiB. That includes about 238 MiB of guest OS and container runtime; the containers themselves were at most about 242 MiB. The smallest free memory seen was 445 MiB.
- **Household load at 0.25 vCPU:** p95 was about 245 ms, mostly the simulated
  provider latency. It used about 3 % of one vCPU.
- **Overload:** the production rate limiter refused a single-source flood with 429s, but those refusals alone used the whole 0.25 vCPU budget (see below).
- **Audit:** an outbox backlog drained by itself, and nothing was lost.
- **Backup and restore:** both took under a quarter of a second, and the row
  counts matched.

The real-hardware questions below remain open. Each is a gate for the
bounded cloud trial (F13d). Testing also found a class of defect: a database outage could surface as HTTP 500 instead of a retryable 503. The two paths seen or traced here, authentication and mutation targeting, are fixed with regression tests. Other hot-path store calls still map a dropped connection to 500. They fail closed, but are recorded as a gap for F13c.

## Kinds of evidence

| Kind          | Meaning here                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------ |
| **Observed**  | Measured in the run of record on this local development host.                                    |
| **Simulated** | A synthetic stand-in, such as provider latency, the shared source address, or the CPU cap model. |
| **Estimated** | Derived by arithmetic from observations plus a stated assumption.                                |
| **Assumed**   | Not measured.                                                                                    |

## Environment (observed)

- **VM:** a Colima VM (`vz`) on Apple silicon: arm64, 2 vCPUs, 956 MiB usable,
  no swap, Ubuntu 24.04 guest running Docker Engine 29.5.2. The guest alone
  used about 238 MiB (dockerd about 80 MiB, containerd about 43 MiB, the lima
  agent about 28 MiB).
- **Stack:** the gateway, PostgreSQL 17.11, Caddy 2.11.7 and Fluent Bit 5.1.3,
  all pinned by digest, sharing one loopback network namespace and one cgroup.
- **CPU model (simulated):** `cpu.max` set to `max` for burst (2 vCPU), and
  `25000 100000` for the 0.25 vCPU e2-micro sustained baseline.
- **Providers (simulated):** in-memory, with 150 ms ± 50 % latency and 500
  records each across Family Shared, Parent and Stewardship, and Protected.
- **Real components:**
  - `main()`, configuration and policy verification;
  - RS256 OIDC verification against a synthetic key;
  - authorization, routing and audit;
  - the PostgreSQL pool and store, Fastify, and the stdout sinks;
  - the in-process audit delivery loop.

## Results (observed, trial 5)

Latency was measured at the client: HTTPS through Caddy, with keep-alive.
"Denials" are correct policy outcomes, not failures:

- `record_not_found` is a record outside the caller's scope;
- `role_operation_forbidden` is Participant listing approvals.

| Phase                       | CPU       | Clients (think time) | Requests/s | p50 / p95 / p99 ms  | Unexpected failures                                                                |
| --------------------------- | --------- | -------------------- | ---------: | ------------------- | ---------------------------------------------------------------------------------- |
| Household                   | 2 vCPU    | 3 (about 3 s)        |       0.91 | 177 / 235 / 252     | 0                                                                                  |
| Household                   | 0.25 vCPU | 3 (about 3 s)        |       0.88 | 180 / 245 / 338     | 0                                                                                  |
| Overload, production limits | 0.25 vCPU | 12 (none)            |        636 | 3 / 87 / 97         | 0; 18,965 were `ip_rate_limited` 429s, by design, but CPU was saturated            |
| Headroom, raised limits     | 2 vCPU    | 12 (none)            |       77.2 | 171 / 230 / 238     | 0                                                                                  |
| Headroom, raised limits     | 0.25 vCPU | 12 (none)            |       21.0 | 513 / 1,093 / 1,403 | 0                                                                                  |
| Household after headroom    | 0.25 vCPU | 3 (about 3 s)        |       1.01 | 183 / 243 / 448     | 0                                                                                  |
| Audit sink down             | 0.25 vCPU | 3 (about 1 s)        |       2.57 | 180 / 244 / 277     | 0                                                                                  |
| PostgreSQL restart at +30 s | 0.25 vCPU | 3 (about 1 s)        |       2.61 | 177 / 247 / 333     | 2 of 238: one 503 `audit_state_unavailable` (correct), one **500** (defect, fixed) |

### Memory

Highest sampled memory per container, from `docker stats` (observed). Samples were about 4–5 s apart, so brief peaks between samples can be missed:

|                           |     Gateway | PostgreSQL | Caddy (TLS) | Fluent Bit | VM used | VM minimum available |
| ------------------------- | ----------: | ---------: | ----------: | ---------: | ------: | -------------------: |
| Idle after start          |      66 MiB |     20 MiB |      13 MiB |      4 MiB | 437 MiB |              519 MiB |
| Household                 |   67–81 MiB |  27–32 MiB |      13 MiB |      4 MiB | 439 MiB |              518 MiB |
| Overload                  |     129 MiB |     46 MiB |      17 MiB |      4 MiB | 478 MiB |              478 MiB |
| Headroom                  | 110–135 MiB |  52–57 MiB |      17 MiB |      5 MiB | 511 MiB |              445 MiB |
| Restart and backup phases |     112 MiB |  38–41 MiB |      16 MiB |      5 MiB | 494 MiB |              462 MiB |

- **Gateway memory:** it rose after the heavy phases and then stayed flat at
  about 112 MiB through the later household phases. That is consistent with
  V8 keeping a larger heap after load, not with a leak in this window. A
  longer soak is not covered.
- **Health checks:** the Docker `HEALTHCHECK` briefly starts a second `node`
  process (about 25–30 MiB) every 30 s, in the gateway and, in this run, also
  in the namespace holder, which inherited it (up to about 43 MiB, a harness
  artifact). The script now disables it there. The figures above are
  therefore conservative. The gateway's own check is a real cost wherever it
  is used.

### CPU and throttling

Cgroup `cpu.stat` for the whole stack (observed):

| Phase                          | CPU used                               | Throttled periods | Throttled time |
| ------------------------------ | -------------------------------------- | ----------------: | -------------: |
| Household, 0.25 vCPU, 120 s    | 3.5 CPU-s (about 0.03 vCPU on average) |               7 % |          3.6 s |
| Overload, 0.25 vCPU, 30 s      | 7.4 CPU-s (the cap)                    |              99 % |           36 s |
| Headroom, 0.25 vCPU, 60 s      | 15.0 CPU-s (the cap)                   |             100 % |          80 s* |
| Household after headroom, 60 s | 3.1 CPU-s                              |              22 % |          6.0 s |

\* Cgroup `throttled_usec` sums waiting time across runnable threads and CPUs,
so it can exceed wall time.

- **Overload cost:** refusing about 636 requests/s with 429s from one source
  used the whole 0.25 vCPU budget. On x86 cores 2–3× slower, an estimated
  200–300 requests/s would. A flood spread across many addresses bypasses the
  per-IP limiter entirely. Latency for genuine household users during a flood
  was not measured. **Gate (F13c/F13d):** add connection and rate limits at
  ingress (Caddy or the firewall) before Node, and measure a household client
  during a flood.
- **Household load uses about an eighth of the sustained budget.** Some
  100 ms periods still throttle, because single requests are bursty. On real
  E2 hardware, bursting above the baseline is handled differently (not
  modelled).
- **Estimated stack CPU cost per request:** at saturation, 0.25 vCPU served
  about 21 requests/s, so roughly 12 ms of CPU per request across the gateway,
  PostgreSQL and Caddy. This is on Apple-silicon cores.

### Startup, shutdown and restart (observed)

- **Cold start:** the gateway was healthy 1.10 s after `docker run`, and HTTPS
  through Caddy worked at 1.17 s. This includes migrations and synthetic
  seeding, but excludes Secret Manager reads and the Notion and Drive root
  ancestry walks, which are network-bound and not measured.
- **Graceful stop:** SIGTERM to exit took 94 ms, with exit code 0.
- **Restart:** healthy again after 0.93 s.

### Audit outage and recovery (observed)

- With the audit sink failing for 60 s under household load, every request
  still succeeded: delivery is decoupled through the durable outbox. At
  recovery 325 events were pending.
- After the sink was restored, the in-process loop delivered all of them
  within **33 s**, at 0.25 vCPU, leaving 0 pending.
- The audit backlog grows on disk, not in memory: gateway memory stayed
  about 112 MiB.

### PostgreSQL restart (observed)

- **Restart confirmed:** PostgreSQL memory dropped from 41 to 18 MiB about
  26 s into the phase. The `docker restart` took about 1 s.
- **Two of 238 requests failed:**
  - a correct, retryable 503 when the audit enqueue could not reach the
    database;
  - an **HTTP 500** from `search_brain`.

  The pool recovered without intervention.

- **Root cause of the 500:** `AuthenticationService` called the principal
  lookup without mapping a raw driver error, so a dropped connection became
  `internal_error`. This is the most likely path for a `search_brain` 500;
  search's own alias writes already degrade. The fix is retryable `provider_unavailable` with reason
  `principal_state_unavailable`, still fail-closed. The new HTTP integration
  test, run against an unreachable database, returned 500 before the fix and
  503 after it.
- **Same gap in mutation targeting:** an update, append or delete whose target
  lookup lost its connection was recorded as `internal_error`. It is now
  `provider_unavailable` with reason `record_reference_store_unavailable`.
- **Already correct:** search's own alias writes already degrade to an
  honest partial result. That behaviour is now pinned by a regression test.
- **Still open (F13c):** other hot-path store calls still let a dropped
  connection become a 500: `openOperation` (persist and target changes),
  approval listing and resolution, elevation challenges, and some operation
  reads and transitions. They fail closed, and no partial state is written.
  Each needs its own test-first mapping. A blanket mapping in the store is
  wrong, because the mutation state machine treats some domain errors as
  definite outcomes.
- Trial 5 ran before the fix. One clean, about one-second restart in one run
  does not prove every in-flight request is handled during a longer outage.

### Backup and restore (observed)

- `pg_dump -Fc` of the trial database (702 operations, 14,036 audit outbox
  rows, 816 aliases) took **202 ms** and produced **0.81 MiB**. gzip saves
  almost nothing, because the custom format is already compressed.
- `pg_restore` into a fresh database took **226 ms**, and the row counts
  matched exactly.
- **Estimated growth:** about 0.6 MiB of dump per 10,000 audit events.
  Household use (assumed below 5,000 requests a month, about 2 audit events
  each) adds under 1 MiB a month, far inside the free Cloud Storage
  allowance. Delivered outbox rows are retained; pruning them is a later
  consideration, not a capacity problem.

### TLS proxy and logging overhead (observed)

- **Caddy (TLS termination and reverse proxy):** 13–17 MiB, under 1 % CPU at
  household load, and at most 13 % of a core while serving about 636
  requests/s of 429s.
- **TLS and proxy latency:** on the cheapest path (an immediate 429), p50 was
  3 ms end to end through TLS, so the proxy overhead is under 3 ms per request.
  That was with keep-alive, which amortizes handshakes, and through lima's port
  forwarding. New-connection handshake cost is not measured.
- **Fluent Bit:** 4–5 MiB and at most 2 % CPU. Its output was discarded, so
  Google's real logging agent (and its memory) is not measured; see below.

## Addendum 2026-10-28: the nginx ingress (F13c-3)

The owner chose nginx with request limits before Node (2026-10-27). The same
harness was rerun with Caddy replaced by the VM's own nginx configuration
(`deploy/vm/edge`, rendered by `sim-g-edge.sh`; self-signed certificate;
before the review fixes for body sizes, `/healthz` and the 429 shape),
plus a new phase: a flood from another address while the household client
keeps working. Same Colima profile (2 vCPU, 1 GiB; the stack's cgroup at 2
or 0.25 vCPU), synthetic data, Apple-silicon cores. Run directory outside
the repository; observed:

| Phase                            | CPU       | Requests/s | p50 / p95 / p99 ms | Outcome                                                                       |
| -------------------------------- | --------- | ---------: | ------------------ | ----------------------------------------------------------------------------- |
| Household                        | 2 vCPU    |       0.92 | 188 / 238 / 245    | 0 unexpected failures (403 and 404 are correct denials)                       |
| Household                        | 0.25 vCPU |       0.92 | 172 / 234 / 240    | 0 unexpected failures                                                         |
| Overload, one address            | 0.25 vCPU |     10,023 | 1 / 1 / 30         | 300,606 `429`s from nginx; about 3 requests/s reached the gateway             |
| Flood from another address, 70 s | 0.25 vCPU |    ~17,000 | n/a                | 1,205,645 `429`s; 139 reached the gateway (unauthenticated `401`s), about 2/s |
| Household during that flood      | 0.25 vCPU |       0.90 | 212 / 270 / 341    | 0 unexpected failures                                                         |
| Audit sink down (1 s think)      | 0.25 vCPU |       2.65 | 159 / 246 / 445    | 11 `429`s: the three synthetic members share one address, above 2 requests/s  |
| PostgreSQL restart (1 s think)   | 0.25 vCPU |       2.54 | 169 / 238 / 266    | 2 retryable `503`s (correct), 21 `429`s (shared address)                      |

- **Requests are now shed before Node.** At the same 0.25 vCPU, nginx
  answered about 10,000 `429`s a second from one address, where the
  gateway's own limiter had saturated the budget at 636. The stack's CPU was
  still saturated during floods (the cgroup throttled every period), but a
  household client on another address kept a p95 of 270 ms against 234 ms
  without the flood, with no failures.
- **nginx's cost:** at most 4.7 MiB, and up to the whole 0.25 vCPU budget
  while refusing floods. The gateway peaked at 98 MiB and PostgreSQL at
  48 MiB. The VM's minimum available memory, 420 MiB, includes the flood
  generator itself (83 MiB), which a real attacker would not run on the VM.
- **Startup and recovery:** gateway ready in 0.51 s, HTTPS through nginx in
  0.54 s; graceful stop 36 ms; restart ready in 0.69 s; a 319-event audit
  backlog drained in 31 s; dump and restore 83 and 66 ms with matching
  counts.
- **A household behind one address shares one bucket.** The per-address
  limit (2 requests/s, burst 30) equals the gateway's own steady rate, so
  three heavy users behind one home router, or one AI client issuing long
  bursts, can see `429`s (in this run nginx's were plain; since the review
  they carry `Retry-After` and the gateway's JSON shape). Normal household pacing did
  not. **[F13d check]** measure real client bursts before tuning.
- **The headroom phases no longer measure the stack's ceiling:** nginx caps
  the single load address first. The earlier figure (about 21 requests/s at
  0.25 vCPU, Apple silicon) stands. In each headroom phase, 12 requests (one
  per client) ended without a status after about 60 s; the cause was not
  determined, and no household phase had any.
- **Not measured:** real E2 CPUs, real TLS handshakes from many clients,
  Docker's DNAT on COS, and a flood large enough to fill the uplink, which
  only an upstream provider can absorb.

## What this does not prove (gates for F13d)

1. **Real e2-micro CPU.** The x86 shared-core vCPUs are slower than these
   cores, and E2 bursting works differently. Assuming they are 2–3× slower
   (an estimate, not measured), household load would still use only about
   0.06–0.09 vCPU on average. Saturation throughput would fall to about 7–10
   requests/s.
2. **The real OS and logging agent.** The memory of the production image
   (for example Container-Optimized OS with its logging agent, or Debian with
   the Ops Agent) must be measured on the VM. The 445 MiB minimum free leaves
   room for it, but not unlimited room.
3. **Real providers and identity:**
   - Notion and Drive latency and errors;
   - the root ancestry walks at startup;
   - Secret Manager reads;
   - Google JWKS fetches;
   - ACME certificate issuance.
4. **The production database transport.** Today production accepts only TLS
   TCP or a `/cloudsql/` socket. Draft PR #79 (held for owner review) adapts
   this to the local socket.
5. **The amd64 image.** Only the arm64 image was built and run; the amd64
   production build is exercised by CI's container job, not by this run.
6. **Ingress protection.** Connection and rate limits before Node, as above.
7. **Longer horizons.** A long soak or memory-leak test, extended database
   outages, disk-full behaviour, and host patch reboots.

## Recommendation

Keep the selected e2-micro target and proceed to F13c, the VM design and
offline scaffolding. Do not change machine type or architecture. The cost
model's main risk is the free-tier allowance, not capacity: the expected total
is about USD 4.2–4.9 a month, but it rises above USD 10 if another VM already
uses the billing account's e2-micro allowance.
