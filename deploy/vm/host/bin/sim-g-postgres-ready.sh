#!/usr/bin/env bash
# ExecStartPost of sim-g-postgres: the unit becomes active only once the
# server answers on its socket, so units ordered after it (the gateway, the
# backup, migrations) never meet a missing socket.
set -euo pipefail

attempts="${SIM_G_READY_ATTEMPTS:-60}"
# docker run pulls the image first: on a new boot disk (a COS image
# replacement) that alone took 160 s in the rehearsal, so the readiness
# attempts start only once the container exists, within this budget (in
# seconds, so with the attempts it stays inside the unit's 12 minutes).
pull_seconds="${SIM_G_PULL_SECONDS:-540}"

fail() {
  printf '{"severity":"ERROR","msg":"postgres_failed","reason":"%s"}\n' "$1"
  exit 1
}

[[ "${pull_seconds}" =~ ^[1-9][0-9]{0,3}$ ]] || fail invalid_pull_seconds
# systemd passes the start command's PID: once it has exited (a failed pull
# or server), waiting longer cannot help.
running() { [[ -z "${MAINPID:-}" ]] || kill -0 "${MAINPID}" 2>/dev/null; }
deadline=$((SECONDS + 10#${pull_seconds}))
until docker container inspect sim-g-postgres >/dev/null 2>&1; do
  running || fail postgres_not_started
  ((SECONDS < deadline)) || fail postgres_not_started
  sleep 1
done
for ((attempt = 1; attempt <= attempts; attempt++)); do
  running || fail postgres_not_ready
  if docker exec sim-g-postgres pg_isready --host=/run/postgresql --quiet; then
    exit 0
  fi
  sleep 1
done
fail postgres_not_ready
