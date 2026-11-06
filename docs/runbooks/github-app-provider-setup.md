# GitHub App provider setup

## Current boundary

The v1 GitHub adapter implements governed read-only search and targeted fetch.
It is verified locally with fictional responses but is not composed into a
running gateway and has not authenticated as a live GitHub App. The checked-in
Project Registry is empty and its live binding is pending, so real retrieval
remains fail-closed until an approved development Registry and App exist.

GitHub is never a mutation provider in v1. The adapter, its official SDK surface,
and its shared provider contract expose no create, update, append, trash,
reconciliation, permission, issue, pull-request, workflow, or generic GitHub API
methods.

## Identity and permissions

Use a separate private GitHub App for development and production. Each App must:

- request repository `Contents: read` only; GitHub supplies required repository
  metadata access implicitly;
- be installed only on individually selected Project Registry-approved
  repositories, never every repository in an account or organization;
- use its own App ID, installation ID, private key, credential handle, and
  rotation/revocation procedure; and
- never use Operator's, Steward's, Participant's, or a developer's personal access token.

The private key is resolved only at the server-side composition boundary. Keep
it in the environment's approved secret provider, never in Git, `.env` examples,
logs, API responses, fixtures, shell history, or the Project Registry. App
visibility is an additional restriction and does not grant Brain authorization.

## Project Registry boundary

`config/policy/project-registry.yaml` is the only checked-in repository allowlist.
Its exact bytes are independently SHA-256 locked. Runtime loading also requires
an exact canonical source reference, version, content hash, marker, and content
match through `GovernanceSource`. A pending or drifted binding returns
`policy_drift` before any GitHub call.

Every entry declares an exact `owner/repository`, stable project key, one or more
Brain scopes, and exact files or trailing-slash path prefixes. The adapter limits
the Registry to 100 repositories, 32 knowledge paths per repository, and 280
characters per path. When an entry declares multiple scopes, the most restrictive
scope controls the entire entry. Split content into separate repositories or
entries rather than depending on a weaker scope.

Use the fictional
[`project-registry.example.yaml`](../../config/policy/project-registry.example.yaml)
only as a shape reference. Never copy real repository names into examples or
register a repository merely because the App can see it.

## Retrieval behavior

For each request, eligible repositories are the exact intersection of:

1. the current server-derived principal access set;
2. the live-marker-verified Project Registry; and
3. the current GitHub App installation repository set.

Search issues one query per eligible repository with exactly one
Registry-derived `repo:owner/name` qualifier. Caller-supplied repository
qualifiers are rejected. GitHub code search is default-branch indexed and may
report `incomplete_results`; the gateway preserves this as explicit partial
completeness rather than claiming exhaustive results.

A result's stable private provider ID is derived from repository plus path.
Targeted fetch revalidates the live Registry and current access, resolves the
repository's current default branch to a full commit SHA, and supplies that SHA
as the Contents API `ref`. Provenance retains repository, path, commit SHA, and
blob SHA. Callers cannot select arbitrary historical refs.

Full fetch accepts only canonical UTF-8 files of at most 1 MiB. Directories,
symlinks, submodules, invalid UTF-8, binary/control-byte content, malformed
responses, oversized files, unauthorized paths, and unregistered repositories
fail closed with bounded errors. Search summaries never contain full bodies.

## Isolated development validation

Owner interaction is required before live verification:

1. Create a private development GitHub App with only `Contents: read`.
2. Install it on one disposable repository containing fictional text fixtures.
3. Create and independently approve the matching development Project Registry
   snapshot and canonical source marker.
4. Store the App private key and identifiers outside this repository.
5. Set `RUN_GITHUB_DEV_TESTS=1` plus `GITHUB_DEV_APP_ID`,
   `GITHUB_DEV_INSTALLATION_ID`, `GITHUB_DEV_APP_PRIVATE_KEY`,
   `GITHUB_DEV_REPOSITORY`, `GITHUB_DEV_EXPECTED_PATH`, and
   `GITHUB_DEV_SEARCH_QUERY` for one process only.
6. Run the opt-in test, then separately prove an App-visible but unregistered
   control repository and an out-of-path record are not returned by the composed
   provider.

Use no real Family Brain content. Do not create or alter production resources to
make a development test pass. Production remains blocked until its separate App,
Registry, credentials, and deployment controls are reviewed.

## Verification

Routine tests require no credential or provider network call:

```sh
pnpm exec vitest run tests/contract/github-provider.contract.test.ts tests/unit/github
pnpm verify
pnpm test:integration
pnpm audit --prod --audit-level=high
git diff --check
```

The PostgreSQL command uses the isolated test-only database documented in root
`STATUS.md`. Without the explicit live flag, the GitHub development test is
skipped and no live verification is claimed.
