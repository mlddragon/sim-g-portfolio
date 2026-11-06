#!/usr/bin/env bash
# Ships the host units' structured lines to Cloud Logging (VM design section
# 11), run every minute by sim-g-log-ship.timer.
#
# COS's own logging agent reads the journal only for its system units and at
# priority warning or worse (F13d Stage A), and the host scripts print their
# JSON lines to stdout, which systemd records at priority info. So this reads
# exactly what COS leaves behind: sim-g services, priority notice to debug,
# and only flat JSON objects in the host scripts' shape. Each is written
# with its own severity, as jsonPayload, so the alert filters read
# jsonPayload.msg. Text lines (systemd's, Docker's or a tool's) never ship.
#
# The journal is the buffer: the position advances only after Cloud Logging
# accepts a batch, so an outage is caught up later, and a resent line keeps
# its insertId. The runtime account writes with its logging.logWriter role,
# as COS's agent does. A failure is printed at priority err, which COS's
# agent ships itself; a shipper that never runs stops the recent backup
# lines, which the off-VM missing-backup alert catches. It prints nothing on
# success, so it never feeds itself.
set -euo pipefail

state="${SIM_G_LOG_SHIP_STATE:-/var/lib/sim-g/log-ship.position}"
metadata="${SIM_G_METADATA_URL:-http://metadata.google.internal/computeMetadata/v1}"
endpoint="${SIM_G_LOGGING_URL:-https://logging.googleapis.com/v2/entries:write}"
uptime_file="${SIM_G_UPTIME_FILE:-/proc/uptime}"
# Cloud Logging accepts far larger requests; 100 lines keep each one small.
# At most two batches a run, so a run stays well inside the unit's 50
# seconds (4 metadata reads of 3 s, 2 posts of 15 s); a backlog continues
# the next minute.
batch=100
batches=2

fail() {
  # <3>: journald records this line at priority err.
  printf '<3>{"severity":"ERROR","msg":"log_ship_failed","reason":"%s"}\n' "$1"
  exit 1
}

# One flat JSON object in the host scripts' shape: severity, then msg, then
# lowercase keys with string, integer or boolean values. A string holds no
# quote, backslash or control character, so the line is valid JSON as it
# stands and is sent unchanged.
event_re='^\{"severity":"(DEBUG|INFO|NOTICE|WARNING|ERROR|CRITICAL)","msg":"[a-z][a-z0-9_]{0,63}"(,"[a-z][a-z0-9_]{0,63}":("[^"\\[:cntrl:]]*"|-?(0|[1-9][0-9]{0,17})|true|false))*\}$'

