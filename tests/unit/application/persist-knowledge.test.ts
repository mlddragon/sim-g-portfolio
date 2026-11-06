import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MutationService } from '../../../src/application/mutation-service.js';
import type { RegisteredKnowledgeSurface } from '../../../src/domain/authorization/authorization-engine.js';
import { AuthorizationEngine } from '../../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../../src/domain/authorization/destructive-classifier.js';
import { DomainError } from '../../../src/domain/errors.js';
import {
  operationId,
  principalId,
  requestId,
} from '../../../src/domain/identifiers.js';
import type {
  PersistKnowledgeRequest,
  SemanticMetadata,
} from '../../../src/domain/operations.js';
import {
  loadExecutablePolicy,
  type ExecutablePolicy,
} from '../../../src/domain/policy/policy-loader.js';
import type { AuthenticatedPrincipal } from '../../../src/domain/principal.js';
import { CanonicalRouter } from '../../../src/domain/routing/canonical-router.js';
import type {
  MutableKnowledgeProvider,
  ProviderMutationResult,
  RoutedCreate,
} from '../../../src/ports/knowledge-provider.js';
import { brainReadPrincipal } from '../../support/brain-read-fixtures.js';
import { FakeMutableKnowledgeProvider } from '../../support/fake-knowledge-providers.js';
import { SyntheticMutationStore } from '../../support/synthetic-mutation-store.js';

const now = new Date('2042-09-10T11:12:13.000Z');
const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);
const familySurfaces: readonly RegisteredKnowledgeSurface[] = [
  {
    provider: 'notion',
    containerKey: 'notion.family_shared',
    scope: 'family_shared',
  },
  {
    provider: 'drive',
    containerKey: 'drive.family_shared',
    scope: 'family_shared',
  },
  {
    provider: 'notion',
    containerKey: 'notion.parent_and_stewardship',
    scope: 'parent_and_stewardship',
  },
  {
    provider: 'notion',
    containerKey: 'notion.protected',
    scope: 'legal',
  },
];
const confidentialContent = 'Synthetic persisted household procedure body';

const knowledge: SemanticMetadata = {
  subject: 'synthetic chore rotation',
  recordType: 'knowledge',
  durability: 'durable',
  sensitivity: 'family_shared',
};

function persistRequest(
  authenticated: AuthenticatedPrincipal = brainReadPrincipal(),
  overrides: Partial<PersistKnowledgeRequest> = {},
): PersistKnowledgeRequest {
  return {
    operationId: operationId(`op_${authenticated.principal.key}_persist`),
    requestId: requestId(`req_${authenticated.principal.key}_persist`),
    principalId: authenticated.principal.id,
    clientId: 'synthetic-client',
    title: 'Synthetic chore rotation',
    content: confidentialContent,
    semanticMetadata: knowledge,
    ...overrides,
  };
}

function context(authenticated: AuthenticatedPrincipal = brainReadPrincipal()) {
  return {
    requestId: requestId(`req_${authenticated.principal.key}_persist`),
    receivedAt: now,
    clientId: 'synthetic-client',
  };
}

interface Options {
  readonly unknownOperationIds?: readonly ReturnType<typeof operationId>[];
  readonly surfaces?: readonly RegisteredKnowledgeSurface[];
  readonly createOverride?: (
    base: MutableKnowledgeProvider,
    request: RoutedCreate,
    signal: AbortSignal,
  ) => Promise<ProviderMutationResult>;
}

