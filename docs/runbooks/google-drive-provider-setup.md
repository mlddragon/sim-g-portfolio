# Google Drive provider setup

## Current implementation boundary

The v1 Drive adapter is implemented and verified locally against fictional
provider responses. It is not yet composed into a running gateway and has not
been granted access to a live Google Drive root. Live development validation is
intentionally pending isolated development credentials and roots.

The adapter uses the official `@googleapis/drive` package pinned in the lockfile.
Automatic SDK retries are disabled. The application state machine, not the SDK,
will own retries and uncertain-outcome reconciliation.

## Security model

Development and production each require a distinct Google service identity and
distinct governed roots. The identity performs provider operations; it never
impersonates Operator, Steward, Participant, or another Workspace user.

Do not enable domain-wide delegation. Google documents that access to a specific
file or folder does not require administrative roles or domain-wide delegation.
Grant the service identity access only to the registered Brain roots. If Shared
Drive membership would expose the entire drive, use a Brain-only Shared Drive or
a limited-access folder whose contents are all in scope.

The unattended adapter must read existing registered files and write routed
records. Google's `drive.file` scope is picker/per-file oriented and does not by
itself grant an unattended service identity access to an existing folder tree.
The expected Example deployment therefore uses the Drive scope with the service
identity's ACL restricted to the exact Brain roots. The adapter independently
rechecks every root and descendant, so OAuth scope or provider visibility cannot
expand gateway authorization.

Production should use workload identity and service-account impersonation. Do
not create a service-account key merely to simplify setup. Local development
should also prefer short-lived impersonated Application Default Credentials
after owner authentication.

Official references:

- [Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Create access credentials](https://developers.google.com/workspace/guides/create-credentials)
- [Shared Drive request requirements](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives)
- [Private application file properties](https://developers.google.com/workspace/drive/api/guides/properties)

## Root registry

Every runtime root must resolve to this adapter shape:

```ts
interface DriveGovernedRoot {
  rootRef: string;
  folderId: string;
  sharedDriveId?: string;
  displayPath: string;
  policy: {
    scope: BrainScope;
    sensitivity: Sensitivity;
    protectedClass: ProtectedClass;
  };
}
```

`rootRef` is the stable, environment-tagged Brain identifier used by policy and
routing. `folderId` and `sharedDriveId` are provider IDs resolved only inside the
runtime composition boundary. Real IDs belong in environment-specific secret or
configuration storage, not source control, fixtures, logs, or API responses.

The adapter supports an explicitly registered folder in My Drive by omitting
`sharedDriveId`, but it still queries only direct descendants of that folder.
It never issues an `allDrives` query or defaults to the authenticated human's My
Drive. Prefer Shared Drive roots for Example deployment because ownership is not
tied to a person.

Nested registered roots form a hard boundary. If an outer root is authorized but
a nearer nested root is not, traversal stops at the nested root and does not fall
back to the outer policy.

## Provider behavior

Search traverses only requested configured folder trees. Each list request:

- includes an exact parent-folder predicate;
- uses `corpora=drive` plus the configured `driveId` for Shared Drives, otherwise
  `corpora=user` with the exact parent predicate;
- sets `supportsAllDrives=true` and `includeItemsFromAllDrives=true`;
- rejects cyclic pagination and bounded-traversal overflow;
- verifies returned ancestry again before exposing a result.

Full fetch supports:

- Google Docs exported as UTF-8 `text/plain`;
- UTF-8 `text/plain`;
- UTF-8 `text/markdown`;
- UTF-8 `application/json`.

Content is bounded to 5 MiB. Invalid UTF-8, integrity mismatch, malformed
metadata, and provider failures fail closed. PDF, image, archive, executable,
and other binary content may appear as a search summary but full-content fetch
returns `provider_capability_unsupported` in this v1 slice.

Create accepts only UTF-8 Markdown routed to an exact registered root. Update,
append, and trash accept only gateway-managed `text/plain` or `text/markdown`
files. Google Docs, JSON, PDF, binary files, and unmanaged text files are
read-only. The gateway never converts or overwrites them.

Delete uses `files.update({trashed: true})`; permanent delete and empty-trash
methods are absent from the client surface.

## Reconciliation markers

The adapter stores only bounded private `appProperties`:

- `sim_g_managed`
- `sim_g_operation` (SHA-256 of the operation ID)
- `sim_g_operation_kind`
- `sim_g_root` (SHA-256 of the stable root reference)
- `sim_g_content_sha256`

Raw operation IDs, record content, human identity, and policy documents are not
written into these markers. After every reported-success write, the adapter
re-fetches metadata and content and verifies the marker, root, title, trash
state, and content hash. Network ambiguity returns `outcome_unknown`; the caller
must reconcile by marker instead of blindly retrying.

Drive v3 exposes a monotonic file `version` and, where available, a head revision
ID, but its current `files.update` contract does not expose a file-version query
precondition. The adapter therefore checks version, ancestry, managed state, and
content integrity immediately before dispatch and verifies the resulting state
afterward. A provider-side race in the final network interval remains a known
limitation to exercise during live development testing.

## Isolated development setup

Owner interaction is required before live testing:

1. Select or create the approved development Google Cloud project with billing.
2. Enable the Google Drive API.
3. Create the dedicated development Drive service identity without a key and
   without domain-wide delegation.
4. Create a fictional, disposable development root that contains no real Family
   Brain records.
5. Grant only that root to the development identity with the minimum role needed
   for search, fetch, create, update, and recoverable trash.
6. Store the identity and root mapping outside Git; configure short-lived local
   impersonation.
7. Run the opt-in live contract for search, nested fetch, Markdown create,
   update, append, trash, reconciliation, and out-of-root denial.
8. Remove disposable test records and verify that the identity cannot access an
   unrelated control root.

Do not reuse development credentials or roots in production. Do not use real
family content to make the live test pass.

## Local verification

No Google credential or network access is required for the current automated
suite:

```bash
pnpm exec vitest run tests/contract/drive-provider.contract.test.ts tests/unit/drive
pnpm verify
pnpm test:integration
pnpm audit --prod --audit-level=high
git diff --check
```

The PostgreSQL command requires the isolated test-only `TEST_DATABASE_URL`
described in `local-development.md`. The Drive adapter adds no migration.
