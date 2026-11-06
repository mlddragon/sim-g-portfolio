# Ingress (nginx) on the e2-micro VM

The ingress is nginx, the VM's only published service (owner decision
2026-10-27; VM design sections 3 and 4). It terminates TLS for the one
configured host name and limits requests before they reach the gateway.
Nothing here is deployed: it is checked offline only, and the real-VM checks
belong to F13d.

## Pieces

| Piece                                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/vm/edge/nginx.conf`                             | The nginx configuration: limits, timeouts, forwarding headers, port 80 and the 443 default server that refuses unknown names. `@DOMAIN@` and `@UPSTREAM@` are its only substitutions.                                                                                                                                                                                                                                                                                                 |
| `deploy/vm/edge/site.conf`                              | The TLS server for the host name, included only once its certificate exists.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `deploy/vm/edge/nginx.Dockerfile`, `certbot.Dockerfile` | The two images: the pinned upstream nginx (unprivileged) and certbot, with Alpine's (and certbot's Python libraries') security updates applied at build time; certbot without pip or uv. CI builds and scans both (fixable HIGH and CRITICAL fail); the deploy workflow builds them for linux/amd64 and pushes them by digest to the project's Artifact Registry, and the host settings name only those copies. The unpatched upstream images had fixable HIGH findings (2026-10-28). |
| `sim-g-edge.service`                                    | Renders the configuration (`sim-g-edge.sh`) and runs nginx as uid 101: read-only, no capabilities, no new privileges, 96 MiB, 64 processes. It publishes 443 and 80 only, on `sim-g-edge-egress`, and joins `sim-g-internal` to reach the gateway at `172.31.250.2:8080`.                                                                                                                                                                                                             |
| `sim-g-certificate.timer`                               | Twice a day (and 2 to 62 minutes after boot: the random delay applies to every trigger), `sim-g-certificate.sh` runs certbot, also as uid 101, read-only and without capabilities, on the edge bridge. It obtains or renews the Let's Encrypt certificate through the HTTP-01 webroot, renewing only within 30 days of expiry.                                                                                                                                                        |
| `sim-g-firewall.service`                                | Adds `SIM-G-INGRESS`: per source, at most 20 new connections a second (burst 40) and 32 open at once, to nginx's published ports only.                                                                                                                                                                                                                                                                                                                                                |

## Limits before Node

Every request zone is keyed on the TCP peer (`$binary_remote_addr`) or the
server, never on a header, so a forged `X-Forwarded-For` cannot move a client
to another bucket.

| Zone            | Rate and burst            | Purpose                                                                                                                               |
| --------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `per_ip`        | 2 requests/s, burst 30    | The gateway's own steady rate (120 a minute), with a smaller burst than its fixed window; a flood stops here.                         |
| `all_clients`   | 15 requests/s, burst 60   | Across every address, below the measured saturation of 0.25 vCPU (F13b), so a flood spread over many addresses cannot exhaust the VM. |
| `health_per_ip` | 2 requests/s, burst 10    | `/healthz` (the exact URI only), so the uptime check has its own bucket; `all_clients` applies too.                                   |
| `conn_per_ip`   | 16 concurrent connections | Per address, beside the firewall's connection limits.                                                                                 |

Rejections are `429` with `Retry-After: 1` and the gateway's own JSON shape
(`rate_limited`, reason `ingress_rate_limited`), and are not logged (the
error log is at `warn`), so a flood cannot flood the log path.

**Sizes.** Bodies are limited to the gateway's default 64 KiB, except its
three content mutations (`persist_knowledge`, `update_record`,
`append_to_record`), which accept the gateway's 2 MiB and stream to it
without buffering to nginx's `/tmp`. Responses are never buffered to disk.
Header buffers (2 × 20 KiB) fit the gateway's longest accepted bearer token (16,384 characters) while bounding nginx's memory under many connections.
A request whose `Host` differs from the name it shook hands with is closed
without a response.

**Uploads are not buffered.** A content mutation's body streams to the
gateway, whose request timeout (its 25 s operation timeout plus 5 s) then
bounds the upload: 2 MiB needs roughly 560 kbit/s sustained, or the gateway
answers 408. A slow uploader holds one gateway socket for at most that long.

**What nginx answers itself is limited by the firewall only.** nginx runs
`return` before its request limits, so port-80 redirects, the disguised
`/healthz` 404s and the 444 closes are bounded by `SIM-G-INGRESS`'s
connection limits, not by `per_ip`. None reaches the gateway. Its own 413s
and 404s are plain nginx responses, not the gateway's JSON. A spread flood can still crowd out household
users through `all_clients`; it protects the VM, not availability.

## Forwarding headers

The gateway trusts exactly one hop (`GATEWAY_TRUSTED_PROXY_HOPS=1`): nginx.
nginx replaces `X-Forwarded-For` with the TCP peer, never appends to it, sets
`X-Forwarded-Proto https` and the fixed `Host`, and clears `X-Forwarded-Host`,
`X-Forwarded-Port`, `X-Real-IP` and `Forwarded`. Whether Docker keeps the
client's source address on the VM (iptables DNAT rather than the userland
proxy) is an **F13d check**: the gateway's logs must show real client
addresses.

## Certificates

- **Bootstrap:** until the certificate exists, nginx answers only port 80
  (validation files and redirects), and 443 refuses every handshake. The
  certificate script restarts the ingress once it has the first certificate,
  and reloads nginx (`SIGHUP`) after a renewal.
- **Owner step:** the owner accepts the
  [Let's Encrypt Subscriber Agreement](https://letsencrypt.org/repository/)
  by setting `SIM_G_ACME_TERMS=agreed` in the host settings. Until then the
  script requests nothing and fails with `acme_terms_not_accepted`. The
  account is registered without an email address.
- **DNS:** the A record must point at the VM, and a CAA record should allow
  only `letsencrypt.org`. No DNS change is authorized by this repository.
- **Failure:** any failure logs `certificate_renewal_failed` with a fixed
  reason, which the operational-event alert (F13c-5d) picks up (VM design
  section 11). certbot's own errors reach the unit's journal. Before the
  terms are accepted, the script logs `certificate_not_requested` and does
  not page. The lineage is pinned with `--cert-name`, so a lost renewal
  configuration cannot start a second lineage.
  A certificate is valid for 90 days, so renewals have about 60 days of
  retries.
- **State:** certificates and the ACME account live on the data disk
  (`/mnt/disks/data/sim-g/edge/certs`, owned by uid 101); the webroot is on
  tmpfs. nginx mounts only `live/` and `archive/`, never the ACME account
  key.

## Offline checks

```sh
pnpm edge:check   # the real pinned nginx with the rendered configuration
pnpm host:check   # rendering, units, settings, certbot steps and the firewall
```

`pnpm edge:check` runs nginx exactly as hardened on the VM, behind an
upstream that counts what reaches it, and checks:

- request limits act before the upstream, per client and across clients;
- forged forwarding headers neither change the limits nor reach the upstream;
- port 80 serves validation files and redirects to the fixed name;
- 443 refuses unknown or missing names, and every name before the
  certificate exists.

A self-signed certificate stands in for Let's Encrypt; certbot's real
exchange is an **F13d check**. The capacity harness
(`scripts/capacity/run-e2-micro.sh`) runs the same rendered configuration and
measures a household client during a flood from another address.