function setup(options: Options = {}) {
  const store = new SyntheticMutationStore();
  const calls = { create: 0, reconcile: 0 };
  const bases = new Map<'notion' | 'drive', FakeMutableKnowledgeProvider>();
  const providers: MutableKnowledgeProvider[] = (
    ['notion', 'drive'] as const
  ).map((provider) => {
    const base = new FakeMutableKnowledgeProvider(provider, [], {
      configuredAccess: {
        brainScopes: ['family_shared', 'parent_and_stewardship', 'legal'],
        rootRefs: Object.values(policy.routing.containers[provider]),
      },
      now: () => now,
      ...(options.unknownOperationIds === undefined
        ? {}
        : { unknownOperationIds: options.unknownOperationIds }),
    });
    bases.set(provider, base);
    return {
      provider: base.provider,
      search: base.search.bind(base),
      fetch: base.fetch.bind(base),
      create: (createRequest, signal) => {
        calls.create += 1;
        return (
          options.createOverride?.(base, createRequest, signal) ??
          base.create(createRequest, signal)
        );
      },
      update: base.update.bind(base),
      append: base.append.bind(base),
      trash: base.trash.bind(base),
      reconcile: (reconcileRequest, signal) => {
        calls.reconcile += 1;
        return base.reconcile(reconcileRequest, signal);
      },
    };
  });
  const clock = { now: () => now };
  const makeService = (
    selectedPolicy: ExecutablePolicy = policy,
    surfaces: readonly RegisteredKnowledgeSurface[] = options.surfaces ??
      familySurfaces,
  ) =>
    new MutationService(
      new AuthorizationEngine(selectedPolicy, clock),
      new DestructiveClassifier(),
      new CanonicalRouter(selectedPolicy),
      store,
      providers,
      surfaces,
      clock,
    );
  const search = (provider: 'notion' | 'drive', query: string) => {
    const base = bases.get(provider);
    if (base === undefined) throw new Error('missing synthetic provider');
    return base.search(
      {
        query,
        limit: 10,
        access: {
          brainScopes: ['family_shared', 'parent_and_stewardship', 'legal'],
          rootRefs: Object.values(policy.routing.containers[provider]),
        },
      },
      new AbortController().signal,
    );
  };
  return { store, calls, service: makeService(), makeService, search };
}

const signal = () => new AbortController().signal;

