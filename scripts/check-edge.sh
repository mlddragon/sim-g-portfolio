#!/usr/bin/env bash
# Offline checks for the nginx ingress (VM design section 3), with the real
# pinned nginx image and the configuration rendered exactly as
# sim-g-edge.sh renders it, in throwaway Docker networks:
#   - nginx accepts the configuration, hardened as on the VM;
#   - request limits act before the upstream (a stand-in that counts what
#     reaches it), per client and across clients;
#   - forged forwarding headers neither move a client to another bucket nor
#     reach the upstream; X-Forwarded-For is the TCP peer;
#   - port 80 serves certificate validation and redirects to the fixed name;
#   - 443 refuses unknown or missing names, and every name before the
#     certificate exists.
# The image is built from deploy/vm/edge/nginx.Dockerfile, as CI and the
# deploy workflow build it. A self-signed certificate stands in for Let's
# Encrypt. No cloud is touched.
set -euo pipefail

cd "$(dirname "$0")/.."

nginx_image=sim-g-edge:check
node_image="$(grep -m1 -o 'node:24.19.0-trixie-slim@sha256:[0-9a-f]\{64\}' Dockerfile)"
domain=edge-check.sim-g.test
prefix="sim-g-edge-check-$$"
failures=0

# Under $HOME: Colima bind-mounts only the home directory into its VM.
mkdir -p "${HOME}/.cache/sim-g-edge-check"
work="$(mktemp -d "${HOME}/.cache/sim-g-edge-check/run.XXXXXX")"
cleanup() {
  docker rm -f "${prefix}-edge" "${prefix}-upstream" "${prefix}-client" \
    "${prefix}-client2" "${prefix}-client3" "${prefix}-c1" "${prefix}-c2" "${prefix}-c3" "${prefix}-c4" >/dev/null 2>&1 || true
  docker network rm "${prefix}-internal" "${prefix}-public" >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT

check() { # description condition...
  local description="$1"
  shift
  if "$@"; then
    echo "ok   ${description}"
  else
    echo "FAIL ${description}" >&2
    failures=$((failures + 1))
  fi
}
field() { # json key...
  python3 -c '
import json, sys
value = json.loads(sys.argv[1])
for key in sys.argv[2:]:
    value = value[key]
print(value)' "$@"
}

# The ingress image, exactly as CI and the deploy workflow build it.
docker build --quiet --file deploy/vm/edge/nginx.Dockerfile --tag "${nginx_image}" deploy/vm/edge >/dev/null

# --- Render, exactly as on the VM -------------------------------------------
# shellcheck source=deploy/vm/host/bin/sim-g-edge.sh
source deploy/vm/host/bin/sim-g-edge.sh
mkdir -p "${work}/conf" "${work}/serving" "${work}/certs/live/${domain}" "${work}/acme/.well-known/acme-challenge"
check "render refuses an invalid name" bash -c \
  '! (source deploy/vm/host/bin/sim-g-edge.sh && render_edge deploy/vm/edge "Bad_Name.test" 172.31.250.2:8080 "$1" "$1" >/dev/null 2>&1)' _ "${work}/conf"
mode="$(render_edge deploy/vm/edge "${domain}" 172.31.250.2:8080 "${work}/certs" "${work}/conf")"
check "render without a certificate is bootstrap" test "${mode}" == bootstrap
check "bootstrap includes no TLS site" test ! -s "${work}/conf/site.conf"

# Laid out as certbot does: files in archive/, relative links in live/.
mkdir -p "${work}/certs/archive/${domain}"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=${domain}" \
  -addext "subjectAltName=DNS:${domain}" \
  -keyout "${work}/certs/archive/${domain}/privkey1.pem" \
  -out "${work}/certs/archive/${domain}/fullchain1.pem" >/dev/null 2>&1
ln -s "../../archive/${domain}/privkey1.pem" "${work}/certs/live/${domain}/privkey.pem"
ln -s "../../archive/${domain}/fullchain1.pem" "${work}/certs/live/${domain}/fullchain.pem"
cp "${work}/certs/archive/${domain}/fullchain1.pem" "${work}/ca.pem"
printf 'synthetic-token.synthetic-thumbprint' >"${work}/acme/.well-known/acme-challenge/synthetic-token"
# The container user (101) and the client (1000) read these through the
# bind mounts; only this throwaway directory is opened up.
chmod -R a+rX "${work}"
cp scripts/edge-check/*.mjs "${work}/"

# --- Networks shaped like the VM's ---------------------------------------
docker network create --internal --subnet 172.31.250.0/28 "${prefix}-internal" >/dev/null
docker network create --subnet 172.31.250.32/28 "${prefix}-public" >/dev/null

start_edge() {
  docker rm -f "${prefix}-edge" >/dev/null 2>&1 || true
  docker create --name "${prefix}-edge" --network "${prefix}-public" --ip 172.31.250.34 \
    --read-only --cap-drop=ALL --security-opt=no-new-privileges --user 101:101 \
    --memory 96m --memory-swap 96m --pids-limit 64 --tmpfs /tmp:size=16m,uid=101,gid=101 \
    --volume "${conf_dir}:/etc/nginx/sim-g:ro" \
    --volume "${work}/certs/live:/etc/sim-g/certs/live:ro" \
    --volume "${work}/certs/archive:/etc/sim-g/certs/archive:ro" \
    --volume "${work}/acme:/var/www/acme:ro" \
    --entrypoint nginx "${nginx_image}" -c /etc/nginx/sim-g/nginx.conf -g 'daemon off;' >/dev/null
  docker network connect --ip 172.31.250.3 "${prefix}-internal" "${prefix}-edge"
  docker start "${prefix}-edge" >/dev/null
  for _ in $(seq 50); do
    docker logs "${prefix}-edge" 2>&1 | grep -q emerg && break
    docker run --rm --network "${prefix}-public" "${node_image}" node -e \
      "require('net').connect(8080,'172.31.250.34').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" \
      >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  docker logs "${prefix}-edge" >&2 || true
  return 1
}
client() { # name args...
  local name="$1"
  shift
  docker run --rm --name "${prefix}-${name}" --network "${prefix}-public" \
    --cap-drop=ALL --user 1000:1000 --volume "${work}:/check:ro" \
    "${node_image}" node /check/client.mjs "$@"
}
upstream() { # path
  docker run --rm --network "${prefix}-internal" "${node_image}" node -e \
    "fetch('http://172.31.250.2:8080$1').then(r=>r.text()).then(t=>process.stdout.write(t))"
}

# --- Bootstrap: no certificate yet ------------------------------------------
conf_dir="${work}/conf"
check "nginx starts read-only and unprivileged (bootstrap)" start_edge
result="$(client client tls 172.31.250.34 "${domain}")"
check "bootstrap: 443 refuses the handshake" test "$(field "${result}" handshake)" == refused
result="$(client client http 172.31.250.34 /.well-known/acme-challenge/synthetic-token "${domain}")"
check "bootstrap: port 80 serves the validation file" test "$(field "${result}" body)" == synthetic-token.synthetic-thumbprint
# A missing validation file is a 404, not an error worth logging: nginx's
# error log would carry the client's address (F13d Stage A finding 6).
result="$(client client http 172.31.250.34 /.well-known/acme-challenge/missing-token "${domain}")"
check "bootstrap: a missing validation file is a 404" test "$(field "${result}" status)" == 404
check "bootstrap: a missing validation file logs nothing" \
  bash -c 'logs="$(docker logs "$0" 2>&1)" && ! grep -qE "missing-token|client: " <<<"${logs}"' "${prefix}-edge"

# --- Serving -----------------------------------------------------------------
# Rendered into a fresh directory: Colima's file sharing can briefly serve a
# rewritten file's old contents to a new container.
mode="$(render_edge deploy/vm/edge "${domain}" 172.31.250.2:8080 "${work}/certs" "${work}/serving")"
chmod -R a+rX "${work}/serving"
conf_dir="${work}/serving"
check "render with a certificate is serving" test "${mode}" == serving
check "nginx accepts the serving configuration" docker run --rm --read-only --user 101:101 \
  --tmpfs /tmp:size=16m,uid=101,gid=101 \
  --volume "${work}/serving:/etc/nginx/sim-g:ro" --volume "${work}/certs/live:/etc/sim-g/certs/live:ro" \
  --volume "${work}/certs/archive:/etc/sim-g/certs/archive:ro" \
  --entrypoint nginx "${nginx_image}" -t -q -c /etc/nginx/sim-g/nginx.conf
check "nginx starts read-only and unprivileged (serving)" start_edge
# The gateway starts after nginx (as it may on boot): both addresses are
# fixed, so nginx can never take the gateway's.
check "the gateway still gets its fixed address after nginx started" docker run -d \
  --name "${prefix}-upstream" --network "${prefix}-internal" --ip 172.31.250.2 \
  --read-only --cap-drop=ALL --user 1000:1000 --volume "${work}:/check:ro" \
  "${node_image}" node /check/upstream.mjs
sleep 1

result="$(client client tls 172.31.250.34 "${domain}")"
check "443 completes the handshake for the name" test "$(field "${result}" handshake)" == ok
result="$(client client tls 172.31.250.34 other.sim-g.test)"
check "443 refuses another name" test "$(field "${result}" handshake)" == refused
result="$(client client tls 172.31.250.34 -)"
check "443 refuses a handshake without a name" test "$(field "${result}" handshake)" == refused

result="$(client client http 172.31.250.34 /v1/x attacker.example)"
check "port 80 redirects to the fixed name, whatever the Host" \
  test "$(field "${result}" location)" == "https://${domain}/v1/x"
result="$(client client http 172.31.250.34 /.well-known/acme-challenge/synthetic-token "${domain}")"
check "port 80 serves the validation file" test "$(field "${result}" body)" == synthetic-token.synthetic-thumbprint

# One client, 150 requests at once, each with different forged headers, over
# 12 connections: under nginx's 16 per address, so only the request limit
# decides (above it, limit_conn's own 429s would race the request limit).
upstream /__reset >/dev/null
result="$(client client burst 172.31.250.34 "${domain}" 150 12)"
echo "     one client: ${result}"
ok="$(field "${result}" statuses 200 2>/dev/null || echo 0)"
limited="$(field "${result}" statuses 429 2>/dev/null || echo 0)"
seconds="$(field "${result}" seconds)"
seen="$(upstream /__seen)"
reached="$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "${seen}")"
allowed="$(python3 -c "import math; print(30 + math.ceil(2 * ${seconds}) + 1)")"
# Earlier checks from a reused client address may have spent a few tokens.
check "a forged-header flood is admitted up to the burst (${ok} admitted, at least 20)" test "${ok}" -ge 20
check "a forged-header flood is limited per client (${ok} admitted, at most ${allowed})" test "${ok}" -le "${allowed}"
check "the flood is shed with 429s (${limited})" test "${limited}" -ge $((150 - allowed))
check "nothing limited reaches the upstream (${reached} reached, ${ok} admitted)" test "${reached}" -eq "${ok}"
check "the upstream sees only the TCP peer as X-Forwarded-For" python3 -c '
import json, sys
seen = json.loads(sys.argv[1])
peers = {entry["forwardedFor"] for entry in seen}
assert len(peers) == 1 and next(iter(peers)).startswith("172.31.250.3"), peers
assert all(entry["forwardedHost"] is None and entry["forwarded"] is None and entry["realIp"] is None for entry in seen)
assert all(entry["host"] == sys.argv[2] and entry["forwardedProto"] == "https" for entry in seen)
' "${seen}" "${domain}"

result="$(client client2 get 172.31.250.34 "${domain}" /v1/operations/search_brain)"
check "another client is not limited by the first one's flood" test "$(field "${result}" status)" == 200

# --- shapes, sizes, names and the health path ---------------------------------
result="$(client client3 limited 172.31.250.34 "${domain}")"
check "a 429 carries Retry-After" test "$(field "${result}" retryAfter)" == 1
check "a 429 carries the gateway's JSON shape" python3 -c '
import json, sys
body = json.loads(json.loads(sys.argv[1])["body"])
assert body == {"error": {"code": "rate_limited", "retryable": True, "details": {"reason": "ingress_rate_limited"}}}, body
' "${result}"
sleep 16
upstream /__reset >/dev/null
result="$(client c1 post 172.31.250.34 "${domain}" /v1/operations/search_brain 100000)"
check "a 100 KB search is refused by nginx (413)" test "$(field "${result}" status)" == 413
result="$(client c1 post 172.31.250.34 "${domain}" /v1/operations/persist_knowledge 1500000)"
check "a 1.5 MB persist reaches the gateway" test "$(field "${result}" status)" == 200
result="$(client c1 post 172.31.250.34 "${domain}" /v1/operations/update_record 3000000)"
check "a 3 MB update is refused by nginx (413)" test "$(field "${result}" status)" == 413
result="$(client c1 get 172.31.250.34 "${domain}" /healthz GET)"
check "the health check reaches the gateway" test "$(field "${result}" status)" == 200
for path in //healthz /x/../healthz /%68ealthz; do
  result="$(client c1 get 172.31.250.34 "${domain}" "${path}" GET)"
  check "a disguised health path (${path}) is refused" test "$(field "${result}" status)" == 404
done
check "only the real requests reached the upstream" python3 -c '
import json, sys
paths = sorted(entry["path"] for entry in json.loads(sys.argv[1]))
assert paths == ["/healthz", "/v1/operations/persist_knowledge"], paths
' "$(upstream /__seen)"
result="$(client c1 post 172.31.250.34 "${domain}" /v1/operations/search_brain 10 other.sim-g.test)"
check "a Host other than the handshake's name gets no response" test "$(field "${result}" status)" == error

# A flood spread over four addresses, each under its own burst: the shared
# zone caps the total that reaches the upstream.
sleep 16 # let the per-client and shared buckets refill
upstream /__reset >/dev/null
for n in 1 2 3 4; do client "c${n}" burst 172.31.250.34 "${domain}" 28 7 >"${work}/spread-${n}.json" & done
wait
reached="$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "$(upstream /__seen)")"
check "the spread flood reached the upstream (${reached})" test "${reached}" -ge 60
# Each address stays under its own burst (28 < 30), so only the shared cap
# can shed any of it.
check "the shared cap shed part of the spread flood (${reached} of 112)" test "${reached}" -lt 112

if ((failures > 0)); then
  echo "${failures} edge checks failed" >&2
  exit 1
fi
echo "all edge checks passed"
