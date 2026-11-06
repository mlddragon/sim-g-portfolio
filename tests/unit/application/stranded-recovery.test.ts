import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ApprovalRequestCoordinator } from '../../../src/application/approval-service.js';
import { ElevationService } from '../../../src/application/elevation-service.js';
import { MutationService } from '../../../src/application/mutation-service.js';
import { AuthorizationEngine } from '../../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../../src/domain/authorization/destructive-classifier.js';
import {
  brainRecordId,
  elevationChallengeId,
  operationId,
  principalId,
  providerRecordId,
  requestId,
} from '../../../src/domain/identifiers.js';
import type { MutationResponse } from '../../../src/domain/operations.js';
import {
  loadExecutablePolicy,
  type ExecutablePolicy,
} from '../../../src/domain/policy/policy-loader.js';
import type { AuthenticatedPrincipal } from '../../../src/domain/principal.js';
import type { BrainRecord } from '../../../src/domain/records.js';
import { CanonicalRouter } from '../../../src/domain/routing/canonical-router.js';
import type {
  MutableKnowledgeProvider,
  ReconciliationRequest,
  ReconciliationResult,
} from '../../../src/ports/knowledge-provider.js';
import { brainReadPrincipal } from '../../support/brain-read-fixtures.js';
import { FakeMutableKnowledgeProvider } from '../../support/fake-knowledge-providers.js';
import { SyntheticApprovalStore } from '../../support/synthetic-approval-store.js';

const start = new Date('2042-12-13T14:15:16.000Z');
const staleAfterMs = 15 * 60_000;
const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);
const familySurfaces = [
  {
    provider: 'notion' as const,
    containerKey: 'notion.family_shared',
    scope: 'family_shared' as const,
  },
  {
    provider: 'drive' as const,
    containerKey: 'drive.family_shared',
    scope: 'family_shared' as const,
  },
];
const confidential = 'Synthetic confidential stranded text';

function target(overrides: Partial<BrainRecord> = {}): BrainRecord {
  return {
    brainRecordId: brainRecordId('brn_provider_notion_stranded'),
    title: 'Synthetic stranded record',
    excerpt: 'Synthetic stranded body.',
    content: 'Synthetic stranded body.',
    contentType: 'text/markdown',
    canonicalLocation: {
      provider: 'notion',
      containerRef: 'notion.family_shared',
    },
    provenance: {
      provider: 'notion',
      providerRecordId: providerRecordId('notion-record-stranded'),
      providerVersion: 'notion-version-stranded',
      creatorPrincipalId: principalId('prn_operator'),
      createdAt: new Date(start.getTime() - 60 * 60_000),
      updatedAt: new Date(start.getTime() - 30 * 60_000),
    },
    policy: {
      scope: 'family_shared',
      sensitivity: 'family_shared',
      protectedClass: 'none',
    },
    ...overrides,
  };
}

interface Options {
  readonly record?: BrainRecord;
  readonly reconcileOverride?: (
    base: MutableKnowledgeProvider,
    request: ReconciliationRequest,
    signal: AbortSignal,
  ) => Promise<ReconciliationResult>;
}

