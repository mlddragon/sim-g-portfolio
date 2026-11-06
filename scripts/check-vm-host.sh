#!/usr/bin/env bash
# Offline checks for the e2-micro VM's host layer (design sections 1, 2, 4, 6
# and 8): renders the cloud-config exactly as Terraform will, then, in a
# throwaway container from the repository's pinned Debian base:
#   - validates it against cloud-init's schema;
#   - writes its files as cloud-init would and runs `systemd-analyze verify`;
#   - runs shellcheck over every host script;
#   - runs the synthetic behaviour cases with stubbed docker, systemctl,
#     mount and network tools, and the real blkid, mkfs.ext4 and iptables on
#     image files and the container's own network namespace. Nothing touches
#     a real disk, the host's firewall or a cloud.
# The validator packages come from Debian at check time; they never ship.
set -euo pipefail

cd "$(dirname "$0")/.."

base="$(grep -m1 -o 'node:24.19.0-trixie-slim@sha256:[0-9a-f]\{64\}' Dockerfile)"
[[ -n "${base}" ]] || {
  echo "pinned base image not found in Dockerfile" >&2
  exit 1
}

# Under $HOME: Colima bind-mounts only the home directory into its VM.
mkdir -p "${HOME}/.cache/sim-g-vm-host-check"
work="$(mktemp -d "${HOME}/.cache/sim-g-vm-host-check/run.XXXXXX")"
trap 'rm -rf "${work}"' EXIT

module=infra/google/modules/vm-host
terraform -chdir="${module}" init -backend=false -input=false >/dev/null
echo 'jsonencode(local.user_data)' | terraform -chdir="${module}" console |
  python3 -c 'import json, sys; sys.stdout.write(json.loads(json.loads(sys.stdin.read())))' \
    >"${work}/user-data"

# NET_ADMIN only inside the container's own network namespace, so the
# firewall cases can run the real iptables.
docker run --rm --network bridge --cap-add NET_ADMIN \
  --volume "${work}:/work:ro" \
  --volume "${PWD}/scripts/vm-host-check:/check:ro" \
  "${base}" bash /check/run.sh
