import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MutationService } from '../../../src/application/mutation-service.js';
import { ApprovalRequestCoordinator } from '../../../src/application/approval-service.js';
import { ElevationService } from '../../../src/application/elevation-service.js';
import { AuthorizationEngine } from '../../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../../src/domain/authorization/destructive-classifier.js';
import { DomainError } from '../../../src/domain/errors.js';
import {
  brainRecordId,
  operationId,
  principalId,
  providerRecordId,
  requestId,
} from '../../../src/domain/identifiers.js';
import { loadExecutablePolicy } from '../../../src/domain/policy/policy-loader.js';
import { CanonicalRouter } from '../../../src/domain/routing/canonical-router.js';
import type { BrainRecord } from '../../../src/domain/records.js';
import type {
  MutableKnowledgeProvider,
  ProviderMutationResult,
  ProviderFetchRequest,
  ReconciliationRequest,
  ReconciliationResult,
  RoutedUpdate,
} from '../../../src/ports/knowledge-provider.js';
import { FakeMutableKnowledgeProvider } from '../../support/fake-knowledge-providers.js';
import { brainReadPrincipal } from '../../support/brain-read-fixtures.js';
import { SyntheticApprovalStore } from '../../support/synthetic-approval-store.js';

const now = new Date('2042-07-08T09:10:11.000Z');
const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);
const roots = {
  notion: 'notion.family_shared',
  drive: 'drive.family_shared',
} as const;
const surfaces = (Object.entries(roots) as [keyof typeof roots, string][]).map(
  ([provider, containerKey]) => ({
    provider,
    containerKey,
    scope: 'family_shared' as const,
  }),
);

function record(
  provider: keyof typeof roots,
  suffix: string,
  overrides: Partial<BrainRecord> = {},
): BrainRecord {
  return {
    brainRecordId: brainRecordId(`brn_provider_${provider}_${suffix}`),
    title: `Synthetic ${suffix}`,
    excerpt: `Synthetic ${suffix} content`,
    content: `Synthetic ${suffix} content`,
    contentType: 'text/markdown',
    canonicalLocation: {
      provider,
      containerRef: roots[provider],
      displayPath: `Synthetic / ${suffix}`,
    },
    provenance: {
      provider,
      providerRecordId: providerRecordId(`${provider}-record-${suffix}`),
      providerVersion: `${provider}-version-${suffix}`,
      creatorPrincipalId: principalId('prn_operator'),
      createdAt: new Date(now.getTime() - 60_000),
      updatedAt: new Date(now.getTime() - 30_000),
      integrityHash: 'a'.repeat(64),
    },
    policy: {
      scope: 'family_shared',
      sensitivity: 'family_shared',
      protectedClass: 'none',
    },
    ...overrides,
  };
}

function updateRequest(suffix = 'update') {
  return {
    operationId: operationId(`op_${suffix}`),
    requestId: requestId(`req_${suffix}`),
    principalId: principalId('prn_operator'),
    clientId: 'synthetic-client',
    brainRecordId: brainRecordId('brn_gateway_target'),
    mutation: {
      mode: 'patch' as const,
      patch: { title: 'Synthetic revised title' },
    },
  };
}

function requestContext(suffix = 'update') {
  return {
    requestId: requestId(`req_${suffix}`),
    receivedAt: now,
    clientId: 'synthetic-client',
  };
}

function setup(
  target: BrainRecord,
  options: {
    readonly unknown?: boolean;
    readonly interceptUpdate?: (
      provider: MutableKnowledgeProvider,
      request: RoutedUpdate,
      signal: AbortSignal,
    ) => Promise<ProviderMutationResult>;
    readonly interceptFetch?: (
      provider: MutableKnowledgeProvider,
      request: ProviderFetchRequest,
      signal: AbortSignal,
    ) => Promise<BrainRecord>;
    readonly interceptReconcile?: (
      provider: MutableKnowledgeProvider,
      request: ReconciliationRequest,
      signal: AbortSignal,
    ) => Promise<ReconciliationResult>;
  } = {},
) {
  const store = new SyntheticApprovalStore();
  store.seedAlias({
    brainRecordId: brainRecordId('brn_gateway_target'),
    provider: target.provenance.provider,
    providerRecordId: target.provenance.providerRecordId,
    canonicalLocation: target.canonicalLocation,
    createdAt: now,
    updatedAt: now,
  });
  const providers: MutableKnowledgeProvider[] = (
    ['notion', 'drive'] as const
  ).map((provider) => {
    const base = new FakeMutableKnowledgeProvider(
      provider,
      provider === target.provenance.provider ? [target] : [],
      {
        configuredAccess: {
          brainScopes: ['family_shared'],
          rootRefs: [roots[provider]],
        },
        now: () => now,
        ...(options.unknown
          ? { unknownOperationIds: [operationId('op_update')] }
          : {}),
      },
    );
    if (
      provider !== target.provenance.provider ||
      (options.interceptUpdate === undefined &&
        options.interceptFetch === undefined &&
        options.interceptReconcile === undefined)
    ) {
      return base;
    }
    return {
      provider: base.provider,
      search: base.search.bind(base),
      fetch: (request, signal) =>
        options.interceptFetch?.(base, request, signal) ??
        base.fetch(request, signal),
      create: base.create.bind(base),
      update: (request, signal) =>
        options.interceptUpdate?.(base, request, signal) ??
        base.update(request, signal),
      append: base.append.bind(base),
      trash: base.trash.bind(base),
      reconcile: (request, signal) =>
        options.interceptReconcile?.(base, request, signal) ??
        base.reconcile(request, signal),
    };
  });
  const clock = { now: () => now };
  const approvals = new ApprovalRequestCoordinator(
    store,
    {
      findByApprovalRequestId: () => Promise.resolve(null),
      create: () =>
        Promise.resolve({
          providerRecordId: providerRecordId(
            '40000000-0000-4000-8000-000000000003',
          ),
        }),
      update: () => Promise.resolve(),
    },
    clock,
  );
  const service = new MutationService(
    new AuthorizationEngine(policy, clock),
    new DestructiveClassifier(),
    new CanonicalRouter(policy),
    store,
    providers,
    surfaces,
    clock,
    approvals,
    new ElevationService(store, clock),
  );
  return { store, providers, service };
}