function setup(options: Options = {}) {
  const record = options.record ?? target();
  let now = start;
  const clock = { now: () => now };
  const store = new SyntheticApprovalStore();
  const operator = brainReadPrincipal();
  const participant = brainReadPrincipal('family_participant');
  store.seedPrincipal(operator.principal);
  store.seedPrincipal(participant.principal);
  store.seedAlias({
    brainRecordId: brainRecordId('brn_gateway_stranded_target'),
    provider: 'notion',
    providerRecordId: record.provenance.providerRecordId,
    canonicalLocation: record.canonicalLocation,
    createdAt: start,
    updatedAt: start,
  });
  const calls = {
    update: 0,
    append: 0,
    trash: 0,
    create: 0,
    reconcile: 0,
  };
  const failNextDispatch = { value: false };
  const gate: { pending?: Promise<void> } = {};
  let notionBase: FakeMutableKnowledgeProvider | undefined;
  const providers: MutableKnowledgeProvider[] = (
    ['notion', 'drive'] as const
  ).map((provider) => {
    const base = new FakeMutableKnowledgeProvider(
      provider,
      provider === 'notion' ? [record] : [],
      {
        configuredAccess: {
          brainScopes: ['family_shared'],
          rootRefs: [`${provider}.family_shared`],
        },
        now: () => now,
      },
    );
    if (provider === 'notion') notionBase = base;
    const dispatch =
      <Request, Result>(
        kind: 'update' | 'append' | 'trash' | 'create',
        call: (request: Request, signal: AbortSignal) => Promise<Result>,
      ) =>
      async (request: Request, signal: AbortSignal) => {
        calls[kind] += 1;
        if (failNextDispatch.value) {
          failNextDispatch.value = false;
          throw new Error('synthetic transport reset');
        }
        // A slow live write lands only after the gate opens.
        if (gate.pending !== undefined) await gate.pending;
        return call(request, signal);
      };
    return {
      provider: base.provider,
      search: base.search.bind(base),
      fetch: base.fetch.bind(base),
      create: dispatch('create', base.create.bind(base)),
      update: dispatch('update', base.update.bind(base)),
      append: dispatch('append', base.append.bind(base)),
      trash: dispatch('trash', base.trash.bind(base)),
      reconcile: (request, signal) => {
        calls.reconcile += 1;
        return (
          options.reconcileOverride?.(base, request, signal) ??
          base.reconcile(request, signal)
        );
      },
    };
  });
  let generated = 0;
  const makeService = (
    selectedPolicy: ExecutablePolicy = policy,
    surfaces: typeof familySurfaces = familySurfaces,
  ) =>
    new MutationService(
      new AuthorizationEngine(selectedPolicy, clock),
      new DestructiveClassifier(),
      new CanonicalRouter(selectedPolicy),
      store,
      providers,
      surfaces,
      clock,
      new ApprovalRequestCoordinator(
        store,
        {
          findByApprovalRequestId: () => Promise.resolve(null),
          create: () =>
            Promise.resolve({
              providerRecordId: providerRecordId(
                '40000000-0000-4000-8000-000000000061',
              ),
            }),
          update: () => Promise.resolve(),
        },
        clock,
      ),
      new ElevationService(store, clock, {
        challengeId: () => {
          generated += 1;
          return elevationChallengeId(`elv_stranded_${String(generated)}`);
        },
        confirmationToken: () =>
          `synthetic-stranded-token-${String(generated)}-${'s'.repeat(32)}`,
      }),
    );
  const fetchTarget = () => {
    if (notionBase === undefined) throw new Error('missing synthetic notion');
    return notionBase.fetch(
      {
        providerRecordId: record.provenance.providerRecordId,
        access: {
          brainScopes: ['family_shared'],
          rootRefs: ['notion.family_shared'],
        },
      },
      new AbortController().signal,
    );
  };
  return {
    store,
    calls,
    operator,
    participant,
    failNextDispatch,
    gate,
    service: makeService(),
    makeService,
    fetchTarget,
    notionBase: () => {
      if (notionBase === undefined) throw new Error('missing synthetic notion');
      return notionBase;
    },
    advance: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

type Harness = ReturnType<typeof setup>;
const signal = () => new AbortController().signal;

function context(
  principal: AuthenticatedPrincipal,
  suffix: string,
): {
  requestId: ReturnType<typeof requestId>;
  receivedAt: Date;
  clientId: string;
} {
  return {
    requestId: requestId(`req_${principal.principal.key}_${suffix}`),
    receivedAt: start,
    clientId: 'synthetic-client',
  };
}

function identity(principal: AuthenticatedPrincipal, suffix: string) {
  return {
    operationId: operationId(`op_${principal.principal.key}_${suffix}`),
    requestId: requestId(`req_${principal.principal.key}_${suffix}`),
    principalId: principal.principal.id,
    clientId: 'synthetic-client',
  };
}

type Kind = 'update' | 'append' | 'delete' | 'create';

function submit(
  harness: Harness,
  kind: Kind,
  principal: AuthenticatedPrincipal = harness.operator,
  extra: Record<string, unknown> = {},
): Promise<MutationResponse> {
  const ids = identity(principal, kind);
  const ctx = context(principal, kind);
  const brainRecord = brainRecordId('brn_gateway_stranded_target');
  switch (kind) {
    case 'update':
      return harness.service.updateRecord(
        principal,
        ctx,
        {
          ...ids,
          brainRecordId: brainRecord,
          mutation: { mode: 'patch', patch: { title: confidential } },
          ...extra,
        },
        signal(),
      );
    case 'append':
      return harness.service.appendToRecord(
        principal,
        ctx,
        { ...ids, brainRecordId: brainRecord, content: `\n${confidential}` },
        signal(),
      );
    case 'delete':
      return harness.service.deleteRecord(
        principal,
        ctx,
        { ...ids, brainRecordId: brainRecord, explicitIntent: true },
        signal(),
      );
    case 'create':
      return harness.service.persistKnowledge(
        principal,
        ctx,
        {
          ...ids,
          title: 'Synthetic stranded create',
          content: confidential,
          semanticMetadata: {
            recordType: 'knowledge',
            durability: 'durable',
            sensitivity: 'family_shared',
          },
        },
        signal(),
      );
  }
}

/** Write lands at the provider, then the COMPLETED commit is lost. */
async function strandAfterWrite(harness: Harness, kind: Kind) {
  harness.store.failBeforeCommitStates.add('COMPLETED');
  await expect(submit(harness, kind)).rejects.toBeInstanceOf(Error);
  const stranded = await harness.store.getOperation(
    operationId(`op_operator_${kind}`),
  );
  expect(stranded?.state).toBe('EXECUTING');
}

/** The provider call fails ambiguously and the OUTCOME_UNKNOWN commit is lost. */
async function strandWithoutWrite(harness: Harness, kind: Kind) {
  harness.failNextDispatch.value = true;
  harness.store.failBeforeCommitStates.add('OUTCOME_UNKNOWN');
  await expect(submit(harness, kind)).rejects.toBeInstanceOf(Error);
  const stranded = await harness.store.getOperation(
    operationId(`op_operator_${kind}`),
  );
  expect(stranded?.state).toBe('EXECUTING');
}

function recover(
  harness: Harness,
  kind: Kind,
  service = harness.service,
  operator: AuthenticatedPrincipal = harness.operator,
) {
  return service.recoverStrandedExecution(
    operator,
    context(operator, `recover_${kind}`),
    { operationId: operationId(`op_operator_${kind}`), staleAfterMs },
    signal(),
  );
}

function writes(harness: Harness): number {
  const { update, append, trash, create } = harness.calls;
  return update + append + trash + create;
}

describe('MutationService reconcile-only stranded execution recovery', () => {
  it.each(['update', 'append', 'delete', 'create'] as const)(
    'finalizes a stranded %s whose provider marker proves completion, without dispatching again',
    async (kind) => {
      const harness = setup();
      await strandAfterWrite(harness, kind);
      expect(writes(harness)).toBe(1);
      harness.advance(staleAfterMs);

      const result = await recover(harness, kind);

      expect(result).toMatchObject({
        operationId: operationId(`op_operator_${kind}`),
        disposition: 'completed',
        state: 'COMPLETED',
      });
      expect(writes(harness)).toBe(1);
      const settled = await harness.store.getOperation(
        operationId(`op_operator_${kind}`),
      );
      expect(settled?.state).toBe('COMPLETED');
      expect(settled?.mutationPayload).toBeUndefined();
      await expect(submit(harness, kind)).resolves.toMatchObject({
        state: 'completed',
      });
      expect(writes(harness)).toBe(1);
    },
  );

  it.each(['update', 'append', 'delete', 'create'] as const)(
    'keeps a stranded %s without a marker outcome-unknown and never re-dispatches',
    async (kind) => {
      const harness = setup();
      await strandWithoutWrite(harness, kind);
      const attempted = writes(harness);
      harness.advance(staleAfterMs);

      await expect(recover(harness, kind)).resolves.toMatchObject({
        disposition: 'outcome_unknown',
        state: 'OUTCOME_UNKNOWN',
        reasonCode: 'recovery_provider_marker_not_found',
      });
      expect(writes(harness)).toBe(attempted);
      const unknown = await harness.store.getOperation(
        operationId(`op_operator_${kind}`),
      );
      expect(unknown?.resultMetadata).toMatchObject({
        recoveryReason: 'recovery_provider_marker_not_found',
      });
      if (kind === 'update') {
        // The in-flight payload survives for later reconciliation.
        expect(unknown?.mutationPayload).toEqual({
          mode: 'patch',
          patch: { title: confidential },
        });
      }
      expect(harness.store.reconciliationAttempts.at(-1)).toMatchObject({
        outcome: 'not_found',
      });
    },
  );

  it('reconciles a delayed provider write on a later client replay', async () => {
    const harness = setup();
    await strandWithoutWrite(harness, 'update');
    harness.advance(staleAfterMs);
    await recover(harness, 'update');
    await harness.notionBase().update(
      {
        operationId: operationId('op_operator_update'),
        access: {
          brainScopes: ['family_shared'],
          rootRefs: ['notion.family_shared'],
        },
        providerRecordId: providerRecordId('notion-record-stranded'),
        expectedProviderVersion: 'notion-version-stranded',
        mutation: { mode: 'patch', patch: { title: confidential } },
      },
      signal(),
    );

    await expect(submit(harness, 'update')).resolves.toMatchObject({
      state: 'completed',
    });
    await expect(harness.fetchTarget()).resolves.toMatchObject({
      title: confidential,
    });
  });

  it('finalizes a stranded elevated confirmation by its marker only', async () => {
    const harness = setup({
      record: target({
        policy: {
          scope: 'family_shared',
          sensitivity: 'protected',
          protectedClass: 'protected',
        },
      }),
    });
    const challenged = await submit(harness, 'update');
    if (challenged.elevation === undefined) throw new Error('missing grant');
    harness.store.failBeforeCommitStates.add('COMPLETED');
    await expect(
      submit(harness, 'update', harness.operator, {
        elevation: {
          challengeId: challenged.elevation.challengeId,
          confirmationToken: challenged.elevation.confirmationToken,
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    harness.advance(staleAfterMs);

    await expect(recover(harness, 'update')).resolves.toMatchObject({
      disposition: 'completed',
    });
    expect(harness.calls.update).toBe(1);
  });

  it('leaves approval-claimed executions to the approval recovery path', async () => {
    const harness = setup({
      record: target({
        policy: {
          scope: 'family_shared',
          sensitivity: 'protected',
          protectedClass: 'protected',
        },
      }),
    });
    await submit(harness, 'update', harness.participant);
    await harness.store.transitionOperationWithAudit(
      {
        operationId: operationId('op_participant_update'),
        expectedStates: ['APPROVAL_PENDING'],
        nextState: 'EXECUTING',
        transitionedAt: start,
      },
      { eventType: 'synthetic', reasonCode: 'synthetic_approved' },
    );
    harness.advance(staleAfterMs);

    await expect(
      harness.service.recoverStrandedExecution(
        harness.operator,
        context(harness.operator, 'recover_approved'),
        { operationId: operationId('op_participant_update'), staleAfterMs },
        signal(),
      ),
    ).resolves.toMatchObject({
      disposition: 'approval_recovery_required',
      state: 'EXECUTING',
    });
    expect(harness.calls.reconcile).toBe(0);
  });

  it('refuses a recovery attempt before the stale threshold', async () => {
    const harness = setup();
    await strandAfterWrite(harness, 'update');
    harness.advance(staleAfterMs - 1);

    await expect(recover(harness, 'update')).resolves.toMatchObject({
      disposition: 'not_stale',
      state: 'EXECUTING',
    });
    expect(harness.calls.reconcile).toBe(0);
  });

  it.each([
    ['too small', 899_999],
    ['fractional', 900_000.5],
  ])('rejects a %s stale threshold', async (_, threshold) => {
    const harness = setup();
    await expect(
      harness.service.recoverStrandedExecution(
        harness.operator,
        context(harness.operator, 'recover_invalid'),
        {
          operationId: operationId('op_operator_update'),
          staleAfterMs: threshold,
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it.each(['parent_steward', 'family_participant'] as const)(
    'allows only the owner operator to invoke recovery, not %s',
    async (role) => {
      const harness = setup();
      await strandAfterWrite(harness, 'update');
      harness.advance(staleAfterMs);
      const caller = brainReadPrincipal(role);

      await expect(
        harness.service.recoverStrandedExecution(
          caller,
          context(caller, 'recover_forbidden'),
          { operationId: operationId('op_operator_update'), staleAfterMs },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'unauthorized' });
      expect(harness.calls.reconcile).toBe(0);
    },
  );

  it('reports an operation that is not executing without changing it', async () => {
    const harness = setup();
    await submit(harness, 'update');
    harness.advance(staleAfterMs);

    await expect(recover(harness, 'update')).resolves.toMatchObject({
      disposition: 'not_executing',
      state: 'COMPLETED',
    });
    await expect(
      harness.service.recoverStrandedExecution(
        harness.operator,
        context(harness.operator, 'recover_missing'),
        { operationId: operationId('op_missing'), staleAfterMs },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it.each([
    [
      'a failed lookup',
      () => Promise.reject(new Error('synthetic lookup timeout')),
      'recovery_reconciliation_failed',
      'failed',
    ],
    [
      'an inconclusive lookup',
      () => Promise.resolve({ outcome: 'inconclusive' } as const),
      'recovery_reconciliation_inconclusive',
      'inconclusive',
    ],
  ] as const)(
    'treats %s as unresolved, never as proof that no write occurred',
    async (_, override, reasonCode, outcome) => {
      const harness = setup({ reconcileOverride: override });
      await strandAfterWrite(harness, 'update');
      harness.advance(staleAfterMs);

      await expect(recover(harness, 'update')).resolves.toMatchObject({
        disposition: 'outcome_unknown',
        reasonCode,
      });
      expect(harness.calls.update).toBe(1);
      expect(harness.store.reconciliationAttempts.at(-1)).toMatchObject({
        outcome,
      });
    },
  );

  it('keeps a completion for a different record outcome-unknown', async () => {
    const harness = setup({
      reconcileOverride: async (base, request, abort) => {
        const result = await base.reconcile(request, abort);
        return result.outcome === 'completed'
          ? {
              outcome: 'completed',
              record: {
                ...result.record,
                providerRecordId: providerRecordId('notion-record-other'),
              },
            }
          : result;
      },
    });
    await strandAfterWrite(harness, 'update');
    harness.advance(staleAfterMs);

    await expect(recover(harness, 'update')).resolves.toMatchObject({
      disposition: 'outcome_unknown',
      reasonCode: 'recovery_provider_reference_invalid',
    });
  });

  it('never consults the provider when the original principal is disabled', async () => {
    const harness = setup();
    await strandAfterWrite(harness, 'update');
    harness.store.seedPrincipal({
      ...harness.operator.principal,
      status: 'disabled',
    });
    harness.advance(staleAfterMs);

    await expect(recover(harness, 'update')).resolves.toMatchObject({
      disposition: 'outcome_unknown',
      reasonCode: 'recovery_principal_unavailable',
    });
    expect(harness.calls.reconcile).toBe(0);
  });

  it.each(['update', 'create'] as const)(
    'never consults the provider for a stranded %s after access loss',
    async (kind) => {
      const harness = setup();
      await strandAfterWrite(harness, kind);
      harness.advance(staleAfterMs);
      const restricted = harness.makeService(
        policy,
        familySurfaces.filter(({ provider }) => provider !== 'notion'),
      );

      await expect(recover(harness, kind, restricted)).resolves.toMatchObject({
        disposition: 'outcome_unknown',
        reasonCode: 'recovery_access_unavailable',
      });
      expect(harness.calls.reconcile).toBe(0);
    },
  );

  it('keeps a stranded create unknown when the canonical route has drifted', async () => {
    const harness = setup();
    await strandAfterWrite(harness, 'create');
    harness.advance(staleAfterMs);
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
      recover(harness, 'create', harness.makeService(moved)),
    ).resolves.toMatchObject({
      disposition: 'outcome_unknown',
      reasonCode: 'recovery_route_changed',
    });
    expect(harness.calls.reconcile).toBe(0);
  });

  it('finalizes a proven write even after an executable policy version change', async () => {
    const harness = setup();
    await strandAfterWrite(harness, 'update');
    harness.advance(staleAfterMs);

    await expect(
      recover(
        harness,
        'update',
        harness.makeService({
          ...policy,
          version: 'family-brain-v1.1.1-synthetic',
        }),
      ),
    ).resolves.toMatchObject({ disposition: 'completed' });
    expect(harness.calls.update).toBe(1);
  });

  it('yields to a concurrent executor that settles the operation first', async () => {
    const holder: { harness?: Harness } = {};
    const harness = setup({
      reconcileOverride: async () => {
        const current = holder.harness;
        if (current === undefined) throw new Error('missing harness');
        await current.store.transitionOperationWithAudit(
          {
            operationId: operationId('op_operator_update'),
            expectedStates: ['EXECUTING'],
            nextState: 'COMPLETED',
            provider: 'notion',
            providerRecordId: providerRecordId('notion-record-stranded'),
            resultMetadata: { canonicalContainerRef: 'notion.family_shared' },
            transitionedAt: start,
          },
          { eventType: 'synthetic', reasonCode: 'synthetic_live_completion' },
        );
        return { outcome: 'not_found' };
      },
    });
    holder.harness = harness;
    await strandWithoutWrite(harness, 'update');
    harness.advance(staleAfterMs);

    await expect(recover(harness, 'update')).resolves.toMatchObject({
      disposition: 'not_executing',
      state: 'COMPLETED',
    });
    expect(
      (await harness.store.getOperation(operationId('op_operator_update')))
        ?.state,
    ).toBe('COMPLETED');
  });

  it('tolerates a lost acknowledgement on its own transition', async () => {
    const harness = setup();
    await strandWithoutWrite(harness, 'update');
    harness.advance(staleAfterMs);
    harness.store.failAfterCommitStates.add('OUTCOME_UNKNOWN');

    await expect(recover(harness, 'update')).resolves.toMatchObject({
      disposition: 'outcome_unknown',
    });
    await expect(recover(harness, 'update')).resolves.toMatchObject({
      disposition: 'not_executing',
      state: 'OUTCOME_UNKNOWN',
    });
  });

  it('records metadata-only audit for the operator and the transition', async () => {
    const harness = setup();
    await strandAfterWrite(harness, 'append');
    harness.advance(staleAfterMs);
    await recover(harness, 'append');

    const recovery = harness.store.auditEvents.filter(
      ({ eventType }) => eventType === 'brain.operation.recovery',
    );
    expect(recovery).toMatchObject([
      {
        principalId: harness.operator.principal.id,
        operationId: operationId('op_operator_append'),
        operation: 'append_to_record',
        outcome: 'COMPLETED',
        reasonCode: 'recovery_provider_marker_completed',
      },
    ]);
    expect(
      JSON.stringify([
        harness.store.auditEvents,
        harness.store.audits.map(({ audit }) => audit),
        harness.store.reconciliationAttempts,
      ]),
    ).not.toContain(confidential);
  });

  it('gives a slow live executor a retryable outcome when recovery settled first', async () => {
    const harness = setup();
    let release: () => void = () => undefined;
    harness.gate.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const live = submit(harness, 'update');
    // Wait until the live executor has claimed EXECUTING and is mid-write.
    while (harness.calls.update === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    harness.advance(staleAfterMs);

    await expect(recover(harness, 'update')).resolves.toMatchObject({
      disposition: 'outcome_unknown',
      reasonCode: 'recovery_provider_marker_not_found',
    });
    delete harness.gate.pending;
    release();

    await expect(live).resolves.toEqual({
      operationId: operationId('op_operator_update'),
      state: 'outcome_unknown',
    });
    await expect(submit(harness, 'update')).resolves.toMatchObject({
      state: 'completed',
    });
    expect(harness.calls.update).toBe(1);
  });

  it('leaves the operation executing when the operator cancels recovery', async () => {
    const harness = setup();
    await strandAfterWrite(harness, 'update');
    harness.advance(staleAfterMs);
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      harness.service.recoverStrandedExecution(
        harness.operator,
        context(harness.operator, 'recover_cancelled'),
        { operationId: operationId('op_operator_update'), staleAfterMs },
        aborted.signal,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(
      (await harness.store.getOperation(operationId('op_operator_update')))
        ?.state,
    ).toBe('EXECUTING');
  });

  it('reports a settlement made by someone else as not its own', async () => {
    const holder: { harness?: Harness } = {};
    const harness = setup({
      reconcileOverride: async () => {
        const current = holder.harness;
        if (current === undefined) throw new Error('missing harness');
        await current.store.transitionOperationWithAudit(
          {
            operationId: operationId('op_operator_update'),
            expectedStates: ['EXECUTING'],
            nextState: 'OUTCOME_UNKNOWN',
            transitionedAt: start,
          },
          { eventType: 'synthetic', reasonCode: 'synthetic_live_unknown' },
        );
        return { outcome: 'not_found' };
      },
    });
    holder.harness = harness;
    await strandWithoutWrite(harness, 'update');
    harness.advance(staleAfterMs);

    await expect(recover(harness, 'update')).resolves.toMatchObject({
      disposition: 'not_executing',
      state: 'OUTCOME_UNKNOWN',
    });
  });

  it.each(['append', 'delete'] as const)(
    'leaves an approval-claimed %s to the approval recovery path',
    async (kind) => {
      const harness = setup({
        record: target({
          policy: {
            scope: 'family_shared',
            sensitivity: 'protected',
            protectedClass: 'protected',
          },
        }),
      });
      await expect(
        submit(harness, kind, harness.participant),
      ).resolves.toMatchObject({ state: 'approval_required' });
      await harness.store.transitionOperationWithAudit(
        {
          operationId: operationId(`op_participant_${kind}`),
          expectedStates: ['APPROVAL_PENDING'],
          nextState: 'EXECUTING',
          transitionedAt: start,
        },
        { eventType: 'synthetic', reasonCode: 'synthetic_approved' },
      );
      harness.advance(staleAfterMs);

      await expect(
        harness.service.recoverStrandedExecution(
          harness.operator,
          context(harness.operator, `recover_approved_${kind}`),
          { operationId: operationId(`op_participant_${kind}`), staleAfterMs },
          signal(),
        ),
      ).resolves.toMatchObject({ disposition: 'approval_recovery_required' });
      expect(harness.calls.reconcile).toBe(0);
    },
  );

  it('keeps a stranded create unknown when its marker is in another container', async () => {
    const harness = setup({
      reconcileOverride: async (base, request, abort) => {
        const result = await base.reconcile(request, abort);
        return result.outcome === 'completed'
          ? {
              outcome: 'completed',
              record: {
                ...result.record,
                canonicalLocation: {
                  ...result.record.canonicalLocation,
                  containerRef: 'notion.parent_and_stewardship',
                },
              },
            }
          : result;
      },
    });
    await strandAfterWrite(harness, 'create');
    harness.advance(staleAfterMs);

    await expect(recover(harness, 'create')).resolves.toMatchObject({
      disposition: 'outcome_unknown',
      reasonCode: 'recovery_provider_reference_invalid',
    });
    // Only the seeded target alias exists; no alias for a foreign marker.
    expect(harness.store.aliasCount()).toBe(1);
  });
});
