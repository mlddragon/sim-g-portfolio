# Container image

The gateway ships as one container image built from `Dockerfile`. The image
does not depend on where it runs. The production target is one Compute Engine
`e2-micro` (PLAN Task 13); nothing has been deployed.

## What the image contains

- **Base:** `node:24.19.0-trixie-slim`, pinned by digest, for the build stages
  and the runtime.
  - The runtime stage takes Debian security updates at build time, then removes
    npm, npx, corepack and yarn: the gateway needs only `node`.
  - Because of those updates a rebuild is not byte-for-byte reproducible.
    Build each image once and promote it by digest; never rebuild for
    promotion.
- **Contents:** `dist/` (compiled gateway), production `node_modules`
  (`pnpm install --frozen-lockfile --prod --ignore-scripts`), `package.json`,
  `config/policy/` and `migrations/`. All of it is owned by root and read-only
  to the runtime user.
- **Runtime:**
  - it runs as `1000:1000` with `NODE_ENV=production`, `PORT=8080` and
    `CMD ["node", "dist/cli.js"]`;
  - a Docker `HEALTHCHECK` fetches `/healthz` on loopback;
  - it works with a read-only root filesystem.
- **Build context:** `.dockerignore` excludes Git metadata, environment files,
  keys, certificates, Terraform state, plans and variable files, logs, dumps,
  tests, docs, infrastructure and local tooling.

## Checks

```sh
pnpm image:check   # scripts/check-container.sh
```

The script:

1. Builds the image.
2. Smoke-tests it with `--read-only --cap-drop=ALL
--security-opt=no-new-privileges --network=none`. Without configuration it
   must exit 1 with exactly
   `{"severity":"ERROR","msg":"startup_failed","reason":"gateway_config_path_required"}`,
   and it must run as `1000:1000`. The compiled migration command
   (`node dist/migration-cli.js`) must likewise exit 1 with
   `migration_database_url_required` when given no URL.
3. Runs the pinned Trivy image
   (`aquasec/trivy:0.75.0@sha256:af6acf9a…`) over the image, the
   configuration files (Dockerfile and any infrastructure) and
   `pnpm-lock.yaml`. Any fixable HIGH or CRITICAL finding fails the check.

Trivy reaches the image through the Docker socket, which gives the scanner
container control of the local Docker daemon. The digest pin is what makes
that acceptable.

CI runs the same script in the `Container image` job, and runs
`pnpm audit --prod --audit-level=high` in `Verify`.
`tests/contract/deployment-artifact-boundaries.test.ts` checks the following
from the source text:

- digest-pinned bases;
- the non-root user;
- the build-context exclusions;
- SHA-pinned workflow actions;
- the pinned Trivy reference;
- that no Terraform state, plan or variable file can be committed.

Local runs on the MacBook Pro use Colima and are development and QA evidence
only.