describe('MutationService update_record state machine', () => {
  it.each([
    ['a NUL in a patch title', { mode: 'patch', patch: { title: 'a\u0000b' } }],
    [
      'a lone surrogate in patch content',
      { mode: 'patch', patch: { content: 'x\ud800' } },
    ],
    [
      'a NUL in replacement content',
      { mode: 'replace', replacement: { content: 'body\u0000' } },
    ],
    [
      'a lone surrogate in a replacement title',
      { mode: 'replace', replacement: { title: '\udc00', content: 'body' } },
    ],
  ])('rejects %s before opening state', async (_, mutation) => {
    const { store, service } = setup(record('notion', 'unstorable'));

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        { ...updateRequest(), mutation } as ReturnType<typeof updateRequest>,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'invalid_update_mutation' },
    });
    expect(await store.getOperation(operationId('op_update'))).toBeNull();
  });

  it.each(['notion', 'drive'] as const)(
    'freshly authorizes and completes one version-guarded %s update with metadata-only audit',
    async (provider) => {
      const target = record(provider, 'routine');
      const { store, providers, service } = setup(target);

      const response = await service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        updateRequest(),
        new AbortController().signal,
      );

      expect(response).toMatchObject({
        operationId: operationId('op_update'),
        state: 'completed',
        record: {
          provider,
          providerRecordId: target.provenance.providerRecordId,
          canonicalLocation: target.canonicalLocation,
        },
      });
      const selected = providers.find(
        (candidate) => candidate.provider === provider,
      );
      await expect(
        selected?.fetch(
          {
            providerRecordId: target.provenance.providerRecordId,
            access: {
              brainScopes: ['family_shared'],
              rootRefs: [roots[provider]],
            },
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ title: 'Synthetic revised title' });
      expect(store.audits.map(({ operation }) => operation.state)).toEqual([
        'EXECUTING',
        'COMPLETED',
      ]);
      expect(
        JSON.stringify(store.audits.map(({ audit }) => audit)),
      ).not.toContain('Synthetic revised title');
    },
  );

  it('records an unavailable target-reference store as retryable, never internal', async () => {
    const { store, service } = setup(record('notion', 'store-outage'));
    // A dropped database connection surfaces as a raw driver error.
    store.findBrainRecordAlias = () =>
      Promise.reject(new Error('synthetic connection terminated'));

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        updateRequest(),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(await store.getOperation(operationId('op_update'))).toMatchObject({
      state: 'FAILED',
      errorCode: 'provider_unavailable',
    });
    expect(store.audits.at(-1)?.audit.reasonCode).toBe(
      'record_reference_store_unavailable',
    );
  });

  it('reports an unreachable operation store as retryable before any provider call', async () => {
    let providerCalls = 0;
    const { store, service } = setup(record('notion', 'open-outage'), {
      interceptFetch: () => {
        providerCalls += 1;
        return Promise.reject(new Error('unexpected provider fetch'));
      },
      interceptUpdate: () => {
        providerCalls += 1;
        return Promise.reject(new Error('unexpected provider update'));
      },
    });
    store.openOperation = () =>
      Promise.reject(new Error('synthetic connection terminated'));

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        updateRequest(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'operation_state_unavailable' },
    });
    expect(providerCalls).toBe(0);
  });

  it('keeps the store-mapped transition error when the reload also fails', async () => {
    const { store, service } = setup(record('notion', 'transition-outage'));
    // The store maps its own transition failure; the follow-up reload then
    // loses its connection too.
    store.transitionOperationWithAudit = () =>
      Promise.reject(
        new DomainError('provider_unavailable', true, {
          reason: 'operation_audit_state_unavailable',
        }),
      );
    store.getOperation = () =>
      Promise.reject(new Error('synthetic connection terminated'));

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        updateRequest(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'operation_audit_state_unavailable' },
    });
  });

  it('settles a stale never-dispatched update as failed without any provider call', async () => {
    let providerUpdates = 0;
    const { store, service } = setup(record('notion', 'stale-received'), {
      interceptUpdate: (base, request, signal) => {
        providerUpdates += 1;
        return base.update(request, signal);
      },
    });
    const openOperation = store.openOperation.bind(store);
    store.openOperation = async (operation) => {
      await openOperation(operation);
      throw new Error('synthetic connection terminated');
    };
    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        {
          ...requestContext(),
          receivedAt: new Date(now.getTime() - 11 * 60_000),
        },
        updateRequest(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      details: { reason: 'operation_state_unavailable' },
    });
    store.openOperation = openOperation;

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        updateRequest(),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(await store.getOperation(operationId('op_update'))).toMatchObject({
      state: 'FAILED',
      errorCode: 'provider_unavailable',
    });
    expect(store.audits.at(-1)?.audit.reasonCode).toBe(
      'operation_abandoned_before_dispatch',
    );
    expect(providerUpdates).toBe(0);
  });

  it('still answers in progress for a recent never-dispatched update', async () => {
    const { store, service } = setup(record('notion', 'recent-received'));
    const openOperation = store.openOperation.bind(store);
    store.openOperation = async (operation) => {
      await openOperation(operation);
      throw new Error('synthetic connection terminated');
    };
    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        {
          ...requestContext(),
          receivedAt: new Date(now.getTime() - 9 * 60_000),
        },
        updateRequest(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      details: { reason: 'operation_state_unavailable' },
    });
    store.openOperation = openOperation;

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        updateRequest(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ details: { reason: 'operation_in_progress' } });
    expect(await store.getOperation(operationId('op_update'))).toMatchObject({
      state: 'RECEIVED',
    });
  });

  it('returns the stored terminal result without executing a duplicate provider mutation', async () => {
    const target = record('notion', 'replay');
    const { service } = setup(target);
    const request = updateRequest();

    const first = await service.updateRecord(
      brainReadPrincipal(),
      requestContext(),
      request,
      new AbortController().signal,
    );
    const replay = await service.updateRecord(
      brainReadPrincipal(),
      requestContext(),
      { ...request, operationId: operationId('op_client_replay_value') },
      new AbortController().signal,
    );

    expect(replay).toEqual(first);
    expect(replay.operationId).toBe(operationId('op_update'));
  });

  it('rejects the same idempotency key with a different normalized mutation', async () => {
    const { service } = setup(record('notion', 'conflict'));
    await service.updateRecord(
      brainReadPrincipal(),
      requestContext(),
      updateRequest(),
      new AbortController().signal,
    );

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        {
          ...updateRequest(),
          mutation: {
            mode: 'patch',
            patch: { title: 'Different synthetic title' },
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('rejects forged operation identity before opening state or calling a provider', async () => {
    const target = record('drive', 'forged');
    const { store, providers, service } = setup(target);

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        { ...updateRequest(), principalId: principalId('prn_steward') },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'unauthenticated',
      details: { reason: 'operation_identity_mismatch' },
    });
    expect(store.audits).toEqual([]);
    const drive = providers.find((candidate) => candidate.provider === 'drive');
    await expect(
      drive?.fetch(
        {
          providerRecordId: target.provenance.providerRecordId,
          access: {
            brainScopes: ['family_shared'],
            rootRefs: [roots.drive],
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ title: target.title });
  });

  it('uses current provider protection metadata and never dispatches a denied mutation', async () => {
    const target = record('notion', 'governed', {
      policy: {
        scope: 'family_shared',
        sensitivity: 'family_shared',
        protectedClass: 'governance',
      },
    });
    const { store, providers, service } = setup(target);
    const response = await service.updateRecord(
      brainReadPrincipal('family_participant'),
      requestContext(),
      {
        ...updateRequest(),
        principalId: principalId('prn_participant'),
      },
      new AbortController().signal,
    );

    expect(response).toEqual({
      operationId: operationId('op_update'),
      state: 'failed',
    });
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]?.operation.state).toBe('FAILED');
    expect(store.audits[0]?.audit.reasonCode).toBe('control_plane_owner_only');
    const notion = providers.find(
      (candidate) => candidate.provider === 'notion',
    );
    await expect(
      notion?.fetch(
        {
          providerRecordId: target.provenance.providerRecordId,
          access: {
            brainScopes: ['family_shared'],
            rootRefs: [roots.notion],
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ title: target.title });
  });

  it('records an elevation requirement without dispatching a protected parent mutation', async () => {
    const target = record('drive', 'protected', {
      policy: {
        scope: 'family_shared',
        sensitivity: 'protected',
        protectedClass: 'protected',
      },
    });
    const { store, service } = setup(target);

    await expect(
      service.updateRecord(
        brainReadPrincipal('parent_steward'),
        requestContext(),
        { ...updateRequest(), principalId: principalId('prn_operator') },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      operationId: operationId('op_update'),
      state: 'elevation_required',
      elevation: { expiresAt: new Date(now.getTime() + 5 * 60_000) },
    });
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]?.operation.state).toBe('ELEVATION_PENDING');
    expect(store.audits[0]?.audit.reasonCode).toBe(
      'explicit_elevation_required',
    );
  });

  it('reports an unreadable pending operation after the approval is created as retryable', async () => {
    const original = record('notion', 'participant-outage');
    const target: BrainRecord = {
      ...original,
      provenance: {
        ...original.provenance,
        creatorPrincipalId: principalId('prn_participant'),
        createdAt: new Date(now.getTime() - 15 * 60_000 - 1),
      },
    };
    const { store, service } = setup(target);
    const createApproval = store.createApproval.bind(store);
    const getOperation = store.getOperation.bind(store);
    let approvalCreated = false;
    store.createApproval = (approval) => {
      approvalCreated = true;
      return createApproval(approval);
    };
    // Reads work until the approval exists; the follow-up read then fails.
    store.getOperation = (id) =>
      approvalCreated
        ? Promise.reject(new Error('synthetic connection terminated'))
        : getOperation(id);

    await expect(
      service.updateRecord(
        brainReadPrincipal('family_participant'),
        requestContext(),
        {
          ...updateRequest(),
          principalId: principalId('prn_participant'),
          mutation: {
            mode: 'replace',
            replacement: { content: 'Synthetic replacement body' },
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'approval_operation_state_unavailable' },
    });
    expect(await store.listPendingApprovals()).toHaveLength(1);
  });

  it('reports an unreadable pending operation as retryable when a retry creates the approval', async () => {
    const original = record('notion', 'participant-retry-outage');
    const target: BrainRecord = {
      ...original,
      provenance: {
        ...original.provenance,
        creatorPrincipalId: principalId('prn_participant'),
        createdAt: new Date(now.getTime() - 15 * 60_000 - 1),
      },
    };
    const { store, service } = setup(target);
    const createApproval = store.createApproval.bind(store);
    const getOperation = store.getOperation.bind(store);
    let attempt = 0;
    let approvalCreated = false;
    // First request: the approval insert fails, leaving AUTHORIZATION_REQUIRED.
    store.createApproval = (approval) => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(new Error('synthetic connection terminated'));
      }
      approvalCreated = true;
      return createApproval(approval);
    };
    // The retry creates it; the read that follows then fails.
    store.getOperation = (id) =>
      approvalCreated
        ? Promise.reject(new Error('synthetic connection terminated'))
        : getOperation(id);
    const request = {
      ...updateRequest(),
      principalId: principalId('prn_participant'),
      mutation: {
        mode: 'replace' as const,
        replacement: { content: 'Synthetic replacement body' },
      },
    };

    await expect(
      service.updateRecord(
        brainReadPrincipal('family_participant'),
        requestContext(),
        request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      details: { reason: 'approval_state_unavailable' },
    });
    await expect(
      service.updateRecord(
        brainReadPrincipal('family_participant'),
        requestContext(),
        request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'approval_operation_state_unavailable' },
    });
    expect(await store.listPendingApprovals()).toHaveLength(1);
  });

  it('persists an approval requirement for Participant full replacement after exactly fifteen minutes', async () => {
    const original = record('notion', 'participant-window');
    const target: BrainRecord = {
      ...original,
      provenance: {
        ...original.provenance,
        creatorPrincipalId: principalId('prn_participant'),
        createdAt: new Date(now.getTime() - 15 * 60_000 - 1),
      },
    };
    const { store, providers, service } = setup(target);

    await expect(
      service.updateRecord(
        brainReadPrincipal('family_participant'),
        requestContext(),
        {
          ...updateRequest(),
          principalId: principalId('prn_participant'),
          mutation: {
            mode: 'replace',
            replacement: { content: 'Synthetic replacement body' },
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      operationId: operationId('op_update'),
      state: 'approval_required',
    });
    await expect(
      service.updateRecord(
        brainReadPrincipal('family_participant'),
        requestContext(),
        {
          ...updateRequest(),
          principalId: principalId('prn_participant'),
          mutation: {
            mode: 'replace',
            replacement: { content: 'Synthetic replacement body' },
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'approval_required' });
    expect(store.audits).toHaveLength(2);
    expect(store.audits[0]?.operation.state).toBe('AUTHORIZATION_REQUIRED');
    expect(store.audits[0]?.audit.reasonCode).toBe(
      'participant_parent_approval_required',
    );
    expect(store.audits[1]?.operation.state).toBe('APPROVAL_PENDING');
    expect(await store.listPendingApprovals()).toHaveLength(1);
    const notion = providers.find(
      (candidate) => candidate.provider === 'notion',
    );
    await expect(
      notion?.fetch(
        {
          providerRecordId: target.provenance.providerRecordId,
          access: {
            brainScopes: ['family_shared'],
            rootRefs: [roots.notion],
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ content: target.content });
  });

  it('re-enters the same guarded update path after durable parent approval', async () => {
    const original = record('notion', 'approved-continuation');
    const target: BrainRecord = {
      ...original,
      provenance: {
        ...original.provenance,
        creatorPrincipalId: principalId('prn_participant'),
        createdAt: new Date(now.getTime() - 15 * 60_000 - 1),
      },
    };
    const { store, providers, service } = setup(target);
    const participant = brainReadPrincipal('family_participant');
    await service.updateRecord(
      participant,
      requestContext(),
      {
        ...updateRequest(),
        principalId: principalId('prn_participant'),
        mutation: {
          mode: 'replace',
          replacement: { content: 'Synthetic approved replacement' },
        },
      },
      new AbortController().signal,
    );
    const pending = await store.getOperation(operationId('op_update'));
    if (pending === null)
      throw new Error('missing synthetic pending operation');

    await expect(
      service.resumeApprovedUpdate(
        pending,
        participant.principal,
        async (validated) => ({
          disposition: 'resolved',
          operation: await store.transitionOperationWithAudit(
            {
              operationId: validated.operationId,
              expectedStates: ['APPROVAL_PENDING'],
              nextState: 'EXECUTING',
              transitionedAt: now,
            },
            { eventType: 'synthetic', reasonCode: 'synthetic_approved' },
          ),
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });

    const notion = providers.find(
      (candidate) => candidate.provider === 'notion',
    );
    await expect(
      notion?.fetch(
        {
          providerRecordId: target.provenance.providerRecordId,
          access: {
            brainScopes: ['family_shared'],
            rootRefs: [roots.notion],
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ content: 'Synthetic approved replacement' });
  });

  it('reconciles an ambiguous approved update before any replayed mutation', async () => {
    const original = record('notion', 'approved-unknown');
    const target: BrainRecord = {
      ...original,
      provenance: {
        ...original.provenance,
        creatorPrincipalId: principalId('prn_participant'),
        createdAt: new Date(now.getTime() - 15 * 60_000 - 1),
      },
    };
    const { store, service } = setup(target, { unknown: true });
    const participant = brainReadPrincipal('family_participant');
    await service.updateRecord(
      participant,
      requestContext(),
      {
        ...updateRequest(),
        principalId: principalId('prn_participant'),
        mutation: {
          mode: 'replace',
          replacement: { content: 'Synthetic approved unknown replacement' },
        },
      },
      new AbortController().signal,
    );
    const pending = await store.getOperation(operationId('op_update'));
    if (pending === null)
      throw new Error('missing synthetic pending operation');
    const first = await service.resumeApprovedUpdate(
      pending,
      participant.principal,
      async (validated) => ({
        disposition: 'resolved',
        operation: await store.transitionOperationWithAudit(
          {
            operationId: validated.operationId,
            expectedStates: ['APPROVAL_PENDING'],
            nextState: 'EXECUTING',
            transitionedAt: now,
          },
          { eventType: 'synthetic', reasonCode: 'synthetic_approved' },
        ),
      }),
      new AbortController().signal,
    );
    expect(first.state).toBe('outcome_unknown');
    const unknown = await store.getOperation(operationId('op_update'));
    if (unknown === null)
      throw new Error('missing synthetic unknown operation');

    await expect(
      service.reconcileApprovedUpdate(
        unknown,
        participant.principal,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
  });

  async function claimedApproval(harness: ReturnType<typeof setup>) {
    const participant = brainReadPrincipal('family_participant');
    await harness.service.updateRecord(
      participant,
      requestContext(),
      {
        ...updateRequest(),
        principalId: principalId('prn_participant'),
        mutation: {
          mode: 'replace',
          replacement: { content: 'Synthetic recovered replacement' },
        },
      },
      new AbortController().signal,
    );
    const pending = await harness.store.getOperation(operationId('op_update'));
    if (pending === null)
      throw new Error('missing synthetic pending operation');
    expect(pending.state).toBe('APPROVAL_PENDING');
    return { participant, pending };
  }

  function addisonTarget(provider: 'notion' | 'drive', suffix: string) {
    const original = record(provider, suffix);
    return {
      ...original,
      provenance: {
        ...original.provenance,
        creatorPrincipalId: principalId('prn_participant'),
        createdAt: new Date(now.getTime() - 15 * 60_000 - 1),
      },
    } satisfies BrainRecord;
  }

  it('never re-dispatches an approved execution claimed before dispatch when no marker exists', async () => {
    const target = addisonTarget('drive', 'approved-restart');
    let updates = 0;
    const harness = setup(target, {
      interceptUpdate: (provider, request, signal) => {
        updates += 1;
        return provider.update(request, signal);
      },
    });
    const { store, service } = harness;
    const { participant, pending } = await claimedApproval(harness);
    const interrupted = new AbortController();
    await expect(
      service.resumeApprovedUpdate(
        pending,
        participant.principal,
        async (validated) => {
          const executing = await store.transitionOperationWithAudit(
            {
              operationId: validated.operationId,
              expectedStates: ['APPROVAL_PENDING'],
              nextState: 'EXECUTING',
              transitionedAt: now,
            },
            { eventType: 'synthetic', reasonCode: 'synthetic_approved' },
          );
          interrupted.abort();
          return { disposition: 'resolved', operation: executing };
        },
        interrupted.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const executing = await store.getOperation(operationId('op_update'));
    if (executing === null)
      throw new Error('missing synthetic executing operation');

    await expect(
      service.recoverApprovedUpdate(
        executing,
        participant.principal,
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      operationId: operationId('op_update'),
      state: 'outcome_unknown',
    });
    expect(updates).toBe(0);
    const unknown = await store.getOperation(operationId('op_update'));
    expect(unknown).toMatchObject({
      state: 'OUTCOME_UNKNOWN',
      mutationPayload: {
        mode: 'replace',
        replacement: { content: 'Synthetic recovered replacement' },
      },
      resultMetadata: {
        recoveryReason: 'recovery_provider_marker_not_found',
        approvalDecisionReason: 'participant_parent_approval_required',
      },
    });
    expect(store.reconciliationAttempts).toEqual([
      expect.objectContaining({ outcome: 'not_found' }),
    ]);

    // A provider write that lands late is finalized by reconciliation only.
    const drive = harness.providers.find(
      (candidate) => candidate.provider === 'drive',
    );
    await drive?.update(
      {
        operationId: operationId('op_update'),
        access: { brainScopes: ['family_shared'], rootRefs: [roots.drive] },
        providerRecordId: target.provenance.providerRecordId,
        mutation: {
          mode: 'replace',
          replacement: { content: 'Synthetic recovered replacement' },
        },
      },
      new AbortController().signal,
    );
    if (unknown === null) throw new Error('missing synthetic unknown');
    await expect(
      service.reconcileApprovedUpdate(
        unknown,
        participant.principal,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(updates).toBe(1);
  });

  it('finalizes an approved execution whose write landed before the crash', async () => {
    const target = addisonTarget('notion', 'approved-landed');
    let updates = 0;
    let crashAfterWrite = true;
    const harness = setup(target, {
      interceptUpdate: async (provider, request, signal) => {
        updates += 1;
        const result = await provider.update(request, signal);
        if (crashAfterWrite) {
          crashAfterWrite = false;
          throw new Error('synthetic crash after provider write');
        }
        return result;
      },
    });
    const { store, service } = harness;
    const { participant, pending } = await claimedApproval(harness);
    store.failBeforeCommitStates.add('OUTCOME_UNKNOWN');
    await expect(
      service.resumeApprovedUpdate(
        pending,
        participant.principal,
        async (validated) => ({
          disposition: 'resolved',
          operation: await store.transitionOperationWithAudit(
            {
              operationId: validated.operationId,
              expectedStates: ['APPROVAL_PENDING'],
              nextState: 'EXECUTING',
              transitionedAt: now,
            },
            { eventType: 'synthetic', reasonCode: 'synthetic_approved' },
          ),
        }),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(Error);
    const executing = await store.getOperation(operationId('op_update'));
    if (executing?.state !== 'EXECUTING') throw new Error('not stranded');

    await expect(
      service.recoverApprovedUpdate(
        executing,
        participant.principal,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(updates).toBe(1);
    expect(
      (await store.getOperation(operationId('op_update')))?.mutationPayload,
    ).toBeUndefined();
  });

  async function strandedApproval(options: Parameters<typeof setup>[1] = {}) {
    const target = addisonTarget('drive', 'approved-stranded');
    let updates = 0;
    // Interceptors apply only once the approval has been claimed.
    let armed = false;
    const harness = setup(target, {
      interceptFetch: (provider, request, signal) =>
        armed && options.interceptFetch !== undefined
          ? options.interceptFetch(provider, request, signal)
          : provider.fetch(request, signal),
      interceptReconcile: (provider, request, signal) =>
        armed && options.interceptReconcile !== undefined
          ? options.interceptReconcile(provider, request, signal)
          : provider.reconcile(request, signal),
      interceptUpdate: (provider, request, signal) => {
        updates += 1;
        return provider.update(request, signal);
      },
    });
    const { participant, pending } = await claimedApproval(harness);
    const executing = await harness.store.transitionOperationWithAudit(
      {
        operationId: pending.operationId,
        expectedStates: ['APPROVAL_PENDING'],
        nextState: 'EXECUTING',
        transitionedAt: now,
      },
      { eventType: 'synthetic', reasonCode: 'synthetic_approved' },
    );
    armed = true;
    return { ...harness, participant, executing, updates: () => updates };
  }

  it.each([
    [
      'a failed lookup',
      {
        interceptReconcile: () =>
          Promise.reject(new Error('synthetic lookup timeout')),
      },
      'recovery_reconciliation_failed',
    ],
    [
      'an inconclusive lookup',
      {
        interceptReconcile: () =>
          Promise.resolve({ outcome: 'inconclusive' as const }),
      },
      'recovery_reconciliation_inconclusive',
    ],
    [
      'a marker naming another record',
      {
        interceptReconcile: () =>
          Promise.resolve({
            outcome: 'completed' as const,
            record: {
              provider: 'drive' as const,
              providerRecordId: providerRecordId('drive-someone-else'),
              canonicalLocation: {
                provider: 'drive' as const,
                containerRef: 'drive.family_shared',
              },
            },
          }),
      },
      'recovery_provider_reference_invalid',
    ],
    [
      'lost access to the target',
      {
        interceptFetch: () =>
          Promise.reject(
            new DomainError('unauthorized', false, {
              reason: 'record_access_denied',
            }),
          ),
      },
      'recovery_access_unavailable',
    ],
  ] as const)(
    'records an approved recovery with %s as outcome unknown without dispatch',
    async (_, options, recoveryReason) => {
      const harness = await strandedApproval(options);

      await expect(
        harness.service.recoverApprovedUpdate(
          harness.executing,
          harness.participant.principal,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ state: 'outcome_unknown' });
      expect(harness.updates()).toBe(0);
      expect(
        await harness.store.getOperation(harness.executing.operationId),
      ).toMatchObject({
        state: 'OUTCOME_UNKNOWN',
        resultMetadata: { recoveryReason },
      });
    },
  );

  it.each([
    [
      'a transient provider error',
      {
        interceptFetch: () =>
          Promise.reject(
            new DomainError('provider_unavailable', true, {
              reason: 'synthetic_provider_timeout',
            }),
          ),
      },
      false,
    ],
    ['cancellation', {}, true],
  ] as const)(
    'leaves an approved execution untouched on %s',
    async (_, options, cancel) => {
      const harness = await strandedApproval(options);
      const controller = new AbortController();
      if (cancel) controller.abort();

      await expect(
        harness.service.recoverApprovedUpdate(
          harness.executing,
          harness.participant.principal,
          controller.signal,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(harness.updates()).toBe(0);
      expect(
        (await harness.store.getOperation(harness.executing.operationId))
          ?.state,
      ).toBe('EXECUTING');
    },
  );

  it('never dispatches when two approved recoveries race', async () => {
    const harness = await strandedApproval();

    const outcomes = await Promise.allSettled([
      harness.service.recoverApprovedUpdate(
        harness.executing,
        harness.participant.principal,
        new AbortController().signal,
      ),
      harness.service.recoverApprovedUpdate(
        harness.executing,
        harness.participant.principal,
        new AbortController().signal,
      ),
    ]);

    expect(harness.updates()).toBe(0);
    expect(
      outcomes.some(
        (outcome) =>
          outcome.status === 'fulfilled' &&
          outcome.value.state === 'outcome_unknown',
      ),
    ).toBe(true);
    expect(
      (await harness.store.getOperation(harness.executing.operationId))?.state,
    ).toBe('OUTCOME_UNKNOWN');
  });

  it('supersedes an approval when the target version changes while pending', async () => {
    const original = record('notion', 'approval-version-drift');
    const target: BrainRecord = {
      ...original,
      provenance: {
        ...original.provenance,
        creatorPrincipalId: principalId('prn_participant'),
        createdAt: new Date(now.getTime() - 15 * 60_000 - 1),
      },
    };
    let changed = false;
    const { store, service } = setup(target, {
      interceptFetch: async (provider, request, signal) => {
        const current = await provider.fetch(request, signal);
        return changed
          ? {
              ...current,
              provenance: {
                ...current.provenance,
                providerVersion: 'notion-version-changed-while-pending',
              },
            }
          : current;
      },
    });
    const participant = brainReadPrincipal('family_participant');
    await service.updateRecord(
      participant,
      requestContext(),
      {
        ...updateRequest(),
        principalId: principalId('prn_participant'),
        mutation: {
          mode: 'replace',
          replacement: { content: 'Synthetic approved replacement' },
        },
      },
      new AbortController().signal,
    );
    const pending = await store.getOperation(operationId('op_update'));
    if (pending === null) throw new Error('missing pending operation');
    changed = true;

    await expect(
      service.resumeApprovedUpdate(
        pending,
        participant.principal,
        () => Promise.reject(new Error('must not claim stale approval')),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'not_found',
      details: { reason: 'approval_target_changed' },
    });
  });

  it('keeps a recovered approved execution unknown, never failed or re-dispatched, after protection changes', async () => {
    const original = record('drive', 'approval-protection-drift');
    const target: BrainRecord = {
      ...original,
      provenance: {
        ...original.provenance,
        creatorPrincipalId: principalId('prn_participant'),
        createdAt: new Date(now.getTime() - 15 * 60_000 - 1),
      },
    };
    let protectedNow = false;
    let updates = 0;
    const { store, service } = setup(target, {
      interceptFetch: async (provider, request, signal) => {
        const current = await provider.fetch(request, signal);
        return protectedNow
          ? {
              ...current,
              policy: { ...current.policy, protectedClass: 'legal_hold' },
            }
          : current;
      },
      interceptReconcile: () => Promise.resolve({ outcome: 'not_found' }),
      interceptUpdate: (provider, request, signal) => {
        updates += 1;
        return provider.update(request, signal);
      },
    });
    const participant = brainReadPrincipal('family_participant');
    await service.updateRecord(
      participant,
      requestContext(),
      {
        ...updateRequest(),
        principalId: principalId('prn_participant'),
        mutation: {
          mode: 'replace',
          replacement: { content: 'Synthetic approved replacement' },
        },
      },
      new AbortController().signal,
    );
    const pending = await store.getOperation(operationId('op_update'));
    if (pending === null) throw new Error('missing pending operation');
    const executing = await store.transitionOperationWithAudit(
      {
        operationId: pending.operationId,
        expectedStates: ['APPROVAL_PENDING'],
        nextState: 'EXECUTING',
        transitionedAt: now,
      },
      { eventType: 'synthetic', reasonCode: 'synthetic_approved' },
    );
    protectedNow = true;

    // A changed target never proves the claimed write did not happen.
    await expect(
      service.recoverApprovedUpdate(
        executing,
        participant.principal,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    expect(updates).toBe(0);
    expect((await store.getOperation(executing.operationId))?.state).toBe(
      'OUTCOME_UNKNOWN',
    );
  });

  it.each([
    ['title patch', { mode: 'patch' as const, patch: { title: 'Synthetic' } }],
    [
      'content replacement',
      {
        mode: 'replace' as const,
        replacement: { content: 'Synthetic replacement' },
      },
    ],
  ])('never dispatches a %s of legal-hold evidence', async (_, mutation) => {
    const target = record('notion', 'evidence', {
      policy: {
        scope: 'family_shared',
        sensitivity: 'protected',
        protectedClass: 'legal_hold',
      },
    });
    const { store, service, providers } = setup(target);

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        { ...updateRequest(), mutation },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(await store.getOperation(operationId('op_update'))).toMatchObject({
      state: 'FAILED',
      errorCode: 'unauthorized',
    });
    expect(store.audits.at(-1)?.audit.reasonCode).toBe(
      'legal_hold_evidence_immutable',
    );
    await expect(
      providers
        .find((candidate) => candidate.provider === 'notion')
        ?.fetch(
          {
            providerRecordId: target.provenance.providerRecordId,
            access: {
              brainScopes: ['family_shared'],
              rootRefs: [roots.notion],
            },
          },
          new AbortController().signal,
        ),
    ).resolves.toMatchObject({
      title: target.title,
      content: target.content,
    });
  });

  it('fails closed before provider access for a GitHub alias', async () => {
    const { store, service } = setup(record('drive', 'github-read-only'));
    store.seedAlias({
      brainRecordId: brainRecordId('brn_gateway_target'),
      provider: 'github',
      providerRecordId: providerRecordId('github-record-read-only'),
      canonicalLocation: {
        provider: 'github',
        containerRef: 'repo:synthetic-owner/synthetic-project',
      },
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        updateRequest(),
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      operationId: operationId('op_update'),
      state: 'failed',
    });
    expect(store.audits[0]?.audit.reasonCode).toBe('github_read_only');
  });

  it('returns a retryable in-progress error for an existing nonterminal operation', async () => {
    const { store, service } = setup(record('notion', 'in-progress'));
    const request = updateRequest();
    await store.openOperation({
      ...request,
      operation: 'update_record',
      requestFingerprint:
        '9afd0a33e9be19df0b42d17202c4ac4e276377b4cbe2467622ecf58f2b1a7144',
      mutationPayload: request.mutation,
      targetBrainRecordId: request.brainRecordId,
      createdAt: now,
    });

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'operation_in_progress' },
    });
  });

  it('reloads a committed transition after its acknowledgement is lost before provider I/O', async () => {
    const target = record('drive', 'commit-acknowledgement');
    const { store, service } = setup(target);
    store.failAfterCommitStates.add('EXECUTING');

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        updateRequest(),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(store.audits.map(({ operation }) => operation.state)).toEqual([
      'EXECUTING',
      'COMPLETED',
    ]);
  });

  it('records a known provider precondition rejection as failed rather than uncertain', async () => {
    const target = record('notion', 'precondition');
    const { store, service } = setup(target, {
      interceptUpdate: () =>
        Promise.reject(
          new DomainError('provider_unavailable', false, {
            reason: 'provider_version_mismatch',
          }),
        ),
    });

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        updateRequest(),
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      operationId: operationId('op_update'),
      state: 'failed',
    });
    expect(store.audits.map(({ operation }) => operation.state)).toEqual([
      'EXECUTING',
      'FAILED',
    ]);
  });

  it('retains an invalid completed provider reference as outcome unknown', async () => {
    const target = record('drive', 'mismatched-reference');
    const { store, service } = setup(target, {
      interceptUpdate: async (provider, request, signal) => {
        const result = await provider.update(request, signal);
        if (result.outcome === 'unknown') return result;
        return {
          outcome: 'completed',
          record: {
            ...result.record,
            providerRecordId: providerRecordId('drive-record-wrong'),
          },
        };
      },
    });

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        updateRequest(),
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      operationId: operationId('op_update'),
      state: 'outcome_unknown',
    });
    expect(store.audits.map(({ operation }) => operation.state)).toEqual([
      'EXECUTING',
      'OUTCOME_UNKNOWN',
    ]);
  });

  it('reconciles an uncertain provider outcome before replay and never repeats update', async () => {
    const target = record('notion', 'unknown');
    const { store, service } = setup(target, { unknown: true });

    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        updateRequest(),
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      operationId: operationId('op_update'),
      state: 'outcome_unknown',
    });
    await expect(
      service.updateRecord(
        brainReadPrincipal(),
        requestContext(),
        updateRequest(),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      operationId: operationId('op_update'),
      state: 'completed',
      record: { provider: 'notion' },
    });
    expect(store.reconciliationAttempts).toEqual([
      expect.objectContaining({
        operationId: operationId('op_update'),
        attempt: 1,
        outcome: 'completed',
      }),
    ]);
    expect(store.audits.map(({ operation }) => operation.state)).toEqual([
      'EXECUTING',
      'OUTCOME_UNKNOWN',
      'COMPLETED',
    ]);
  });

  it('records one failed reconciliation attempt for an invalid provider reference', async () => {
    const target = record('notion', 'invalid-reconciliation-reference');
    const { store, service } = setup(target, {
      unknown: true,
      interceptReconcile: async (provider, request, signal) => {
        const result = await provider.reconcile(request, signal);
        if (result.outcome !== 'completed') return result;
        return {
          outcome: 'completed',
          record: {
            ...result.record,
            providerRecordId: providerRecordId('notion-record-wrong'),
          },
        };
      },
    });
    const principal = brainReadPrincipal();

    await service.updateRecord(
      principal,
      requestContext(),
      updateRequest(),
      new AbortController().signal,
    );
    await expect(
      service.updateRecord(
        principal,
        requestContext(),
        updateRequest(),
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      operationId: operationId('op_update'),
      state: 'outcome_unknown',
    });
    expect(store.reconciliationAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'failed' }),
    ]);
  });
});