host_event() { # line
  [[ ${#1} -le 4096 && "$1" =~ ${event_re} ]]
}

# The real token may only go to Google or, for the offline check, loopback.
loopback='^http://127\.0\.0\.1:[0-9]{1,5}/'

meta() { # path
  curl -sf --max-time 3 -H 'Metadata-Flavor: Google' "${metadata}/$1"
}

# Posts <body>; fails, at priority err, unless Cloud Logging accepts it. A
# connection failure or timeout reports status 000.
post() { # body token
  local status
  status="$(printf 'header = "Authorization: Bearer %s"\n' "$2" |
    curl -s --max-time 15 --config - -o /dev/null -w '%{http_code}' \
      -H 'Content-Type: application/json' --data-binary "@$1" "${endpoint}")" || true
  [[ "${status}" == 200 ]] || fail "log_ship_http_${status:-000}"
}

main() {
  [[ "${endpoint}" == https://logging.googleapis.com/v2/entries:write || "${endpoint}" =~ ${loopback} ]] ||
    fail log_ship_endpoint_refused
  [[ "${metadata}" == http://metadata.google.internal/* || "${metadata}" =~ ${loopback} ]] ||
    fail log_ship_endpoint_refused

  # The position: the newest shipped line's time, in microseconds. It is on
  # the stateful partition, so it survives reboots; without one (lost, or a
  # new boot disk), everything since boot. A position more than 5 minutes
  # ahead of the clock would silently drop lines, so it fails instead.
  local position=0 since now
  now="$(date -u +%s)"
  if [[ -f "${state}" && ! -L "${state}" ]]; then
    position="$(head -c 32 "${state}" | tr -d '\n')"
    [[ "${position}" =~ ^[1-9][0-9]{15}$ ]] || fail log_ship_position_invalid
    ((10#${position} / 1000000 <= now + 300)) || fail log_ship_position_invalid
    since="$((10#${position} / 1000000))"
  else
    local uptime
    uptime="$(cut -d. -f1 "${uptime_file}")"
    [[ "${uptime}" =~ ^[0-9]{1,12}$ ]] || fail log_ship_uptime_invalid
    since="$((now - 10#${uptime}))"
  fi

  install -d -m 0755 -o 0 -g 0 "$(dirname "${state}")" || fail log_ship_position_write_failed
  local work
  work="$(mktemp -d)" || fail log_ship_work_failed
  # shellcheck disable=SC2064 # expand now: work is local
  trap "rm -rf '${work}'" EXIT
  journalctl --no-pager --quiet --output=short-unix --priority=5..7 \
    --unit='sim-g-*.service' --since "@${since}" ${SIM_G_JOURNAL_FILE:+"--file=${SIM_G_JOURNAL_FILE}"} \
    >"${work}/lines" || fail log_ship_journal_unavailable

  local project instance zone token="" header
  local line stamp micros message severity n=0 sent=0 last=0
  while IFS= read -r line; do
    stamp="${line%% *}"
    [[ "${stamp}" =~ ^[1-9][0-9]{9}\.[0-9]{6}$ ]] || continue
    micros="${stamp/./}"
    # --since only seeks: a line stamped earlier (a clock step) can still
    # follow, so the window is checked here, against the position this run
    # started from (the snapshot is in journal order).
    ((10#${micros} > 10#${position} && 10#${micros} >= since * 1000000)) || continue
    # After the time, the host name and the identifier ("bash[42]: ").
    message="${line#* }"
    message="${message#*: }"
    host_event "${message}" || continue
    severity="${BASH_REMATCH[1]}"
    # After the last batch of this run, only a line sharing the newest
    # line's microsecond still goes (the next run starts after it).
    ((sent < batches || 10#${micros} == 10#${last})) || break

    if [[ -z "${token}" ]]; then
      project="$(meta project/project-id)" || fail log_ship_metadata_unavailable
      instance="$(meta instance/id)" || fail log_ship_metadata_unavailable
      zone="$(meta instance/zone)" || fail log_ship_metadata_unavailable
      zone="${zone##*/}"
      [[ "${project}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ && "${instance}" =~ ^[0-9]{1,20}$ &&
        "${zone}" =~ ^[a-z]+-[a-z]+[0-9]+-[a-z]$ ]] || fail log_ship_metadata_invalid
      token="$(meta instance/service-accounts/default/token |
        sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')" || fail log_ship_token_unavailable
      [[ -n "${token}" ]] || fail log_ship_token_unavailable
      header="$(printf '{"logName":"projects/%s/logs/sim-g-host","resource":{"type":"gce_instance","labels":{"project_id":"%s","instance_id":"%s","zone":"%s"}},"entries":[' \
        "${project}" "${project}" "${instance}" "${zone}")"
    fi

    if ((n == 0)); then
      printf '%s' "${header}" >"${work}/body"
    else
      printf ',' >>"${work}/body"
    fi
    printf '{"insertId":"%s","timestamp":"%s.%sZ","severity":"%s","jsonPayload":%s}' \
      "$(printf '%s %s' "${stamp}" "${message}" | sha256sum | cut -c1-32)" \
      "$(date -u -d "@${stamp%.*}" +%Y-%m-%dT%H:%M:%S)" "${stamp#*.}" \
      "${severity}" "${message}" >>"${work}/body"
    n=$((n + 1))
    ((10#${micros} > 10#${last})) && last="${micros}"

    if ((n == batch)); then
      printf ']}' >>"${work}/body"
      post "${work}/body" "${token}"
      save "${last}"
      n=0
      sent=$((sent + 1))
    fi
  done <"${work}/lines"

  if ((n > 0)); then
    printf ']}' >>"${work}/body"
    post "${work}/body" "${token}"
    save "${last}"
  fi
}

save() { # micros
  local temporary
  temporary="$(mktemp "${state}.XXXXXX")" || fail log_ship_position_write_failed
  if ! { printf '%s\n' "$1" >"${temporary}" && chmod 0600 "${temporary}" && mv -fT "${temporary}" "${state}"; }; then
    rm -f "${temporary:?}"
    fail log_ship_position_write_failed
  fi
}

# Sourcing defines the functions only (the offline checks use host_event).
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
