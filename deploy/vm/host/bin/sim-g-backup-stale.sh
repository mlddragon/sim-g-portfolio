#!/usr/bin/env bash
# The recent backup tier's staleness check (recovery point investigation,
# section 5), run every 15 minutes by sim-g-backup-stale.timer.
#
# Reports backup_stale when the last recent-tier success is more than 35
# minutes old (two consecutive missed runs), or when its marker is missing
# or invalid. It stays quiet for 35 minutes after boot, whatever the marker
# says; the uptime check covers the outage itself. It never pauses for
# operator maintenance: a forgotten maintenance file must not silence it.
#
# Prints one JSON line; exits 1 when stale. Alerting on the line arrives
# with the VM design's section 11 slice.
set -euo pipefail

marker="${SIM_G_BACKUP_MARKER:-/var/lib/sim-g/backup-recent.last}"
uptime_file="${SIM_G_UPTIME_FILE:-/proc/uptime}"
threshold=2100
grace=2100
# Tolerated clock difference for a marker that appears to be in the future.
skew=300

stale() { # reason [age]
  printf '{"severity":"ERROR","msg":"backup_stale","reason":"%s"%s}\n' "$1" "${2:+,\"age_seconds\":$2}"
  exit 1
}

now="$(date -u +%s)"
# An unreadable uptime is not a reason to stay quiet.
uptime="$(cut -d. -f1 "${uptime_file}" 2>/dev/null || true)"
if [[ "${uptime}" =~ ^[0-9]{1,12}$ ]] && ((10#${uptime} < grace)); then
  printf '{"severity":"INFO","msg":"backup_stale_check_deferred","reason":"boot_grace"}\n'
  exit 0
fi

[[ ! -L "${marker}" ]] || stale marker_invalid
[[ -e "${marker}" ]] || stale marker_missing
[[ -f "${marker}" ]] || stale marker_invalid
completed="$(head -c 32 "${marker}" 2>/dev/null | tr -d '\n')" || stale marker_invalid
# Exactly what date +%s writes: no sign, no leading zero (never octal).
[[ "${completed}" =~ ^[1-9][0-9]{0,11}$ ]] || stale marker_invalid
age=$((now - completed))
((age >= -skew)) || stale marker_invalid
((age <= threshold)) || stale backup_too_old "${age}"
((age >= 0)) || age=0
printf '{"severity":"INFO","msg":"backup_recent_fresh","age_seconds":%s}\n' "${age}"
