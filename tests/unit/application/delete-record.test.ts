import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ApprovalRequestCoordinator } from '../../../src/application/approval-service.js';
import { ElevationService } from '../../../src/application/elevation-service.js';
import { MutationService } from '../../../src/application/mutation-service.js';
import { AuthorizationEngine } from '../../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../../src/domain/authorization/destructive-classifier.js';
import { DomainError } from '../../../src/domain/errors.js';
import {
  brainRecordId,
  elevationChallengeId,
  operationId,
  principalId,
  providerRecordId,
  requestId,
} from '../../../src/domain/identifiers.js';
import type {
  DeleteRecordRequest,
  MutationResponse,
} from '../../../src/domain/operations.js';
import { loadExecutablePolicy } from '../../../src/domain/policy/policy-loader.js';
import type { AuthenticatedPrincipal } from '../../../src/domain/principal.js';
import type { BrainRecord } from '../../../src/domain/records.js';
import { CanonicalRouter } from '../../../src/domain/routing/canonical-router.js';
import type {
  MutableKnowledgeProvider,
  ProviderMutationResult,
  RoutedTrash,
} from '../../../src/ports/knowledge-provider.js';
import { brainReadPrincipal } from '../../support/brain-read-fixtures.js';
import { FakeMutableKnowledgeProvider } from '../../support/fake-knowledge-providers.js';
import { SyntheticApprovalStore } from '../../support/synthetic-approval-store.js';

const now = new Date('2042-11-12T13:14:15.000Z');
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
  {
    provider: 'notion' as const,
    containerKey: 'notion.parent_and_stewardship',
    scope: 'parent_and_stewardship' as const,
  },
];

function target(
  provider: 'notion' | 'drive' = 'notion',
  overrides: Partial<BrainRecord> = {},
): BrainRecord {
  return {
    brainRecordId: brainRecordId(`brn_provider_${provider}_delete`),
    title: 'Synthetic duplicate grocery list',
    excerpt: 'Synthetic duplicate',
    content: 'Synthetic duplicate',
    contentType: 'text/markdown',
    canonicalLocation: {
      provider,
      containerRef: `${provider}.family_shared`,
    },
    provenance: {
      provider,
      providerRecordId: providerRecordId(`${provider}-record-delete`),
      providerVersion: `${provider}-version-delete`,
      creatorPrincipalId: principalId('prn_operator'),
      createdAt: new Date(now.getTime() - 60 * 60_000),
      updatedAt: new Date(now.getTime() - 30 * 60_000),
      integrityHash: 'd'.repeat(64),
    },
    policy: {
      scope: 'family_shared',
      sensitivity: 'family_shared',
      protectedClass: 'none',
    },
    ...overrides,
  };
}

function addisonRecent(elapsedMs: number): BrainRecord {
  const base = target();
  return {
    ...base,
    provenance: {
      ...base.provenance,
      creatorPrincipalId: principalId('prn_participant'),
      createdAt: new Date(now.getTime() - elapsedMs),
    },
  };
}

function deleteRequest(
  authenticated: AuthenticatedPrincipal = brainReadPrincipal(),
  overrides: Partial<DeleteRecordRequest> = {},
): DeleteRecordRequest {
  return {
    operationId: operationId(`op_${authenticated.principal.key}_delete`),
    requestId: requestId(`req_${authenticated.principal.key}_delete`),
    principalId: authenticated.principal.id,
    clientId: 'synthetic-client',
    brainRecordId: brainRecordId('brn_gateway_delete_target'),
    explicitIntent: true,
    ...overrides,
  };
}

function context(authenticated: AuthenticatedPrincipal = brainReadPrincipal()) {
  return {
    requestId: requestId(`req_${authenticated.principal.key}_delete`),
    receivedAt: now,
    clientId: 'synthetic-client',
  };
}

