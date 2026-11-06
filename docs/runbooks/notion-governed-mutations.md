# Notion governed record mutations

The governed mutation adapter implements the Notion portion of
`MutableKnowledgeProvider`: canonical create, version-checked update, append,
recoverable trash, and reconciliation. It composes the existing governed
retrieval adapter for search/fetch. It is not a generic Notion proxy and does not
implement application idempotency, approval execution, or Family Inbox behavior.

## Provider and scope boundary

Use `createOfficialNotionMutationSdkClient` only after resolving a dedicated
server-side Notion credential at the composition boundary. The factory uses the
official `@notionhq/client` `5.26.0`, pins API version `2026-03-11` and a
five-second timeout, disables SDK retry and logging, and exposes only:

- page create, retrieve, update, retrieve-markdown, and update-markdown; and
- data-source query.

The adapter copies only those methods. Core application code never receives the
SDK or token. Configure separate development and production integrations and
share each integration only with its environment's exact governed roots.

Every writable root must be an exactly configured Notion data source. A target
page must have that data source as its direct parent, belong to the server-derived
authorized scope/root snapshot, and be outside trash. Access to some other page,
data source, or workspace does not grant mutation authority.

## Required writable-record schema

Configure four distinct stable Notion property IDs per writable data source:

| Logical field            | Notion type | Purpose                                      |
| ------------------------ | ----------- | -------------------------------------------- |
| Title                    | `title`     | Canonical record title                       |
| Gateway operation marker | `rich_text` | Stable operation correlation and retry guard |
| Gateway content type     | `rich_text` | `text/markdown` or `text/plain`              |
| Gateway content hash     | `rich_text` | Lowercase SHA-256 of the complete body       |

Use property IDs rather than mutable display names. The adapter does not create
or alter schemas. Unknown configuration/request fields, accessors, non-plain
objects, duplicate IDs, invalid roots, controls, and over-limit values fail
closed before provider mutation. Configuration, access, and routed requests are
snapshotted before any provider wait.

## Operation behavior

- **Create:** query the exact target data source for the operation marker, then
  create one page synchronously with all four properties and the complete
  Markdown body. It then retrieves the complete stored Markdown and verifies its
  hash before reporting completion. Any existing marker blocks repeat execution.
- **Update:** retrieve page metadata and the complete current Markdown, verify
  the live body against the stored hash, then re-fetch and re-authorize the exact
  root, version and integrity metadata immediately before updating only the
  requested title/body. A body update uses synchronous `replace_content` and
  verifies the complete returned Markdown plus a final page retrieval.
- **Append:** perform the same live-body integrity check and final target/version
  refresh, enforce the combined-size bound, synchronously insert at the end, and
  verify the exact complete result plus final page metadata.
- **Trash:** perform the same live-body integrity check and final target/version
  refresh, then set the operation marker and `in_trash: true` in one recoverable
  page update. The gateway never permanently deletes a Notion record.

The Notion API used here does not expose an atomic conditional-write precondition
for page or Markdown updates. The adapter therefore performs the strongest
available fresh version comparison immediately before its bounded write sequence,
but a provider-side time-of-check/time-of-use race remains possible. Application
orchestration must serialize gateway operations and treat all ambiguous results
as reconciliation work, never as permission to retry.

Content-bearing update/append writes the operation marker and intended full-body
hash before writing Markdown. This prevents an uncertain append from being
blindly repeated. A failure between those calls may leave metadata ahead of the
body; reconciliation then returns `inconclusive` and requires operator handling.
It must not auto-repair or repeat the provider mutation.

## Bounds and normalized output

- At most 32 governed roots and 32 writable targets are accepted.
- Stable identifiers/property IDs are at most 512 characters.
- Titles use Notion's 2,000-character rich-text limit.
- Complete bodies are limited to 400,000 UTF-8 bytes, below Notion's documented
  request ceiling.
- Create/reconciliation marker queries request at most two pages. More, partial,
  malformed, or incomplete results fail safely.
- Markdown responses must be synchronous, untruncated, contain no unknown block
  IDs, identify the exact page, and remain within the body bound.

Successful results contain only normalized provider ID/version, trusted
canonical location, and SHA-256 integrity metadata. Raw page properties, URLs,
users, provider request IDs, errors, and content are not returned.

## Failure and reconciliation rules

The stable marker is exactly `<operation>:<operationId>`. An uncertain result
includes an opaque reconciliation key bound to operation, authorized root, title
hash, content-type hash, and intended body hash. Reconciliation must run before
any repeated provider execution:

- create queries authorized writable roots for exactly one marker match;
- update/append/trash retrieve the exact stable provider record;
- update/append/create verify marker, root, title, stored hash, content type, and
  the complete current body hash;
- trash verifies marker, root, recoverable-trash state, title, and stored hash;
- no match returns `not_found`; duplicate, partial, malformed, or mismatched
  evidence returns `inconclusive`.

Calling the same provider mutation again after its marker exists returns
non-retryable `idempotency_conflict`. A documented rejection such as validation,
authorization, rate limiting, or conflict becomes sanitized retryable
`provider_unavailable` only when the adapter knows the write was rejected. A
transport/server ambiguity, post-dispatch cancellation, partial response, or
mismatched post-write state returns `outcome: unknown` with reconciliation
evidence. Raw error bodies and abort reasons never escape.

The SDK has no per-call `AbortSignal` for these methods. Cancellation stops
gateway processing and discards late output; it cannot prove that an already
dispatched Notion request stopped. The fixed timeout bounds the SDK wait.

## Isolated development validation

Routine tests use fictional responses and synthetic transport only. Before
runtime composition, prepare an isolated development data source and verify:

1. the integration sees only approved development roots;
2. all four stable property IDs and types match configuration;
3. create, title-only update, body replacement, append, and recoverable trash;
4. stale-version, outside-root, repeated-marker, partial-response, and malformed
   metadata refusal;
5. reconciliation after one deliberately simulated ambiguous create and one
   content mutation; and
6. development credentials cannot access or mutate production content.

Do not use real family records for these probes. Production enablement remains
blocked on isolated development evidence, runtime orchestration, acceptance, and
the production-readiness checklist.

## Verification

```sh
pnpm exec vitest run tests/unit/providers/notion-mutations.test.ts
pnpm verify
TEST_DATABASE_URL="postgresql://gateway_test:<keychain-test-password>@127.0.0.1:55432/family_brain_gateway_test" pnpm test:integration
pnpm audit --prod --audit-level=high
git diff --check
```

Retrieve the existing test-only password from macOS Keychain as documented in
root `STATUS.md`; never print it or place it in repository files. This suite does
not claim a live Notion call, credential, environment composition, or completed
F7.
