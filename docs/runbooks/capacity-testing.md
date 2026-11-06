# Synthetic e2-micro capacity testing

`scripts/capacity/run-e2-micro.sh` measures the complete single-VM stack under
e2-micro-like limits with fictional data only (F13b). It creates no cloud
resource and uses no credential. Its results are **preliminary local
evidence**, not proof of Compute Engine performance.

## What runs

The script expects or creates a Colima VM named `sim-g-e2micro` with 2 vCPUs,
1 GiB of memory and a 20 GB disk. Inside it, these containers share one
network namespace, so everything is loopback, as on a single VM:

| Container     | Role                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cap-net`     | Owns the network namespace, so PostgreSQL can restart without dropping loopback.                                                                            |
| `cap-db`      | PostgreSQL 17 (pinned digest), listening on `127.0.0.1` only. Tuned for 1 GiB: `shared_buffers=64MB`, `max_connections=25`, `work_mem=2MB`.                 |
| `cap-gateway` | The capacity image: the production image plus the harness. Runs read-only, with no capabilities and no new privileges, and logs through the Fluentd driver. |
| `cap-tls`     | nginx (pinned digest) with the VM's rendered ingress configuration and a self-signed certificate, proxying to `127.0.0.1:8081`.                             |
| `cap-logs`    | Fluent Bit (pinned digest) receiving the gateway's stdout. Its output is discarded.                                                                         |

All containers are in one cgroup. Its `cpu.max` switches between `max` (the
VM's 2 vCPUs, standing in for e2-micro bursting) and `25000 100000` (0.25 vCPU,
the e2-micro sustained baseline).

`tests/capacity/gateway-under-test.ts` runs the real `main()`. These parts are
real:

- configuration, policy, environment secrets and the PostgreSQL pool and
  store;
- Google OIDC RS256 verification against a per-run synthetic key;
- authorization, routing and audit, Fastify, and Cloud Logging stdout;
- the in-process audit delivery loop.

These parts are synthetic:

- the Notion, Drive and GitHub providers: in-memory, about 150 ms ± 50 %
  latency, and 500 fictional records each;
- the approval projection;
- an audit sink that `/run/capacity/audit-sink-down` turns off.

`CAPACITY_RATE_LIMITS=raised` lifts the gateway's per-minute limits. That is
needed only because every synthetic user shares one source address. It is
used solely for the clearly labelled headroom phases. nginx's own limits stay
in force, so since F13c-3 those phases show nginx shedding load, not the
stack's ceiling.

`tests/capacity/load.ts` runs on the host. It signs Google-shaped tokens for
the three fictional `example.invalid` principals and drives a weighted mix:
search 5, fetch 3, persist 1, list approvals 1.

## Phases

1. Startup to healthy, then HTTPS through nginx (with the test name as SNI).
2. A smoke check: authenticated requests must all succeed, or the run stops.
3. Household load at burst CPU, then at 0.25 vCPU. Three users each send a
   request about every 3 s, under the production limits.
4. Overload at production limits. Twelve clients with no think time expect
   429s, now mostly from nginx.
5. A flood from another address (`tests/capacity/flood.mjs`, 32 connections
   for 70 s, inside the stack's network namespace but outside its CPU
   cgroup) while household load continues: nginx must shed it before the
   gateway, and the household client's latency is recorded. The flood's
   status counts land in `flood.json`.
6. A graceful gateway stop (SIGTERM), then a restart with raised limits.
7. Headroom: twelve clients with no think time, at burst CPU and at 0.25 vCPU,
   followed by household load again.
8. An audit sink outage under household load, then the drain time once
   restored.
9. A PostgreSQL restart about 30 s into household load.
10. `pg_dump`, then restore into a new database, comparing row counts.

Builds use the default `colima` profile. The script checks that
`sim-g-e2micro` really is 2 vCPU / 1 GiB, and restores your Docker context on
exit. Stop the small VM afterwards with `colima stop --profile sim-g-e2micro`.

## Outputs

Each run writes to `~/.cache/sim-g-capacity/<UTC timestamp>/`, outside the
repository: `summary.json`, `load.jsonl`, `cpu.jsonl` (cgroup CPU counters and
throttling per phase), `samples.txt` (memory and CPU every few seconds),
startup, restart, audit and backup timings, the synthetic key pair, and the
synthetic backup. Never commit them. Copy the relevant figures into the
capacity report instead.

## Reading results

- **Policy denials are not failures.** `record_not_found` means a record
  outside the caller's scope. `role_operation_forbidden` means Participant
  listing approvals.
- **CPU figures are optimistic.** Apple-silicon arm64 cores are faster than
  e2's shared x86 vCPUs, and the cgroup model does not reproduce E2's burst
  accounting.
- **Memory figures transfer better**, but the Colima guest (Ubuntu, dockerd,
  the lima agent) only approximates the production OS and agents.
- **Not measured:**
  - real provider latency and errors;
  - Secret Manager reads;
  - Notion and Drive root-ancestry walks at startup;
  - Google's logging agent;
  - ACME;
  - the production database transport.

  Each is still a gate for the bounded cloud trial (F13d).
