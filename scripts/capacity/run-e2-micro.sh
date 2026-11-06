#!/usr/bin/env bash
# F13b synthetic e2-micro capacity run (preliminary evidence only).
#
# Runs the complete single-VM stack inside a dedicated Colima VM sized like an
# e2-micro (2 vCPU, 1 GiB), all on loopback in one network namespace:
#   - the gateway (capacity image: production image plus synthetic harness);
#   - PostgreSQL 17, listening on 127.0.0.1 only;
#   - the nginx ingress, rendered from deploy/vm/edge exactly as on the VM
#     (self-signed certificate);
#   - a log agent (Fluent Bit) receiving the gateway's stdout.
# The containers share one cgroup whose CPU limit switches between the e2-micro
# burst (2 vCPU) and its sustained baseline (0.25 vCPU).
#
# Synthetic data only. Inputs, raw samples and the backup land in a run
# directory outside the repository. No cloud resource is touched.
#
# Caveats recorded with every result: Apple-silicon arm64 cores are faster than
# e2's shared x86 vCPUs, so CPU-bound numbers are optimistic. The Colima guest
# (Ubuntu, dockerd, lima agent) stands in for the VM's OS and container runtime.
set -euo pipefail

cd "$(dirname "$0")/../.."

profile="sim-g-e2micro"
context="colima-${profile}"
docker_vm=(docker --context "${context}")
run_dir="${CAPACITY_RUN_DIR:-${HOME}/.cache/sim-g-capacity/$(date -u +%Y%m%dT%H%M%SZ)}"
records="${CAPACITY_RECORDS:-500}"
latency_ms="${CAPACITY_PROVIDER_LATENCY_MS:-150}"

postgres_image="postgres:17.11-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb"
nginx_image=sim-g-edge:capacity
edge_domain=capacity.sim-g.test
fluentbit_image="fluent/fluent-bit:5.1.3@sha256:c5542543523c9678398dd78d927c05e8425ec15b038f226b67b3b019b1a70845"

mkdir -p "${run_dir}"
chmod 700 "${run_dir}"
echo "run directory: ${run_dir}" >&2

# Builds use the default Colima profile (as CI would build off the VM); the
# measured stack runs in the e2-micro-sized profile, never resized here.
original_context="$(docker context show)"
colima status --profile "${profile}" >/dev/null 2>&1 || \
  colima start --profile "${profile}" --cpu 2 --memory 1 --disk 20 --vm-type vz
docker context use "${original_context}" >/dev/null # starting a profile switches it
vm() { colima --profile "${profile}" ssh -- "$@"; }
vm_cpus="$(vm nproc)"
vm_mem_kib="$(vm sh -c "awk '/MemTotal/ {print \$2}' /proc/meminfo")"
if [[ "${vm_cpus}" != 2 ]] || (( vm_mem_kib > 1048576 )); then
  echo "profile ${profile} must be 2 vCPU / 1 GiB (found ${vm_cpus} vCPU, ${vm_mem_kib} KiB)" >&2
  exit 1
fi
# Every wait is bounded, so a broken run fails instead of hanging.
wait_for() { # seconds description command...
  local limit="$1" what="$2" deadline=$(( $(date +%s) + $1 ))
  shift 2
  until "$@" >/dev/null 2>&1; do
    if (( $(date +%s) > deadline )); then
      echo "timed out after ${limit}s waiting for ${what}" >&2
      exit 1
    fi
    sleep 0.2
  done
}

# --- Build (on the larger default VM, as CI would) ---------------------------
pnpm exec tsx tests/capacity/write-run-inputs.ts "${run_dir}"
rm -rf dist-capacity
pnpm exec tsc -p tsconfig.capacity.json
stage="${run_dir}/stage"
rm -rf "${stage}" && mkdir -p "${stage}"
cp -R dist-capacity "${stage}/dist-capacity"
cp -R migrations "${stage}/migrations"
cp "${run_dir}/gateway.json" "${stage}/gateway.json"
docker --context colima build --quiet --tag family-brain-gateway:capacity-base . >/dev/null
docker --context colima build --quiet --file tests/capacity/Dockerfile \
  --build-arg GATEWAY_IMAGE=family-brain-gateway:capacity-base \
  --tag family-brain-gateway:capacity "${stage}" >/dev/null