interface Options {
  readonly unknownOperationIds?: readonly ReturnType<typeof operationId>[];
  readonly trashOverride?: (
    base: MutableKnowledgeProvider,
    request: RoutedTrash,
    signal: AbortSignal,
  ) => Promise<ProviderMutationResult>;
  readonly aliasProvider?: 'github';
  readonly aliasCreator?: ReturnType<typeof principalId>;
}

function setup(record: BrainRecord, options: Options = {}) {
  const store = new SyntheticApprovalStore();
  store.seedAlias({
    brainRecordId: brainRecordId('brn_gateway_delete_target'),
    provider: options.aliasProvider ?? record.provenance.provider,
    providerRecordId: record.provenance.providerRecordId,
    canonicalLocation:
      options.aliasProvider === undefined
        ? record.canonicalLocation
        : { provider: 'github', containerRef: 'github.synthetic' },
    ...(options.aliasCreator === undefined
      ? {}
      : { creatorPrincipalId: options.aliasCreator }),
    createdAt: now,
    updatedAt: now,
  });
  const calls = { trash: 0, update: 0, append: 0, reconcile: 0 };
  let selected: FakeMutableKnowledgeProvider | undefined;
  const providers: MutableKnowledgeProvider[] = (
    ['notion', 'drive'] as const
  ).map((provider) => {
    const base = new FakeMutableKnowledgeProvider(
      provider,
      provider === record.provenance.provider ? [record] : [],
      {
        configuredAccess: {
          brainScopes: ['family_shared', 'parent_and_stewardship'],
          rootRefs: [
            `${provider}.family_shared`,
            `${provider}.parent_and_stewardship`,
          ],
        },
        now: () => now,
        ...(options.unknownOperationIds === undefined
          ? {}
          : { unknownOperationIds: options.unknownOperationIds }),
      },
    );
    if (provider === record.provenance.provider) selected = base;
    return {
      provider: base.provider,
      search: base.search.bind(base),
      fetch: base.fetch.bind(base),
      create: base.create.bind(base),
      update: (request, signal) => {
        calls.update += 1;
        return base.update(request, signal);
      },
      append: (request, signal) => {
        calls.append += 1;
        return base.append(request, signal);
      },
      trash: (request, signal) => {
        calls.trash += 1;
        return (
          options.trashOverride?.(base, request, signal) ??
          base.trash(request, signal)
        );
      },
      reconcile: (request, signal) => {
        calls.reconcile += 1;
        return base.reconcile(request, signal);
      },
    };
  });
  const clock = { now: () => now };
  let generated = 0;
  const makeService = (surfaces = familySurfaces) =>
    new MutationService(
      new AuthorizationEngine(policy, clock),
      new DestructiveClassifier(),
      new CanonicalRouter(policy),
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
                '40000000-0000-4000-8000-000000000021',
              ),
            }),
          update: () => Promise.resolve(),
        },
        clock,
      ),
      new ElevationService(store, clock, {
        challengeId: () => {
          generated += 1;
          return elevationChallengeId(`elv_delete_${String(generated)}`);
        },
        confirmationToken: () =>
          `synthetic-delete-token-${String(generated)}-${'d'.repeat(32)}`,
      }),
    );
  const present = async () => {
    if (selected === undefined) throw new Error('missing synthetic provider');
    try {
      await selected.fetch(
        {
          providerRecordId: record.provenance.providerRecordId,
          access: {
            brainScopes: [record.policy.scope],
            rootRefs: [record.canonicalLocation.containerRef],
          },
        },
        new AbortController().signal,
      );
      return true;
    } catch {
      return false;
    }
  };
  const providerFor = () => {
    const found = providers.find(
      (candidate) => candidate.provider === record.provenance.provider,
    );
    if (found === undefined) throw new Error('missing synthetic provider');
    return found;
  };
  return {
    store,
    calls,
    service: makeService(),
    makeService,
    present,
    providerFor,
  };
}

const signal = () => new AbortController().signal;

