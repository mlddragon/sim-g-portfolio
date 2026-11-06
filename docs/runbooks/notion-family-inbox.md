# Notion Family Inbox projection

The Family Inbox adapter projects safe approval status into one exactly
configured Notion data source. PostgreSQL remains authoritative for the request,
operation, approval status, and execution state. A Notion row must never be used
as proof that an operation is approved or executable.

## Boundary

The adapter implements only stable-ID lookup plus
`ApprovalProjectionPort.create` and `ApprovalProjectionPort.update`. Its
official SDK surface contains page create/retrieve/update and data-source query;
it does not expose database/data-source mutation, block mutation, generic page
mutation, search, approval resolution, or provider credentials to core code.

Before creating or retrying a projection, the application queries the exact
configured data source for the stable PostgreSQL approval request ID. A reusable
match must also contain the exact operation and request IDs. One exact correlated
match is reused, no match permits one create, and duplicate, mismatched,
incomplete, or malformed results fail closed. This makes an ambiguous create
recoverable without blindly creating a second Inbox row or binding a stale row.

Creation always names the configured Family Inbox `data_source_id`. Before an
update, the adapter retrieves the target and verifies all of the following:

- the page is not in trash;
- its direct parent is the exact configured data source; and
- its configured approval-ID property exactly matches the PostgreSQL approval
  request ID supplied by the application service.

The update writes the approval ID, mapped status, and optional safe resolution
reason only. It cannot move, trash, erase, template, or change arbitrary page
properties. Create and update report success only when the SDK returns a full
post-write page proving the exact parent and approval-ID correlation. A valid
partial response or mismatched post-write state is `outcome_unknown`.

## Required schema configuration

Configure stable Notion property IDs, not mutable display names. The exact data
source must contain these logical fields:

| Logical field          | Notion type | Projected value                                       |
| ---------------------- | ----------- | ----------------------------------------------------- |
| Title                  | `title`     | `Approval: ` plus the already-safe action             |
| Approval request ID    | `rich_text` | Stable PostgreSQL approval request ID                 |
| Operation ID           | `rich_text` | Stable PostgreSQL operation ID                        |
| Request ID             | `rich_text` | Stable gateway request ID                             |
| Requested by           | `rich_text` | Safe requester display name                           |
| Action                 | `rich_text` | Safe human-readable action                            |
| Target                 | `rich_text` | Family-Shared-safe target description                 |
| Status                 | `status`    | Configured option ID for the normalized domain status |
| Safe resolution reason | `rich_text` | Optional Family-Shared-safe reason                    |

Configure one distinct existing status option ID for each domain state:
`pending`, `approved`, `declined`, `cancelled`, `superseded`, and `impossible`.
The human label for `pending` should be `New` for the Example Family Inbox. The
adapter does not create or rename schema properties or status options.

Runtime validation rejects unknown fields, accessors, malformed identifiers,
control characters, blank/space-padded text, duplicate property or status IDs,
and strings beyond these bounds:

- stable identifiers and configuration IDs: 512 characters;
- requester display name: 128 characters;
- action: 256 characters;
- safe target description: 1,000 characters;
- safe resolution reason: 1,000 characters.

Configuration and requests are snapshotted before provider I/O so later caller
mutation cannot expand the outbound data or target another data source.

## Provider setup

Use separate development and production Notion internal connections. Grant only
the content capabilities needed to insert, retrieve, and update rows in the
corresponding Family Inbox test/production data source. Share only explicitly
governed roots with the connection; never grant workspace-wide access merely to
make the adapter work. Keep the token in the environment's server-side secret
provider and keep all IDs and credential values out of client requests.

The official `@notionhq/client` factory pins Notion API version `2026-03-11`, a
five-second request timeout, disabled automatic retries, and a no-op SDK logger.
The current API requires a data-source parent for these structured properties;
property keys may be stable property IDs. See the official
[create page](https://developers.notion.com/reference/post-page),
[update page](https://developers.notion.com/reference/patch-page), and
[page property](https://developers.notion.com/reference/page-property-values)
references before configuring a live schema.

## Failure and reconciliation semantics

The adapter issues at most one provider mutation per method call. A documented
provider rejection such as rate limiting is returned as a sanitized
`provider_unavailable` error. A timeout, transport failure, server-side ambiguous
failure, invalid success response, or cancellation after a mutation is dispatched
returns non-retryable `outcome_unknown`. Raw provider messages, bodies, request
IDs, tokens, and abort reasons are not propagated.

Cancellation before provider dispatch returns a sanitized `AbortError` and sends
no mutation. Cancellation while the pre-update read guard is pending also sends
no update. Cancellation after create/update dispatch is outcome-unknown because
Notion may still complete the request.

Never blindly retry an outcome-unknown create. F11b first looks up the stable
approval request ID and records a unique matched page back into PostgreSQL before
considering another create. PostgreSQL remains authoritative if lookup or
projection is unavailable; replay retries the safe lookup/reconciliation step.
Resolution marks the terminal Inbox projection durably unsynchronized in
PostgreSQL before returning. A confirmed update marks it synchronized; failure or
ambiguous outcome leaves a restart-safe reconciliation item for later replay.

## Verification

Routine tests use only fictional SDK responses and a synthetic transport; they
make no Notion network call:

```sh
pnpm exec vitest run tests/unit/providers/notion-family-inbox.test.ts
pnpm verify
```

Before enabling an environment, separately validate the exact data-source and
property/status IDs, least-privilege connection capabilities, safe visible
content, parent/correlation refusal cases, one successful create/update, and an
outcome-unknown reconciliation exercise using an isolated development Inbox.
No live Notion validation is claimed by the unit suite.
