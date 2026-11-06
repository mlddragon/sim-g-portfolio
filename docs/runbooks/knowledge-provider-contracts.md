# Knowledge-provider contracts and synthetic fakes

The provider contract harness defines the common behavior that Notion, Drive,
and GitHub adapters must preserve without forcing mutation symmetry onto GitHub.
It is reusable test code, not a provider implementation or runtime content store.

## Files and test shape

- `tests/contract/knowledge-provider.contract.ts` exports fetchable and mutable
  contract functions. Like the identity-provider contract, it is instantiated by
  adapter or fake test files rather than executed directly by Vitest.
- `tests/support/fake-knowledge-providers.ts` contains isolated in-memory test
  doubles. `FakeFetchableKnowledgeProvider` can represent GitHub, Notion, or
  Drive; `FakeMutableKnowledgeProvider` is type-limited to Notion and Drive.
- `tests/unit/providers/fake-knowledge-providers.test.ts` runs the shared contract
  against all three fictional provider surfaces.

Future real adapter tests should instantiate the same contract using isolated
development roots and fictional records. Provider-specific behavior belongs in
additional adapter tests, not in the common contract.

## Enforced behavior

The shared tests and fakes exercise:

- normalized summaries and targeted full fetch with stable IDs, canonical
  location, provenance, policy metadata, and completeness;
- exact intersection of the request's server-derived access with the adapter's
  independently configured Brain scopes and roots;
- non-disclosure of records outside either boundary and fixed safe errors for an
  attempted access expansion;
- stripping of provider-native objects from every result;
- already-cancelled search, fetch, mutation, and reconciliation;
- Notion/Drive create, update, append, recoverable trash, version preconditions,
  uncertain outcomes, and reconciliation;
- rejection of repeated provider mutation attempts, so the fake cannot hide a
  gateway idempotency defect; and
- GitHub read-only capability at both the TypeScript and runtime surfaces.

The fake snapshots its configured access and seed records. Returned records are
normalized copies, so test callers cannot acquire provider-native fields through
fixture object aliasing. All fixtures are fictional and use reserved example
identifiers.

## Limits

These fakes do not model provider APIs, pagination, rate limits, native query
quality, permissions, or durable state. Their `complete` search marker means only
that the in-memory operation completed; it is not evidence that a future Notion,
Drive, or GitHub search is exhaustive. They do not prove live root isolation,
Project Registry membership, service identity, IAM, credential provenance, or
restart persistence.

Gateway application tests must own idempotency and never retry an ambiguous
mutation. The fake intentionally returns `idempotency_conflict` if the same
provider operation ID is executed twice; callers must use `reconcile` after an
`unknown` result. PostgreSQL remains authoritative for gateway operational state.

## Verification

```sh
pnpm exec vitest run tests/unit/providers/fake-knowledge-providers.test.ts
pnpm verify
pnpm test:integration
pnpm audit --prod --audit-level=high
git diff --check
```

`pnpm test:integration` requires the loopback `_test` database described in
[`database-migrations.md`](database-migrations.md). No provider credential or
network connection is required for this contract slice.
