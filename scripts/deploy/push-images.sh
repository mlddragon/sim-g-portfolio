#!/usr/bin/env bash
# Run by the deploy workflow (.github/workflows/deploy.yml) after workload
# identity federation, never by hand. It builds the gateway and the
# PostgreSQL, nginx and certbot derivatives from this exact commit for the VM
# (linux/amd64), pushes all four to this environment's Artifact Registry
# repository, then writes
# the gateway's digest to the deploy pointer, which the VM's watcher follows
# (VM design section 10). It prints the host.env lines for the four images.
#
# Inputs, from the GitHub environment's variables and the auth step:
#   SIM_G_REGISTRY      <region>-docker.pkg.dev/<project>/sim-g
#   SIM_G_DEPLOY_BUCKET <project>-sim-g-deploy (the same project)
#   SIM_G_ACCESS_TOKEN  the deployer's short-lived access token
set -euo pipefail

cd "$(dirname "$0")/../.."

fail() {
  echo "deploy: $1" >&2
  exit 1
}

registry="${SIM_G_REGISTRY:-}"
bucket="${SIM_G_DEPLOY_BUCKET:-}"
[[ "${registry}" =~ ^([a-z0-9-]+-docker\.pkg\.dev)/([a-z][a-z0-9-]{4,28}[a-z0-9])/sim-g$ ]] ||
  fail "SIM_G_REGISTRY must be <region>-docker.pkg.dev/<project>/sim-g"
host="${BASH_REMATCH[1]}"
project="${BASH_REMATCH[2]}"
[[ "${bucket}" == "${project}-sim-g-deploy" ]] || fail "SIM_G_DEPLOY_BUCKET must be ${project}-sim-g-deploy"
[[ -n "${SIM_G_ACCESS_TOKEN:-}" ]] || fail "no access token"
commit="$(git rev-parse HEAD)"

printf '%s' "${SIM_G_ACCESS_TOKEN}" |
  docker login --username oauth2accesstoken --password-stdin "https://${host}" >/dev/null

# Prints the pushed image's repository@digest.
# Tags are immutable and builds are not reproducible, so each workflow run
# (and attempt) gets its own tag; deployment itself is by digest.
tag="${commit:0:12}-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
[[ "${tag}" =~ ^[0-9a-f]{12}-[0-9a-z]+-[0-9]+$ ]] || fail "unexpected tag"
push() { # local-tag remote-name
  local remote="${registry}/$2:${tag}"
  docker tag "$1" "${remote}"
  docker push --quiet "${remote}" >/dev/null
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${remote}" |
    grep -m1 "^${registry}/$2@sha256:"
}

docker build --quiet --platform linux/amd64 --tag sim-g-deploy-gateway . >/dev/null
gateway="$(push sim-g-deploy-gateway family-brain-gateway)"
docker build --quiet --platform linux/amd64 --tag sim-g-deploy-postgres deploy/vm/postgres >/dev/null
postgres="$(push sim-g-deploy-postgres sim-g-postgres)"
# The ingress derivatives: pinned upstream bases with security updates.
docker build --quiet --platform linux/amd64 --file deploy/vm/edge/nginx.Dockerfile \
  --tag sim-g-deploy-edge deploy/vm/edge >/dev/null
edge="$(push sim-g-deploy-edge nginx-unprivileged)"
docker build --quiet --platform linux/amd64 --file deploy/vm/edge/certbot.Dockerfile \
  --tag sim-g-deploy-certbot deploy/vm/edge >/dev/null
certbot="$(push sim-g-deploy-certbot certbot)"

# The pointer names only the digest; the VM keeps its own repository.
digest="${gateway##*@}"
[[ "${digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "no gateway digest"
status="$(printf '%s\n' "${digest}" | curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --config <(printf 'header = "Authorization: Bearer %s"\n' "${SIM_G_ACCESS_TOKEN}") \
  --header 'Content-Type: text/plain' --data-binary @- \
  "https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=family-brain-gateway%2Fgateway.digest")"
[[ "${status}" == 200 ]] || fail "the deploy pointer was not written (HTTP ${status})"

printf '```\nSIM_G_GATEWAY_IMAGE=%s\nSIM_G_POSTGRES_IMAGE=%s\nSIM_G_EDGE_IMAGE=%s\nSIM_G_CERTBOT_IMAGE=%s\n```\n' \
  "${gateway}" "${postgres}" "${edge}" "${certbot}"