docker --context colima save family-brain-gateway:capacity | "${docker_vm[@]}" load --quiet >/dev/null
docker --context colima build --quiet --file deploy/vm/edge/nginx.Dockerfile \
  --tag "${nginx_image}" deploy/vm/edge >/dev/null
docker --context colima save "${nginx_image}" | "${docker_vm[@]}" load --quiet >/dev/null
for image in "${postgres_image}" "${fluentbit_image}"; do
  "${docker_vm[@]}" pull --quiet "${image}" >/dev/null
done

# --- One cgroup for the whole stack -----------------------------------------
vm sudo sh -c 'mkdir -p /sys/fs/cgroup/e2micro && echo "+cpu +memory" > /sys/fs/cgroup/cgroup.subtree_control && echo "+cpu +memory" > /sys/fs/cgroup/e2micro/cgroup.subtree_control'
cpu_limit() { vm sudo sh -c "echo '$1' > /sys/fs/cgroup/e2micro/cpu.max"; }
cpu_limit "max 100000" # burst: the VM's 2 vCPUs

cleanup() {
  "${docker_vm[@]}" rm -f cap-flood cap-tls cap-gateway cap-db cap-logs cap-net >/dev/null 2>&1 || true
  "${docker_vm[@]}" volume rm -f cap-pgdata cap-edge-conf cap-edge-certs cap-flood >/dev/null 2>&1 || true
}
cleanup
# Only real job ids: `kill 0` would signal this script's own process group.
stop_jobs() { local pid; for pid in "${sampler:-}" "${restart_job:-}" "${flood_job:-}"; do [[ "${pid}" =~ ^[1-9][0-9]*$ ]] && kill "${pid}" 2>/dev/null; done; return 0; }
trap 'stop_jobs; cleanup; docker context use "${original_context}" >/dev/null' EXIT

# Synthetic, this run only. Passed by name (-e VAR), never on a command line,
# so it does not appear in host process listings.
password="$(openssl rand -hex 24)"
export POSTGRES_PASSWORD="${password}"
export DATABASE_URL="postgresql://capacity:${password}@127.0.0.1:5432/family_brain_gateway_capacity"
common=(--cgroup-parent=/e2micro --security-opt=no-new-privileges)

# Network namespace owner, so PostgreSQL can restart without dropping loopback.
"${docker_vm[@]}" run -d --name cap-net "${common[@]}" -p 127.0.0.1:8443:8443 \
  --no-healthcheck --entrypoint sleep family-brain-gateway:capacity infinity >/dev/null
"${docker_vm[@]}" run -d --name cap-logs "${common[@]}" -p 127.0.0.1:24224:24224 \
  "${fluentbit_image}" /fluent-bit/bin/fluent-bit -q -f 1 \
  -i forward -p port=24224 -p mem_buf_limit=16M -o null -m '*' >/dev/null
"${docker_vm[@]}" run -d --name cap-db "${common[@]}" --network container:cap-net \
  -v cap-pgdata:/var/lib/postgresql/data \
  -e POSTGRES_USER=capacity -e POSTGRES_PASSWORD \
  -e POSTGRES_DB=family_brain_gateway_capacity \
  -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 \
  "${postgres_image}" postgres -c listen_addresses=127.0.0.1 \
  -c shared_buffers=64MB -c max_connections=25 -c work_mem=2MB \
  -c maintenance_work_mem=32MB -c effective_cache_size=256MB >/dev/null
wait_for 60 postgres "${docker_vm[@]}" exec cap-db pg_isready -h 127.0.0.1 -U capacity -q
sleep 2

