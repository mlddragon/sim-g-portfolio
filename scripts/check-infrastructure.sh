#!/usr/bin/env bash
# Formats, validates and plans every Terraform root against mocked Google
# providers (`terraform test`). Uses no credentials, project or state backend.
set -euo pipefail

cd "$(dirname "$0")/.."

terraform fmt -check -recursive infra/google

for root in infra/google/modules/vm-host infra/google/modules/vm infra/google/environments/dev infra/google/environments/prod; do
  echo "== ${root}"
  terraform -chdir="${root}" init -backend=false -input=false -lockfile=readonly >/dev/null
  terraform -chdir="${root}" validate -no-color
  terraform -chdir="${root}" test -no-color
done
