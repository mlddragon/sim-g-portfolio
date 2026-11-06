#!/usr/bin/env bash
# A fresh encrypted backup (through its own unit, so it never overlaps the
# timer's run), then the compiled migration command as the migrator (uid
# 9002, peer authentication, no password anywhere), then the runtime grants
# (VM design section 6). Each step runs only if the previous one succeeded.
#
# It migrates with SIM_G_GATEWAY_IMAGE, which the deploy watcher sets to the
# new image before anything runs it. One run at a time (a lock), and the exit
# status tells a caller what failed:
#   1 = migrations or grants (the image's fault);
#   3 = the backup (retry later);
#   4 = another migration is running (retry later);
#   5 = Docker itself failed to run a container (exit 125; retry later).
set -euo pipefail

socket=/run/sim-g/postgresql

fail() {
  printf '{"severity":"ERROR","msg":"migrate_failed","reason":"%s"}\n' "$1"
  exit "${2:-1}"
}

mkdir -p /run/sim-g
exec 9>/run/sim-g/migrate.lock
flock -n 9 || fail migrate_busy 4

systemctl start sim-g-backup.service || fail migrate_backup_failed 3

job=(docker run --rm --network none --read-only --cap-drop=ALL
  --security-opt=no-new-privileges --user 9002:9002
  --memory 256m --memory-swap 256m --pids-limit 64
  --volume "${socket}:/run/postgresql:ro")

# Docker's own failure (125) is not the image's.
step() { # reason command...
  local reason="$1" status=0
  shift
  "$@" || status=$?
  [[ "${status}" -eq 0 ]] && return 0
  [[ "${status}" -eq 125 ]] && fail migrate_docker_failed 5
  fail "${reason}"
}

step migrate_migrations_failed "${job[@]}" \
  --env GATEWAY_MIGRATION_DATABASE_URL='postgresql://gateway_migrator@/family_brain_gateway?host=/run/postgresql' \
  "${SIM_G_GATEWAY_IMAGE}" node dist/migration-cli.js

step migrate_grants_failed "${job[@]}" "${SIM_G_POSTGRES_IMAGE}" \
  psql --host=/run/postgresql --username=gateway_migrator --dbname=family_brain_gateway \
  --no-password --quiet -v ON_ERROR_STOP=1 -f /etc/sim-g/grant-runtime.sql
printf '{"severity":"INFO","msg":"migrate_completed"}\n'