# --- Sampler: memory and CPU, about every 4-5 s (each pass takes ~2-3 s) ----
phase_file="${run_dir}/phase"
echo startup >"${phase_file}"
(
  while true; do
    phase="$(cat "${phase_file}")"
    now="$(date -u +%s)"
    "${docker_vm[@]}" stats --no-stream --format '{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}' 2>/dev/null |
      sed "s/^/${now}|${phase}|container|/"
    vm sh -c "awk '/MemTotal|MemAvailable/ {print \$2}' /proc/meminfo | paste -sd'|'" 2>/dev/null |
      sed "s/^/${now}|${phase}|vm|/"
    sleep 2
  done
) >>"${run_dir}/samples.txt" &
sampler=$!

# --- Startup ------------------------------------------------------------------
start_gateway() { # rate-limit mode: production or raised
  "${docker_vm[@]}" run -d --name cap-gateway "${common[@]}" --network container:cap-net \
    --read-only --cap-drop=ALL --tmpfs /run/capacity:size=1m,uid=1000,gid=1000 \
    --log-driver fluentd --log-opt fluentd-address=127.0.0.1:24224 --log-opt fluentd-async=true \
    -e PORT=8081 -e GATEWAY_HOST=127.0.0.1 -e GATEWAY_TRUSTED_PROXY_HOPS=1 \
    -e DATABASE_URL \
    -e NOTION_TOKEN=synthetic-notion-token -e GITHUB_APP_PRIVATE_KEY=synthetic-github-key \
    -e CAPACITY_PUBLIC_JWK="$(cat "${run_dir}/public.jwk.json")" \
    -e CAPACITY_RATE_LIMITS="$1" -e CAPACITY_RECORDS="${records}" -e CAPACITY_PROVIDER_LATENCY_MS="${latency_ms}" \
    family-brain-gateway:capacity >/dev/null
}
started="$(date +%s%N)"
start_gateway production
# The ingress: the VM's nginx configuration, rendered by the VM's own
# function, with the gateway on 8081 (nginx's port-80 server takes 8080 in
# this shared namespace) and a self-signed certificate for the test name.
edge_dir="${run_dir}/edge"
mkdir -p "${edge_dir}/conf" "${edge_dir}/certs/live/${edge_domain}"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=${edge_domain}" \
  -addext "subjectAltName=DNS:${edge_domain}" \
  -keyout "${edge_dir}/certs/live/${edge_domain}/privkey.pem" \
  -out "${edge_dir}/certs/live/${edge_domain}/fullchain.pem" >/dev/null 2>&1
cp "${edge_dir}/certs/live/${edge_domain}/fullchain.pem" "${run_dir}/edge.crt"
edge_mode="$(source deploy/vm/host/bin/sim-g-edge.sh &&
  render_edge deploy/vm/edge "${edge_domain}" 127.0.0.1:8081 "${edge_dir}/certs" "${edge_dir}/conf")"
[[ "${edge_mode}" == serving ]] || { echo "ingress did not render in serving mode" >&2; exit 1; }
# Copied into volumes (the measured VM does not share the host's files).
for part in conf certs; do
  tar -C "${edge_dir}/${part}" -cf - . | "${docker_vm[@]}" run -i --rm --user 0 \
    -v "cap-edge-${part}:/target" --entrypoint sh "${nginx_image}" \
    -c 'tar -xf - -C /target && chown -R 101:101 /target' >/dev/null
done
"${docker_vm[@]}" run -d --name cap-tls "${common[@]}" --network container:cap-net \
  --read-only --cap-drop=ALL --user 101:101 --tmpfs /tmp:size=16m,uid=101,gid=101 \
  -v cap-edge-conf:/etc/nginx/sim-g:ro -v cap-edge-certs:/etc/sim-g/certs:ro \
  --entrypoint nginx "${nginx_image}" -c /etc/nginx/sim-g/nginx.conf -g 'daemon off;' >/dev/null
wait_for 120 "gateway health" "${docker_vm[@]}" exec cap-gateway node -e \
  "fetch('http://127.0.0.1:8081/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
gateway_ready_ms=$(( ($(date +%s%N) - started) / 1000000 ))
wait_for 60 "HTTPS through the ingress" curl -sf --max-time 5 --cacert "${run_dir}/edge.crt" \
  --resolve "${edge_domain}:8443:127.0.0.1" "https://${edge_domain}:8443/healthz"
