# Development secret resolution

`EnvironmentSecretProvider` implements the existing `SecretProvider` port for
local `development` and isolated `test` composition only. It is an internal
adapter, not an API endpoint or an alternative human authentication mechanism.
Production construction fails before the adapter reads any secret values.

## Composition boundary

Trusted composition supplies three required inputs: the environment, a mapping
from logical secret names to local variable names, and the source of local
environment values. There is no implicit `process.env` fallback. Prefer a narrow
source containing only this environment's required provider credentials. Do not
pass production credentials, human OAuth tokens, or the caller's request object.

- Logical names match `[a-z][a-z0-9_-]{0,127}`; variable names match
  `[A-Z_][A-Z0-9_]{0,127}`. The caller supplies a logical name, never an arbitrary
  environment variable to inspect.
- The environment and allowlist are snapshotted at construction. Changing the
  input options or bindings later cannot broaden that adapter's access.
- Each lookup reads only the selected source's own data property. Inherited
  values, accessors, non-strings, missing values and whitespace-only values do
  not resolve. Getters and string/JSON coercion hooks are not invoked.
- A nonblank value is returned unchanged, including multiline formatting.
  `SecretValue.value` is necessarily plaintext inside the consuming provider
  adapter. Never log, serialize, audit, or return that value through a public
  operation. Private fields prevent accidental serialization of the provider
  instance; they are not protection against arbitrary code running in-process.

Environment tags validate configured intent, not actual provider permissions.
A credential mislabeled as development could still have production privileges.
Dedicated identities, independently scoped credentials, registered roots and
deployment IAM must enforce the real boundary before live integration. This
slice neither provisions nor verifies those external controls.

## Rotation, versions and cancellation

No values are cached. Updating or deleting a variable in the originally injected
source affects the next lookup; replacing the options' source object does not.
For an ordinary process environment, an external shell's environment change does
not mutate a running process: restart it with the rotated credentials. A value
already returned to a consumer cannot be recalled by this adapter.

The returned version `environment` is an unversioned source marker, **not** a
stable version or cache key. All explicit version requests, including `latest`
and `environment`, fail closed. Version-pinned retrieval is provided only by the
separate [Google Secret Manager adapter](google-secret-manager.md).

Cancellation is checked before lookup and after source access. A cancelled
lookup rejects with a fresh `AbortError`; raw abort reasons are never propagated.
Unexpected source failures become a retryable `provider_unavailable` error with
only a fixed reason code. Missing/unregistered values, malformed references and
environment violations use safe non-retryable domain errors. Configuration,
variable names, secret values and source errors are never copied into errors.

## Source control and recovery

The `secrets/` exclusion remains in effect. Exact `.gitignore` exceptions track
only this adapter and its test file. Credential files, unapproved files in those
directories, nested secret directories, `.env` files, keys, logs and database
exports remain excluded and are covered by executable Git-ignore tests. Future
source files in a `secrets` directory need a reviewed exception; do not force-add
a directory or remove the global credential exclusions.

There is no migration, dependency addition, provider operation or deployed
configuration change in this slice. Rollback is a source revert; do not recover
the older unverified F6 secret drafts wholesale. No real credentials were used
to verify this adapter.

## Verification

From the repository with the pinned Node/pnpm runtime on `PATH`:

```sh
pnpm exec vitest run tests/unit/secrets/environment-secret-provider.test.ts tests/contract/repository-secret-ignore.test.ts
pnpm verify
pnpm audit --prod --audit-level=high
git diff --check
```

After `pnpm build`, verify the compiled ESM adapter with an actual Node process
environment. This starts with an empty child environment and creates only a
synthetic value; it does not forward the shell's credentials:

```sh
env -i "$(command -v node)" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { EnvironmentSecretProvider } from './dist/adapters/secrets/environment-secret-provider.js';
process.env.SIM_G_SYNTHETIC_SMOKE = 'SYNTHETIC_ONLY';
const provider = new EnvironmentSecretProvider({
  environment: 'test',
  bindings: { smoke: 'SIM_G_SYNTHETIC_SMOKE' },
  environmentValues: process.env,
});
const reference = { environment: 'test', name: 'smoke' };
assert.equal((await provider.get(reference, new AbortController().signal)).value, 'SYNTHETIC_ONLY');
delete process.env.SIM_G_SYNTHETIC_SMOKE;
await assert.rejects(provider.get(reference, new AbortController().signal), { code: 'not_found' });
assert.throws(() => new EnvironmentSecretProvider({
  environment: 'production', bindings: {}, environmentValues: process.env,
}), { code: 'environment_boundary_violation' });
console.log('PASS: isolated Node environment resolution, revocation and production refusal');
JS
```

Root [`STATUS.md`](../../STATUS.md) records exact local PostgreSQL regression
commands, verified counts, publication state and the single next slice. Real
provider integration, production secret retrieval, and end-to-end API secret
non-disclosure still require their later implementation and acceptance tests.
