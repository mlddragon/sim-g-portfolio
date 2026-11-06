# Notion governed retrieval

The Notion retrieval adapter implements only provider search and targeted page
fetch. It is not a generic Notion proxy and exposes no mutation or Family Inbox
surface in this slice.

## Supported client and API version

- The runtime dependency is the official `@notionhq/client` package pinned to
  `5.26.0`.
- After resolving the token at the internal secret/composition boundary, call
  `createOfficialNotionSdkClient`. It constructs the official SDK with Notion
  API version `2026-03-11`; a synthetic-transport regression verifies the
  emitted `Notion-Version` header. Do not construct an unversioned SDK client.
- The construction seam fixes a five-second SDK timeout, disables SDK retries,
  installs a no-op SDK logger, and returns only the frozen methods required for
  retrieval. Higher-level orchestration owns bounded retry/partial behavior.
- Inject only the SDK methods named by `NotionSdkClient`; do not expose the full
  SDK to core application code.
- Keep provider logging disabled or metadata-only. Never enable SDK debug output
  in a deployed gateway or log authorization headers, request bodies, page
  properties, block content, or raw provider responses.

The official SDK does not currently expose an `AbortSignal` parameter on these
read methods. The adapter races each read against the gateway signal and discards
late output after cancellation. Cancellation therefore bounds gateway response
handling but cannot guarantee that an already-started upstream HTTP read stops;
the fixed SDK timeout bounds how long the SDK waits but also does not prove
transport abort. Per-provider deadlines and connection-capacity monitoring remain
required at orchestration.

## Root and credential boundaries

Configure one or more exact Notion page or data-source roots. Workspace-wide
roots are rejected. Root configuration provides trusted canonical path and policy
metadata; provider responses cannot choose their own Brain scope or protection
class.

The dedicated Notion integration must independently be shared only with the
required development or production Brain content. Integration visibility is a
first boundary, not authorization. For every result, the adapter walks provider
ancestry and requires the nearest configured root to be present in the
server-derived access set. A nested restricted root therefore cannot inherit
access from a broader authorized ancestor. Records outside authorized roots and
records that do not exist produce the same safe `not_found` response on fetch.

Development and production integrations, credential handles, root IDs, and
configuration remain separate. Provider tokens stay in the configured secret
provider and must never appear in repository files, fixtures, logs, responses, or
shell history.

## Retrieval behavior

Notion's native search endpoint searches titles, not full page bodies. The
adapter therefore always marks a successful Notion search as `partial` with
`partial_results`; callers must not treat it as exhaustive. Search pagination is
bounded and every returned page is ancestry-checked before normalization.

Targeted fetch retrieves the selected page and recursively paginates its block
children. Block depth, count, request count, and cursor reuse are bounded so a
malformed or changing provider graph fails safely. Results retain stable page ID
and last-edited provenance plus trusted canonical location/policy metadata. Raw
Notion page, property, user, URL, file, and block objects are discarded.

## Verification and remaining work

Routine tests use only fictional, in-memory SDK responses and make no network
calls:

```sh
pnpm exec vitest run tests/unit/providers/notion-knowledge-provider.test.ts
pnpm verify
```

This evidence does not prove live integration scope, credentials, rate limits,
search quality, Notion availability, or isolated development behavior. Before
F7 is complete, add separately bounded, policy-authorized mutations, the safe
Family Inbox projection, isolated development integration tests, and deployment
checks for actual integration identity and root visibility.
