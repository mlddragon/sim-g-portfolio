#!/usr/bin/env bash
# Run by sim-g-recover.timer. systemd does not restart a unit whose
# dependency failed (a disk that appeared late, a one-off firewall error), so
# this starts the workloads again. Starting an active unit does nothing.
# During operator work, `touch /run/sim-g/maintenance` pauses it until the
# file is removed or the VM reboots.
set -euo pipefail

[[ -e /run/sim-g/maintenance ]] && exit 0
systemctl start --no-block sim-g-postgres.service sim-g-gateway.service sim-g-edge.service sim-g-certificate.timer sim-g-backup.timer sim-g-backup-recent.timer sim-g-backup-stale.timer sim-g-log-ship.timer