function grantOf(response: MutationResponse) {
  if (response.elevation === undefined) {
    throw new Error('missing synthetic elevation grant');
  }
  return {
    challengeId: response.elevation.challengeId,
    confirmationToken: response.elevation.confirmationToken,
  };
}

describe('MutationService delete_record', () => {
  it.each(['notion', 'drive'] as const)(
    'moves one explicitly identified %s record to recoverable trash for a parent',
    async (provider) => {
      const harness = setup(target(provider));
      const parent = brainReadPrincipal('parent_steward');

      await expect(
        harness.service.deleteRecord(
          parent,
          context(parent),
          deleteRequest(parent),
          signal(),
        ),
      ).resolves.toMatchObject({
        operationId: operationId('op_operator_delete'),
        state: 'completed',
        record: { provider },
      });
      expect(harness.calls).toMatchObject({ trash: 1, update: 0, append: 0 });
      expect(await harness.present()).toBe(false);
      expect(
        harness.store.audits.map(({ operation, audit }) => [
          operation.state,
          audit.reasonCode,
        ]),
      ).toEqual([
        ['EXECUTING', 'routine_authorized'],
        ['COMPLETED', 'provider_mutation_completed'],
      ]);
      expect(
        (await harness.store.getOperation(operationId('op_operator_delete')))
          ?.mutationPayload,
      ).toBeUndefined();
    },
  );

  it.each([
    ['missing', undefined],
    ['false', false],
  ])(
    'rejects %s explicit intent before opening state',
    async (_, explicitIntent) => {
      const harness = setup(target());
      const operator = brainReadPrincipal();
      const request = {
        ...deleteRequest(),
        explicitIntent,
      } as unknown as DeleteRecordRequest;

      await expect(
        harness.service.deleteRecord(operator, context(), request, signal()),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        details: { reason: 'explicit_delete_intent_required' },
      });
      expect(
        await harness.store.getOperation(operationId('op_operator_delete')),
      ).toBeNull();
    },
  );

  it('replays a completed delete without trashing twice', async () => {
    const harness = setup(target());
    const operator = brainReadPrincipal();
    const first = await harness.service.deleteRecord(
      operator,
      context(),
      deleteRequest(),
      signal(),
    );

    await expect(
      harness.service.deleteRecord(
        operator,
        context(),
        deleteRequest(operator, { operationId: operationId('op_ignored') }),
        signal(),
      ),
    ).resolves.toEqual(first);
    expect(harness.calls.trash).toBe(1);
  });

  it.each([
    ['within the window', 5 * 60_000, 'completed'],
    ['at exactly fifteen minutes', 15 * 60_000, 'completed'],
    ['one millisecond after the window', 15 * 60_000 + 1, 'approval_required'],
  ] as const)(
    'applies Participant creator correction %s',
    async (_, elapsed, state) => {
      const harness = setup(addisonRecent(elapsed));
      const participant = brainReadPrincipal('family_participant');

      await expect(
        harness.service.deleteRecord(
          participant,
          context(participant),
          deleteRequest(participant),
          signal(),
        ),
      ).resolves.toMatchObject({ state });
      expect(harness.calls.trash).toBe(state === 'completed' ? 1 : 0);
      if (state === 'completed') {
        expect(harness.store.audits[0]?.audit.reasonCode).toBe(
          'participant_creator_correction_window',
        );
      }
    },
  );

  it('queues a safe parent approval when Participant deletes a record she did not create', async () => {
    const harness = setup(target());
    const participant = brainReadPrincipal('family_participant');

    await expect(
      harness.service.deleteRecord(
        participant,
        context(participant),
        deleteRequest(participant),
        signal(),
      ),
    ).resolves.toEqual({
      operationId: operationId('op_participant_delete'),
      state: 'approval_required',
    });
    const [approval] = await harness.store.listPendingApprovals();
    expect(approval).toMatchObject({
      operationId: operationId('op_participant_delete'),
      summary: { action: 'Move one Family Shared record to trash' },
    });
    expect(harness.calls.trash).toBe(0);
    expect(await harness.present()).toBe(true);
  });

  it('never lets Participant delete a parent-scope record', async () => {
    const harness = setup(
      target('notion', {
        canonicalLocation: {
          provider: 'notion',
          containerRef: 'notion.parent_and_stewardship',
        },
        policy: {
          scope: 'parent_and_stewardship',
          sensitivity: 'parent_and_stewardship',
          protectedClass: 'none',
        },
      }),
    );
    const participant = brainReadPrincipal('family_participant');

    await expect(
      harness.service.deleteRecord(
        participant,
        context(participant),
        deleteRequest(participant),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(harness.calls.trash).toBe(0);
    expect(await harness.store.listPendingApprovals()).toHaveLength(0);
  });

  it('requires one-time parent elevation before trashing a protected record', async () => {
    const harness = setup(
      target('drive', {
        policy: {
          scope: 'family_shared',
          sensitivity: 'protected',
          protectedClass: 'protected',
        },
      }),
    );
    const operator = brainReadPrincipal();
    const challenged = await harness.service.deleteRecord(
      operator,
      context(),
      deleteRequest(),
      signal(),
    );
    expect(challenged).toMatchObject({ state: 'elevation_required' });
    expect(harness.calls.trash).toBe(0);

    await expect(
      harness.service.deleteRecord(
        operator,
        context(),
        deleteRequest(operator, { elevation: grantOf(challenged) }),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls.trash).toBe(1);
    expect(harness.store.audits.map(({ audit }) => audit.reasonCode)).toContain(
      'elevated_action_confirmed',
    );
  });

  it.each(['owner_operator', 'parent_steward', 'family_participant'] as const)(
    'never lets %s trash legal-hold evidence, even through approval or elevation',
    async (role) => {
      const harness = setup(
        target('notion', {
          policy: {
            scope: 'family_shared',
            sensitivity: 'protected',
            protectedClass: 'legal_hold',
          },
        }),
      );
      const principal = brainReadPrincipal(role);

      await expect(
        harness.service.deleteRecord(
          principal,
          context(principal),
          deleteRequest(principal),
          signal(),
        ),
      ).resolves.toMatchObject({ state: 'failed' });
      expect(harness.store.audits.at(-1)?.audit.reasonCode).toBe(
        'legal_hold_evidence_immutable',
      );
      expect(harness.calls.trash).toBe(0);
      expect(harness.store.elevationChallenges()).toHaveLength(0);
      expect(await harness.store.listPendingApprovals()).toHaveLength(0);
      expect(await harness.present()).toBe(true);
    },
  );

  it('reconciles an uncertain trash on replay although the record is no longer fetchable', async () => {
    const harness = setup(target(), {
      unknownOperationIds: [operationId('op_operator_delete')],
    });
    const operator = brainReadPrincipal();

    await expect(
      harness.service.deleteRecord(
        operator,
        context(),
        deleteRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    expect(await harness.present()).toBe(false);

    await expect(
      harness.service.deleteRecord(
        operator,
        context(),
        deleteRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls).toMatchObject({ trash: 1, reconcile: 1 });
  });

  it('never re-trashes when reconciliation finds no trash marker', async () => {
    const harness = setup(target(), {
      trashOverride: () => Promise.reject(new Error('synthetic timeout')),
    });
    const operator = brainReadPrincipal();
    await harness.service.deleteRecord(
      operator,
      context(),
      deleteRequest(),
      signal(),
    );

    await expect(
      harness.service.deleteRecord(
        operator,
        context(),
        deleteRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    expect(harness.calls.trash).toBe(1);
    expect(await harness.present()).toBe(true);
  });

  it('refuses to reconcile an uncertain trash after access is revoked', async () => {
    const harness = setup(target(), {
      unknownOperationIds: [operationId('op_operator_delete')],
    });
    const operator = brainReadPrincipal();
    await harness.service.deleteRecord(
      operator,
      context(),
      deleteRequest(),
      signal(),
    );

    await expect(
      harness
        .makeService(
          familySurfaces.filter(
            ({ containerKey }) => containerKey !== 'notion.family_shared',
          ),
        )
        .deleteRecord(operator, context(), deleteRequest(), signal()),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    expect(harness.calls.reconcile).toBe(0);
  });

  it('fails closed when the target exposes no provider version', async () => {
    const original = target();
    const { providerVersion: _discarded, ...provenance } = original.provenance;
    const harness = setup({ ...original, provenance });

    await expect(
      harness.service.deleteRecord(
        brainReadPrincipal(),
        context(),
        deleteRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(
      await harness.store.getOperation(operationId('op_operator_delete')),
    ).toMatchObject({
      state: 'FAILED',
      errorCode: 'provider_capability_unsupported',
    });
    expect(harness.calls.trash).toBe(0);
  });

  it('dispatches trash with the version observed during fresh authorization', async () => {
    let expected: string | undefined;
    const harness = setup(target(), {
      trashOverride: (base, request, abort) => {
        expected = request.expectedProviderVersion;
        return base.trash(request, abort);
      },
    });

    await harness.service.deleteRecord(
      brainReadPrincipal(),
      context(),
      deleteRequest(),
      signal(),
    );
    expect(expected).toBe('notion-version-delete');
  });

  it('records a known provider rejection as failed', async () => {
    const harness = setup(target(), {
      trashOverride: () =>
        Promise.reject(
          new DomainError('idempotency_conflict', false, {
            reason: 'provider_version_conflict',
          }),
        ),
    });

    await expect(
      harness.service.deleteRecord(
        brainReadPrincipal(),
        context(),
        deleteRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(await harness.present()).toBe(true);
  });

  it('fails closed before provider access for a GitHub alias', async () => {
    const harness = setup(target(), { aliasProvider: 'github' });

    await expect(
      harness.service.deleteRecord(
        brainReadPrincipal(),
        context(),
        deleteRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(harness.calls.trash).toBe(0);
  });

  it('reconciles an uncertain approved trash without trashing twice', async () => {
    const harness = setup(target(), {
      unknownOperationIds: [operationId('op_participant_delete')],
    });
    const participant = brainReadPrincipal('family_participant');
    await harness.service.deleteRecord(
      participant,
      context(participant),
      deleteRequest(participant),
      signal(),
    );
    const pending = await harness.store.getOperation(
      operationId('op_participant_delete'),
    );
    if (pending === null) throw new Error('missing synthetic pending delete');
    await expect(
      harness.service.resumeApprovedUpdate(
        pending,
        participant.principal,
        async (validated) => ({
          disposition: 'resolved',
          operation: await harness.store.transitionOperationWithAudit(
            {
              operationId: validated.operationId,
              expectedStates: ['APPROVAL_PENDING'],
              nextState: 'EXECUTING',
              transitionedAt: now,
            },
            { eventType: 'synthetic', reasonCode: 'synthetic_approved' },
          ),
        }),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    const unknown = await harness.store.getOperation(
      operationId('op_participant_delete'),
    );
    if (unknown === null) throw new Error('missing synthetic unknown delete');

    await expect(
      harness.service.reconcileApprovedUpdate(
        unknown,
        participant.principal,
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls.trash).toBe(1);
  });

  async function claimedApprovedDelete(harness: ReturnType<typeof setup>) {
    const participant = brainReadPrincipal('family_participant');
    await harness.service.deleteRecord(
      participant,
      context(participant),
      deleteRequest(participant),
      signal(),
    );
    const executing = await harness.store.transitionOperationWithAudit(
      {
        operationId: operationId('op_participant_delete'),
        expectedStates: ['APPROVAL_PENDING'],
        nextState: 'EXECUTING',
        transitionedAt: now,
      },
      { eventType: 'synthetic', reasonCode: 'synthetic_approved' },
    );
    return { participant, executing };
  }

  it('recovers an approved trash that completed before a crash', async () => {
    const harness = setup(target());
    const { participant, executing } = await claimedApprovedDelete(harness);
    await harness.providerFor().trash(
      {
        operationId: executing.operationId,
        access: {
          brainScopes: ['family_shared'],
          rootRefs: ['notion.family_shared'],
        },
        providerRecordId: target().provenance.providerRecordId,
        expectedProviderVersion: 'notion-version-delete',
      },
      signal(),
    );

    await expect(
      harness.service.recoverApprovedUpdate(
        executing,
        participant.principal,
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls.trash).toBe(1);
  });

  it('never trashes during approved recovery when no marker exists', async () => {
    const harness = setup(target());
    const { participant, executing } = await claimedApprovedDelete(harness);

    await expect(
      harness.service.recoverApprovedUpdate(
        executing,
        participant.principal,
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    expect(harness.calls.trash).toBe(0);
    expect(
      await harness.store.getOperation(executing.operationId),
    ).toMatchObject({
      state: 'OUTCOME_UNKNOWN',
      resultMetadata: { recoveryReason: 'recovery_provider_marker_not_found' },
    });
  });

  it('never re-trashes during recovery when someone else already trashed the target', async () => {
    const harness = setup(target());
    const { participant, executing } = await claimedApprovedDelete(harness);
    await harness.providerFor().trash(
      {
        operationId: operationId('op_someone_else'),
        access: {
          brainScopes: ['family_shared'],
          rootRefs: ['notion.family_shared'],
        },
        providerRecordId: target().provenance.providerRecordId,
      },
      signal(),
    );

    await expect(
      harness.service.recoverApprovedUpdate(
        executing,
        participant.principal,
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    expect(harness.calls.trash).toBe(1);
  });

  it.each([
    ['parent_steward', 'governance', 'failed'],
    ['owner_operator', 'governance', 'elevation_required'],
    ['owner_operator', 'security', 'elevation_required'],
  ] as const)(
    'applies control-plane delete policy for %s on a %s record',
    async (role, protectedClass, state) => {
      const harness = setup(
        target('notion', {
          policy: {
            scope: 'family_shared',
            sensitivity: 'protected',
            protectedClass,
          },
        }),
      );
      const principal = brainReadPrincipal(role);

      await expect(
        harness.service.deleteRecord(
          principal,
          context(principal),
          deleteRequest(principal),
          signal(),
        ),
      ).resolves.toMatchObject({ state });
      expect(harness.calls.trash).toBe(0);
      expect(harness.store.elevationChallenges()).toHaveLength(
        state === 'elevation_required' ? 1 : 0,
      );
    },
  );

  it('denies the correction shortcut when gateway and provider creators disagree', async () => {
    const recent = addisonRecent(60_000);
    const harness = setup(
      {
        ...recent,
        provenance: {
          ...recent.provenance,
          creatorPrincipalId: principalId('prn_operator'),
        },
      },
      { aliasCreator: principalId('prn_participant') },
    );
    const participant = brainReadPrincipal('family_participant');

    await expect(
      harness.service.deleteRecord(
        participant,
        context(participant),
        deleteRequest(participant),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'approval_required' });
    expect(harness.calls.trash).toBe(0);
  });

  it('applies the correction window to a gateway-recorded creator', async () => {
    const recent = addisonRecent(60_000);
    const { creatorPrincipalId: _discarded, ...provenance } = recent.provenance;
    const harness = setup(
      { ...recent, provenance },
      { aliasCreator: principalId('prn_participant') },
    );
    const participant = brainReadPrincipal('family_participant');

    await expect(
      harness.service.deleteRecord(
        participant,
        context(participant),
        deleteRequest(participant),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
  });
});