describe('MutationService persist_knowledge', () => {
  // The open commits but its acknowledgement is lost: the operation stays
  // RECEIVED, and no provider write was ever dispatched.
  async function strandOpened(
    harness: ReturnType<typeof setup>,
    ageMs: number,
  ) {
    const openOperation = harness.store.openOperation.bind(harness.store);
    harness.store.openOperation = async (record) => {
      await openOperation(record);
      throw new Error('synthetic connection terminated');
    };
    await expect(
      harness.service.persistKnowledge(
        brainReadPrincipal(),
        { ...context(), receivedAt: new Date(now.getTime() - ageMs) },
        persistRequest(),
        signal(),
      ),
    ).rejects.toMatchObject({
      details: { reason: 'operation_state_unavailable' },
    });
    harness.store.openOperation = openOperation;
  }

  it('settles a stale never-dispatched operation as failed instead of in progress forever', async () => {
    const harness = setup();
    await strandOpened(harness, 11 * 60_000);

    const retry = await harness.service.persistKnowledge(
      brainReadPrincipal(),
      context(),
      persistRequest(),
      signal(),
    );

    expect(retry).toMatchObject({ state: 'failed' });
    expect(
      await harness.store.getOperation(operationId('op_operator_persist')),
    ).toMatchObject({ state: 'FAILED', errorCode: 'provider_unavailable' });
    expect(harness.calls.create).toBe(0);
    // A further retry replays the settled result.
    await expect(
      harness.service.persistKnowledge(
        brainReadPrincipal(),
        context(),
        persistRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
  });

  it('still answers in progress for a recent never-dispatched operation', async () => {
    const harness = setup();
    // Older than any configurable request deadline (120 s), but not stale.
    await strandOpened(harness, 9 * 60_000);

    await expect(
      harness.service.persistKnowledge(
        brainReadPrincipal(),
        context(),
        persistRequest(),
        signal(),
      ),
    ).rejects.toMatchObject({ details: { reason: 'operation_in_progress' } });
    expect(
      await harness.store.getOperation(operationId('op_operator_persist')),
    ).toMatchObject({ state: 'RECEIVED' });
  });

  it('settles exactly at the stale threshold', async () => {
    const harness = setup();
    await strandOpened(harness, 10 * 60_000);

    await expect(
      harness.service.persistKnowledge(
        brainReadPrincipal(),
        context(),
        persistRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
  });

  it('settles once when two retries race, and both answer failed', async () => {
    const harness = setup();
    await strandOpened(harness, 11 * 60_000);

    const retries = await Promise.all(
      [0, 1].map(() =>
        harness.service.persistKnowledge(
          brainReadPrincipal(),
          context(),
          persistRequest(),
          signal(),
        ),
      ),
    );

    expect(retries).toMatchObject([{ state: 'failed' }, { state: 'failed' }]);
    expect(
      harness.store.audits.filter(
        ({ audit }) =>
          audit.reasonCode === 'operation_abandoned_before_dispatch',
      ),
    ).toHaveLength(1);
    expect(harness.calls.create).toBe(0);
  });

  it('answers in progress, retryably, when the original claims the operation first', async () => {
    const harness = setup();
    await strandOpened(harness, 11 * 60_000);
    // The original request, still running, claims EXECUTING just before the
    // retry's settle.
    const transition = harness.store.transitionOperationWithAudit.bind(
      harness.store,
    );
    let claimed = false;
    harness.store.transitionOperationWithAudit = async (input, audit) => {
      if (!claimed && input.nextState === 'FAILED') {
        claimed = true;
        await transition(
          { ...input, nextState: 'EXECUTING' },
          { ...audit, reasonCode: 'synthetic_original_claim' },
        );
      }
      return transition(input, audit);
    };

    await expect(
      harness.service.persistKnowledge(
        brainReadPrincipal(),
        context(),
        persistRequest(),
        signal(),
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'operation_in_progress' },
    });
    expect(
      await harness.store.getOperation(operationId('op_operator_persist')),
    ).toMatchObject({ state: 'EXECUTING' });
  });

  it('never dispatches from a lingering original after a retry settled it', async () => {
    const harness = setup();
    const openOperation = harness.store.openOperation.bind(harness.store);
    let release: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened: () => void = () => undefined;
    const openedOnce = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let first = true;
    harness.store.openOperation = async (record) => {
      const result = await openOperation(record);
      if (first) {
        first = false;
        opened();
        await paused;
      }
      return result;
    };
    const original = harness.service.persistKnowledge(
      brainReadPrincipal(),
      { ...context(), receivedAt: new Date(now.getTime() - 11 * 60_000) },
      persistRequest(),
      signal(),
    );
    await openedOnce;

    await expect(
      harness.service.persistKnowledge(
        brainReadPrincipal(),
        context(),
        persistRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    release();

    await expect(original).rejects.toBeInstanceOf(DomainError);
    expect(harness.calls.create).toBe(0);
    expect(
      await harness.store.getOperation(operationId('op_operator_persist')),
    ).toMatchObject({ state: 'FAILED' });
  });

  it('reports an unreachable operation store as retryable, never internal', async () => {
    const harness = setup();
    // A dropped database connection surfaces as a raw driver error. The insert
    // may or may not have committed; a retry with the same request ID resumes.
    harness.store.openOperation = () =>
      Promise.reject(new Error('synthetic connection terminated'));

    const attempt = harness.service.persistKnowledge(
      brainReadPrincipal(),
      context(),
      persistRequest(),
      signal(),
    );

    await expect(attempt).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'operation_state_unavailable' },
    });
    await expect(attempt).rejects.not.toThrow(
      'synthetic connection terminated',
    );
    expect(harness.calls.create).toBe(0);
  });

  it.each([
    ['knowledge', 'notion', 'notion.family_shared'],
    ['source_document', 'drive', 'drive.family_shared'],
  ] as const)(
    'routes %s to %s, creates once and registers a stable alias',
    async (recordType, provider, containerRef) => {
      const harness = setup();
      const operator = brainReadPrincipal();

      const response = await harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(operator, {
          semanticMetadata: { ...knowledge, recordType },
        }),
        signal(),
      );

      expect(response).toMatchObject({
        operationId: operationId('op_operator_persist'),
        state: 'completed',
        record: { provider, canonicalLocation: { provider, containerRef } },
      });
      expect(response.brainRecordId).toMatch(/^brn_/u);
      expect(harness.calls.create).toBe(1);
      const created = await harness.search(provider, 'chore rotation');
      expect(created.records).toMatchObject([
        {
          canonicalLocation: { containerRef },
          policy: {
            scope: 'family_shared',
            sensitivity: 'family_shared',
            protectedClass: 'none',
          },
        },
      ]);
      const alias = harness.store.aliasFor(
        provider,
        response.record?.providerRecordId,
      );
      expect(alias?.brainRecordId).toBe(response.brainRecordId);
      expect(
        harness.store.audits.map(({ operation }) => operation.state),
      ).toEqual(['EXECUTING', 'COMPLETED']);
      expect(
        JSON.stringify(harness.store.audits.map(({ audit }) => audit)),
      ).not.toContain(confidentialContent);
    },
  );

  it('replays a duplicate request without creating a second record', async () => {
    const harness = setup();
    const operator = brainReadPrincipal();
    const first = await harness.service.persistKnowledge(
      operator,
      context(),
      persistRequest(),
      signal(),
    );

    const replay = await harness.service.persistKnowledge(
      operator,
      context(),
      persistRequest(operator, {
        operationId: operationId('op_ignored_replay'),
      }),
      signal(),
    );

    expect(replay).toEqual(first);
    expect(harness.calls.create).toBe(1);
  });

  it('rejects the same request ID with different content', async () => {
    const harness = setup();
    const operator = brainReadPrincipal();
    await harness.service.persistKnowledge(
      operator,
      context(),
      persistRequest(),
      signal(),
    );

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(operator, { content: 'Synthetic different body' }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(harness.calls.create).toBe(1);
  });

  it.each([
    [
      'insufficient_metadata',
      { subject: 'synthetic', recordType: 'knowledge' },
      { missing: ['durability', 'sensitivity'] },
    ],
    [
      'routing_ambiguous',
      { ...knowledge, canonicalHint: { provider: 'drive' } },
      { candidates: ['notion', 'drive'] },
    ],
    [
      'provider_capability_unsupported',
      { ...knowledge, canonicalHint: { provider: 'github' } },
      { reason: 'github_read_only' },
    ],
  ] as const)(
    'returns structured %s before opening any operation',
    async (code, semanticMetadata, details) => {
      const harness = setup();
      const operator = brainReadPrincipal();

      await expect(
        harness.service.persistKnowledge(
          operator,
          context(),
          persistRequest(operator, { semanticMetadata }),
          signal(),
        ),
      ).rejects.toMatchObject({ code, details });
      expect(
        await harness.store.getOperation(operationId('op_operator_persist')),
      ).toBeNull();
      expect(harness.calls.create).toBe(0);

      await expect(
        harness.service.persistKnowledge(
          operator,
          context(),
          persistRequest(),
          signal(),
        ),
      ).resolves.toMatchObject({ state: 'completed' });
    },
  );

  it.each([
    ['an extra metadata field', { ...knowledge, creator: 'prn_steward' }],
    ['a non-string metadata value', { ...knowledge, subject: 7 }],
    ['an unknown sensitivity', { ...knowledge, sensitivity: 'public' }],
    ['a NUL in a metadata value', { ...knowledge, subject: 'a\u0000b' }],
    [
      'a lone surrogate in a canonical hint',
      { ...knowledge, canonicalHint: { containerRef: 'x\udfff' } },
    ],
  ])('rejects %s before opening state', async (_, semanticMetadata) => {
    const harness = setup();
    const operator = brainReadPrincipal();

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(operator, {
          semanticMetadata: semanticMetadata as unknown as SemanticMetadata,
        }),
        signal(),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'invalid_persist_request' },
    });
    expect(
      await harness.store.getOperation(operationId('op_operator_persist')),
    ).toBeNull();
  });

  it('rejects an empty or unstorable title or body before opening state', async () => {
    const harness = setup();
    const operator = brainReadPrincipal();
    for (const overrides of [
      { title: '' },
      { content: '' },
      { title: 'Synthetic\u0000title' },
      { content: 'Synthetic\ud800body' },
    ]) {
      await expect(
        harness.service.persistKnowledge(
          operator,
          context(),
          persistRequest(operator, overrides),
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(harness.calls.create).toBe(0);
  });

  it('rejects forged operation identity before opening state', async () => {
    const harness = setup();
    const operator = brainReadPrincipal();

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(operator, { principalId: principalId('prn_steward') }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(harness.calls.create).toBe(0);
  });

  it('lets Participant persist Family Shared knowledge but never parent-only knowledge', async () => {
    const harness = setup();
    const participant = brainReadPrincipal('family_participant');

    await expect(
      harness.service.persistKnowledge(
        participant,
        context(participant),
        persistRequest(participant),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });

    const parentOnly = setup();
    await expect(
      parentOnly.service.persistKnowledge(
        participant,
        context(participant),
        persistRequest(participant, {
          semanticMetadata: {
            ...knowledge,
            sensitivity: 'parent_and_stewardship',
          },
        }),
        signal(),
      ),
    ).resolves.toEqual({
      operationId: operationId('op_participant_persist'),
      state: 'failed',
    });
    expect(
      await parentOnly.store.getOperation(
        operationId('op_participant_persist'),
      ),
    ).toMatchObject({ state: 'FAILED', errorCode: 'unauthorized' });
    expect(parentOnly.calls.create).toBe(0);
  });

  it('records the gateway creator so Participant can correct her own new record', async () => {
    const harness = setup();
    const participant = brainReadPrincipal('family_participant');
    const created = await harness.service.persistKnowledge(
      participant,
      context(participant),
      persistRequest(participant),
      signal(),
    );
    if (created.brainRecordId === undefined) {
      throw new Error('missing synthetic created alias');
    }
    expect(
      harness.store.aliasFor('notion', created.record?.providerRecordId),
    ).toMatchObject({ creatorPrincipalId: participant.principal.id });

    await expect(
      harness.service.updateRecord(
        participant,
        {
          requestId: requestId('req_participant_correction'),
          receivedAt: now,
          clientId: 'synthetic-client',
        },
        {
          operationId: operationId('op_participant_correction'),
          requestId: requestId('req_participant_correction'),
          principalId: participant.principal.id,
          clientId: 'synthetic-client',
          brainRecordId: created.brainRecordId,
          mutation: {
            mode: 'replace',
            replacement: { content: 'Synthetic corrected chore rotation' },
          },
        },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(
      harness.store.audits.find(
        ({ operation }) =>
          operation.operationId === operationId('op_participant_correction') &&
          operation.state === 'EXECUTING',
      )?.audit.reasonCode,
    ).toBe('participant_creator_correction_window');
  });

  it.each([
    ['a conflicting container hint', { containerRef: 'notion.restricted' }],
    ['an empty hint', {}],
  ])('rejects %s before opening state', async (_, canonicalHint) => {
    const harness = setup();
    const operator = brainReadPrincipal();
    await expect(
      harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(operator, {
          semanticMetadata: { ...knowledge, canonicalHint },
        }),
        signal(),
      ),
    ).rejects.toBeInstanceOf(DomainError);
    expect(
      await harness.store.getOperation(operationId('op_operator_persist')),
    ).toBeNull();
  });

  it('rejects oversized metadata, title and body before opening state', async () => {
    const harness = setup();
    const operator = brainReadPrincipal();
    for (const overrides of [
      { semanticMetadata: { ...knowledge, subject: 's'.repeat(513) } },
      { title: 't'.repeat(2_001) },
      { content: 'c'.repeat(1_048_577) },
    ]) {
      await expect(
        harness.service.persistKnowledge(
          operator,
          context(),
          persistRequest(operator, overrides),
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(harness.calls.create).toBe(0);
  });

  it('fails closed for a container registered under more than one scope', async () => {
    const harness = setup({
      surfaces: [
        ...familySurfaces,
        {
          provider: 'notion',
          containerKey: 'notion.family_shared',
          scope: 'parent_and_stewardship',
        },
      ],
    });
    const operator = brainReadPrincipal();
    await expect(
      harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(harness.calls.create).toBe(0);
  });

  it('treats a provider outcome_unknown error as uncertain, not failed', async () => {
    const harness = setup({
      createOverride: () =>
        Promise.reject(new DomainError('outcome_unknown', false)),
    });
    const operator = brainReadPrincipal();
    await expect(
      harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
  });

  it('fails closed for a routed container with no registered surface', async () => {
    const harness = setup();
    const operator = brainReadPrincipal();

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(operator, {
          semanticMetadata: { ...knowledge, sensitivity: 'restricted' },
        }),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(
      await harness.store.getOperation(operationId('op_operator_persist')),
    ).toMatchObject({ state: 'FAILED', errorCode: 'unauthorized' });
    expect(harness.calls.create).toBe(0);
  });

  it('never creates an elevation-gated record when no elevation workflow is configured', async () => {
    const harness = setup();
    const operator = brainReadPrincipal();

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(operator, {
          semanticMetadata: { ...knowledge, sensitivity: 'protected' },
        }),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    // Never stranded in ELEVATION_PENDING without a way to confirm.
    expect(
      await harness.store.getOperation(operationId('op_operator_persist')),
    ).toMatchObject({ state: 'FAILED', errorCode: 'internal_error' });
    expect(harness.calls.create).toBe(0);
  });

  it('reconciles an uncertain create on replay without creating twice', async () => {
    const harness = setup({
      unknownOperationIds: [operationId('op_operator_persist')],
    });
    const operator = brainReadPrincipal();

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(),
        signal(),
      ),
    ).resolves.toEqual({
      operationId: operationId('op_operator_persist'),
      state: 'outcome_unknown',
    });
    const reconciled = await harness.service.persistKnowledge(
      operator,
      context(),
      persistRequest(),
      signal(),
    );

    expect(reconciled).toMatchObject({ state: 'completed' });
    expect(reconciled.brainRecordId).toMatch(/^brn_/u);
    expect(harness.calls.create).toBe(1);
    expect(harness.calls.reconcile).toBe(1);
    expect((await harness.search('notion', 'chore')).records).toHaveLength(1);
    expect(harness.store.reconciliationAttempts).toMatchObject([
      { outcome: 'completed' },
    ]);
  });

  it('never re-creates when reconciliation finds no record', async () => {
    const harness = setup({
      createOverride: () => Promise.reject(new Error('synthetic timeout')),
    });
    const operator = brainReadPrincipal();
    await harness.service.persistKnowledge(
      operator,
      context(),
      persistRequest(),
      signal(),
    );

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    expect(harness.calls.create).toBe(1);
    expect(harness.store.reconciliationAttempts).toMatchObject([
      { outcome: 'not_found' },
    ]);
  });

  it('refuses reconciliation after the canonical route changes', async () => {
    const harness = setup({
      unknownOperationIds: [operationId('op_operator_persist')],
    });
    const operator = brainReadPrincipal();
    await harness.service.persistKnowledge(
      operator,
      context(),
      persistRequest(),
      signal(),
    );
    const moved: ExecutablePolicy = {
      ...policy,
      routing: {
        ...policy.routing,
        containers: {
          ...policy.routing.containers,
          notion: {
            ...policy.routing.containers.notion,
            family_shared: 'notion.parent_and_stewardship',
          },
        },
      },
    };

    await expect(
      harness
        .makeService(moved)
        .persistKnowledge(operator, context(), persistRequest(), signal()),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    expect(harness.calls.reconcile).toBe(0);
  });

  it('refuses reconciliation after the principal loses the routed surface', async () => {
    const harness = setup({
      unknownOperationIds: [operationId('op_operator_persist')],
    });
    const operator = brainReadPrincipal();
    await harness.service.persistKnowledge(
      operator,
      context(),
      persistRequest(),
      signal(),
    );

    await expect(
      harness
        .makeService(
          policy,
          familySurfaces.filter(
            ({ containerKey }) => containerKey !== 'notion.family_shared',
          ),
        )
        .persistKnowledge(operator, context(), persistRequest(), signal()),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    expect(harness.calls.reconcile).toBe(0);
  });

  it('records a known provider rejection as failed', async () => {
    const harness = setup({
      createOverride: () =>
        Promise.reject(
          new DomainError('invalid_request', false, {
            reason: 'synthetic_provider_rejected',
          }),
        ),
    });
    const operator = brainReadPrincipal();

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(
      await harness.store.getOperation(operationId('op_operator_persist')),
    ).toMatchObject({ state: 'FAILED', errorCode: 'invalid_request' });
  });

  it('keeps a completion in the wrong container as outcome unknown', async () => {
    const harness = setup({
      createOverride: async (base, createRequest, abort) => {
        const result = await base.create(createRequest, abort);
        if (result.outcome !== 'completed') return result;
        return {
          outcome: 'completed',
          record: {
            ...result.record,
            canonicalLocation: {
              ...result.record.canonicalLocation,
              containerRef: 'notion.parent_and_stewardship',
            },
          },
        };
      },
    });
    const operator = brainReadPrincipal();

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    expect(harness.store.aliasCount()).toBe(0);
  });

  it('registers the alias on replay when registration failed after completion', async () => {
    const harness = setup();
    const operator = brainReadPrincipal();
    harness.store.failNextAlias = true;

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(),
        persistRequest(),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(
      (await harness.store.getOperation(operationId('op_operator_persist')))
        ?.state,
    ).toBe('COMPLETED');

    const replay = await harness.service.persistKnowledge(
      operator,
      context(),
      persistRequest(),
      signal(),
    );
    expect(replay).toMatchObject({ state: 'completed' });
    expect(replay.brainRecordId).toMatch(/^brn_/u);
    expect(harness.calls.create).toBe(1);
    expect(harness.store.aliasCount()).toBe(1);
  });

  it('records the routed provider, but never the body, in audits or state', async () => {
    const harness = setup();
    const operator = brainReadPrincipal();
    await harness.service.persistKnowledge(
      operator,
      context(),
      persistRequest(),
      signal(),
    );
    expect(JSON.stringify(harness.store.audits)).not.toContain(
      confidentialContent,
    );
    expect(
      (await harness.store.getOperation(operationId('op_operator_persist')))
        ?.mutationPayload,
    ).toBeUndefined();
    expect(
      harness.store.audits.map(({ operation }) => operation.provider),
    ).toEqual(['notion', 'notion']);
    expect(harness.store.audits.at(-1)?.operation.providerRecordId).toEqual(
      expect.any(String),
    );
  });
});