tls_ready_ms=$(( ($(date +%s%N) - started) / 1000000 ))
echo "{\"gatewayReadyMs\":${gateway_ready_ms},\"tlsReadyMs\":${tls_ready_ms}}" >"${run_dir}/startup.json"
sleep 10

cpu_stat() { vm cat /sys/fs/cgroup/e2micro/cpu.stat | awk '{printf "\"%s\":%s,", $1, $2}' | sed 's/,$//'; }
load() { # label vus seconds think-ms
  echo "$1" >"${phase_file}"
  local before after
  before="$(cpu_stat)"
  pnpm exec tsx tests/capacity/load.ts --url https://127.0.0.1:8443 \
    --ca "${run_dir}/edge.crt" --servername "${edge_domain}" --private-jwk "${run_dir}/private.jwk.json" \
    --label "$1" --vus "$2" --seconds "$3" --think-ms "$4" >>"${run_dir}/load.jsonl"
  after="$(cpu_stat)"
  # The stack's cgroup CPU counters around the phase (throttling evidence).
  echo "{\"label\":\"$1\",\"cpuMax\":\"$(vm cat /sys/fs/cgroup/e2micro/cpu.max)\",\"before\":{${before}},\"after\":{${after}}}" >>"${run_dir}/cpu.jsonl"
}
# Admin tools use the container-local Unix socket, which the image trusts; the
# gateway itself authenticates with SCRAM over loopback TCP.
psql_count() {
  "${docker_vm[@]}" exec cap-db psql -U capacity -d family_brain_gateway_capacity -tAc "$1"
}

# --- Smoke: authenticated requests must succeed before anything is measured.
load smoke 1 5 200
# Correct policy denials (an out-of-scope record, Participant listing approvals)
# are not failures; anything else is.
if ! tail -1 "${run_dir}/load.jsonl" | python3 -c '
import json, sys
summary = json.loads(sys.stdin.read())
expected = {"record_not_found", "role_operation_forbidden"}
denials = sum(count for operation in summary["byOperation"].values()
              for reason, count in operation["reasons"].items() if reason in expected)
sys.exit(0 if summary["total"]["errors"] == denials else 1)'; then
  echo "smoke load failed; see ${run_dir}/load.jsonl" >&2
  exit 1
fi

# --- Production rate limits ------------------------------------------------------
# Household pacing: three family members, a request every ~3 s each, which is
# under the per-IP limit shared by the single synthetic source address.
load household-burst-cpu 3 120 3000
cpu_limit "25000 100000" # sustained baseline: 0.25 vCPU
load household-sustained-cpu 3 120 3000
# Deliberate overload: the per-IP limiter must shed load (429), not the VM.
load overload-production-limits 12 30 0
sleep 16 # let the household address's buckets refill
# A flood from another address (127.0.0.1 inside the stack's namespace; the
# household client arrives through Docker's port forward from another
# address), outside the stack's CPU cgroup, while the household client keeps
# working: nginx must shed the flood before the gateway.
mkdir -p "${run_dir}/flood"
cp tests/capacity/flood.mjs "${run_dir}/edge.crt" "${run_dir}/flood/"
tar -C "${run_dir}/flood" -cf - . | "${docker_vm[@]}" run -i --rm --user 0 \
  -v cap-flood:/target --entrypoint sh "${nginx_image}" -c 'tar -xf - -C /target' >/dev/null
"${docker_vm[@]}" run --rm --name cap-flood --network container:cap-net \
  -v cap-flood:/flood:ro --read-only --security-opt=no-new-privileges --cap-drop=ALL \
  --entrypoint node family-brain-gateway:capacity /flood/flood.mjs \
  https://127.0.0.1:8443 "${edge_domain}" /flood/edge.crt 32 70 >"${run_dir}/flood.json" &
flood_job=$!
sleep 5
load household-during-flood 3 60 3000
wait "${flood_job}"
cpu_limit "max 100000"

