#!/usr/bin/env bash
# Runs inside the throwaway check container (see scripts/check-vm-host.sh).
set -euo pipefail

apt-get update -qq >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  cloud-init curl e2fsprogs iptables python3-yaml shellcheck systemd systemd-journal-remote tzdata >/dev/null 2>&1

echo "== cloud-init schema"
cloud-init schema --config-file /work/user-data

echo "== write_files"
python3 - <<'EOF'
import os
import yaml

with open('/work/user-data', encoding='utf-8') as source:
    config = yaml.safe_load(source)
for entry in config['write_files']:
    os.makedirs(os.path.dirname(entry['path']), exist_ok=True)
    with open(entry['path'], 'w', encoding='utf-8') as target:
        target.write(entry['content'])
    os.chmod(entry['path'], int(entry['permissions'], 8))
    print(entry['permissions'], entry['path'])
EOF

echo "== systemd-analyze verify"
# COS provides docker.service and /usr/bin/docker; stubs stand in here.
[[ -x /usr/bin/docker ]] || install -m 0755 /bin/true /usr/bin/docker
printf '[Unit]\nDescription=stub\n[Service]\nExecStart=/bin/true\n' \
  >/etc/systemd/system/docker.service
units=(/etc/systemd/system/sim-g*)
systemd-analyze verify "${units[@]}"
echo "verified ${#units[@]} units"

echo "== shellcheck"
shellcheck --shell=bash /etc/sim-g/bin/*.sh

echo "== behaviour cases"
bash /check/cases.sh
