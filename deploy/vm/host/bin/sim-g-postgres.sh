#!/usr/bin/env bash
# PostgreSQL (VM design section 6): no network, no TCP listener, uid 70, a
# read-only root and the shipped socket-only authentication rules. The data
# directory must already be bootstrapped (docs/runbooks/vm-host.md); this unit
# never runs initdb, so it never needs the superuser password.
set -euo pipefail

data=/mnt/disks/data/postgres
socket=/run/sim-g/postgresql

fail() {
  printf '{"severity":"ERROR","msg":"postgres_failed","reason":"%s"}\n' "$1"
  exit 1
}

# During operator work (bootstrap, restores) a second server must never start
# on the same data directory: PostgreSQL's own lock cannot see across
# containers.
[[ ! -e /run/sim-g/maintenance ]] || fail maintenance_mode
[[ -f "${data}/PG_VERSION" ]] || fail postgres_not_bootstrapped
# Owned by the server (the image's entrypoint then makes it 3775, writable
# only by uid and gid 70), so nothing else can plant a socket while
# PostgreSQL is down.
install -d -m 0755 -o 70 -g 70 "${socket}"

# Its log (json-file, shipped by the logging agent) never carries row
# values: terse errors drop DETAIL and CONTEXT lines (a failed COPY's whole
# row, a duplicate key's value), and failing statements are not logged.
exec docker run --rm --name sim-g-postgres --network none \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges --user 70:70 \
  --memory 256m --memory-swap 256m --pids-limit 128 --tmpfs /tmp:size=16m \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
  --volume "${data}:/var/lib/postgresql/data" --volume "${socket}:/run/postgresql" \
  "${SIM_G_POSTGRES_IMAGE}" \
  postgres -c listen_addresses= -c hba_file=/etc/sim-g/pg_hba.conf \
  -c ident_file=/etc/sim-g/pg_ident.conf -c shared_buffers=64MB \
  -c max_connections=25 -c work_mem=2MB \
  -c log_error_verbosity=terse -c log_min_error_statement=panic