# --- Raised limits: the stack's own headroom (restart measured) -----------------
echo gateway-restart >"${phase_file}"
stop_started="$(date +%s%N)"
"${docker_vm[@]}" stop --time 15 cap-gateway >/dev/null # SIGTERM: graceful drain
stop_ms=$(( ($(date +%s%N) - stop_started) / 1000000 ))
stop_exit="$("${docker_vm[@]}" inspect --format '{{.State.ExitCode}}' cap-gateway)"
"${docker_vm[@]}" rm cap-gateway >/dev/null
restart_started="$(date +%s%N)"
start_gateway raised
wait_for 120 "gateway health after restart" "${docker_vm[@]}" exec cap-gateway node -e \
  "fetch('http://127.0.0.1:8081/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
restart_ready_ms=$(( ($(date +%s%N) - restart_started) / 1000000 ))
echo "{\"gracefulStopMs\":${stop_ms},\"stopExitCode\":${stop_exit},\"restartReadyMs\":${restart_ready_ms}}" >"${run_dir}/restart.json"
load headroom-burst-cpu 12 60 0
cpu_limit "25000 100000"
load headroom-sustained-cpu 12 60 0
load household-raised-sustained-cpu 3 60 3000

# Audit sink outage, then drain (sustained CPU).
"${docker_vm[@]}" exec cap-gateway touch /run/capacity/audit-sink-down
load audit-sink-down 3 60 1000
backlog="$(psql_count 'SELECT count(*) FROM audit_outbox WHERE delivered_at IS NULL')"
echo audit-drain >"${phase_file}"
"${docker_vm[@]}" exec cap-gateway rm /run/capacity/audit-sink-down
drain_started="$(date +%s)"
until [[ "$(psql_count 'SELECT count(*) FROM audit_outbox WHERE delivered_at IS NULL')" == "0" ]]; do
  sleep 1
  if (( $(date +%s) - drain_started > 900 )); then break; fi
done
drain_seconds=$(( $(date +%s) - drain_started ))
remaining="$(psql_count 'SELECT count(*) FROM audit_outbox WHERE delivered_at IS NULL')"
echo "{\"backlogAtRecovery\":${backlog},\"drainSeconds\":${drain_seconds},\"remaining\":${remaining}}" >"${run_dir}/audit.json"

# PostgreSQL restart under load (sustained CPU).
( sleep 30; "${docker_vm[@]}" restart cap-db >/dev/null ) &
restart_job=$!
load db-restart 3 90 1000
wait "${restart_job}"
cpu_limit "max 100000"

# --- Backup and restore ---------------------------------------------------------
echo backup >"${phase_file}"
backup_started="$(date +%s%N)"
"${docker_vm[@]}" exec cap-db pg_dump -U capacity -Fc family_brain_gateway_capacity >"${run_dir}/backup.dump"
backup_ms=$(( ($(date +%s%N) - backup_started) / 1000000 ))
backup_bytes="$(wc -c <"${run_dir}/backup.dump" | tr -d ' ')"
gzip_bytes="$(gzip -9c "${run_dir}/backup.dump" | wc -c | tr -d ' ')"
"${docker_vm[@]}" exec cap-db createdb -U capacity restore_check
restore_started="$(date +%s%N)"
"${docker_vm[@]}" exec -i cap-db pg_restore -U capacity -d restore_check --no-owner <"${run_dir}/backup.dump"
restore_ms=$(( ($(date +%s%N) - restore_started) / 1000000 ))
counts() {
  "${docker_vm[@]}" exec cap-db psql -U capacity -d "$1" -tAc \
    "SELECT (SELECT count(*) FROM operations)||','||(SELECT count(*) FROM audit_outbox)||','||(SELECT count(*) FROM brain_record_aliases)"
}
source_counts="$(counts family_brain_gateway_capacity)"
restored_counts="$(counts restore_check)"
echo "{\"backupMs\":${backup_ms},\"backupBytes\":${backup_bytes},\"gzipBytes\":${gzip_bytes},\"restoreMs\":${restore_ms},\"sourceCounts\":\"${source_counts}\",\"restoredCounts\":\"${restored_counts}\"}" >"${run_dir}/backup.json"

restart_job=""
echo done >"${phase_file}"
sleep 3
pnpm exec tsx tests/capacity/summarize.ts "${run_dir}"
