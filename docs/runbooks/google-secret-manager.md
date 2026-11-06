# Google Secret Manager secret provider

`GoogleSecretManagerProvider` (`src/adapters/secrets/google-secret-manager-provider.ts`)
implements the `SecretProvider` port for the deployed `development` and
`production` environments. Local and test runs keep using the
[environment adapter](development-secrets.md); the Google adapter refuses the
`test` environment at construction.

This adapter is not composed into any runtime yet. No Secret Manager secret,
project, IAM binding or live credential was created or used to verify it.

## Configuration

All options are trusted composition-time inputs:

- `environment`: `development` or `production`. A well-formed reference for any
  other environment fails with `environment_boundary_violation` before any call;
  a malformed reference fails with `invalid_request` first.
- `projectNumber`: the numeric project number, not the project ID. Secret
  Manager reports accessed versions under the project number, and the adapter
  requires the returned resource name to match exactly. Nothing ties the number to
  `environment`: give each environment its own project and machine identity, and
  never configure a development instance with the production project.
- `bindings`: the allowlist, mapping a logical name (for example
  `notion_token`) to one secret ID in that project. Only these names resolve;
  any other name fails with `not_found` / `secret_not_configured` before any
  call. The resource is always `projects/<number>/secrets/<id>`. Callers
  cannot supply a resource path, project or secret ID.
- `cacheTtlMs` (default 5 minutes, 1 second to 1 hour), `maximumCacheEntries`
  (default 32, 1 to 256) and `requestTimeoutMs` (default 10 seconds, 100 ms to
  60 seconds). Out-of-range values are rejected at construction.

Configuration errors use the fixed reason `invalid_google_secret_configuration`
and never repeat the configuration. Accessor properties are refused, not
invoked. Without an injected client the official `SecretManagerServiceClient`
is created; it authenticates lazily with the runtime's machine identity, which
must be granted `roles/secretmanager.secretAccessor` on only the bound secrets.

## Versions, rotation and revocation

A reference without `version` reads `latest`; an explicit version must be a
positive decimal. Aliases and paths are rejected. The returned `version` is
always the numeric version Secret Manager resolved, so rotation shows up as a
new version number.

Values are cached in memory per logical name and requested version for at
most `cacheTtlMs` and at most `maximumCacheEntries`. When the cache is full, the
least recently read entry is evicted. A cached `latest` value can lag a rotation or
revocation by up to the TTL. To make a rotation take effect sooner, restart the
service or shorten the TTL. Any failed fetch, transient failures included, evicts every
cached version of that secret, and no fetch that began before the failure can
repopulate the cache, so a stale value is never served after a failed refresh.
A caller's cancellation is not a failure and evicts nothing. Concurrent misses
are not coalesced: each makes its own bounded call. A clock that moves backwards forces a refetch. If two fetches
overlap, an older one never replaces a newer cached entry.

To revoke, disable or destroy the version in Secret Manager. Once the cached
entry expires, reads fail with `not_found` / `secret_version_unavailable`
(`FAILED_PRECONDITION`) or `secret_version_not_found` (`NOT_FOUND`).

## Integrity and identity

Each response must:

- name `projects/<number>/secrets/<bound id>/versions/<n>`, with `n` numeric and
  equal to any pinned request (otherwise `secret_identity_mismatch`);
- carry a decimal CRC32C (`dataCrc32c`) that matches the payload bytes. A missing
  or mismatched checksum fails with `secret_integrity_failed`;
- contain a non-blank UTF-8 payload of at most 64 KiB (otherwise
  `secret_response_invalid`).

## Errors and cancellation

Only the gRPC status code of a client error is read; messages, metadata and
resource names are never copied. `PERMISSION_DENIED`/`UNAUTHENTICATED` become
non-retryable `provider_unavailable` / `secret_access_denied`; other failures
`INVALID_ARGUMENT`/`OUT_OF_RANGE` become non-retryable `secret_request_rejected`;
other failures are retryable `secret_access_failed`. An error or response
whose properties throw still settles with a safe error. Cancellation before or
during a call rejects with a fresh `AbortError`, never propagates the abort
reason, and cancels the underlying RPC when the client exposes `cancel()`;
otherwise the call stops at `requestTimeoutMs`.
Values are held in private fields and returned frozen. Serializing the
provider never exposes them.

## Rollback

The adapter is unused at runtime, so rollback is a source revert of the adapter,
its tests, its `.gitignore` exceptions and the `@google-cloud/secret-manager`
dependency.
