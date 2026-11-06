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
  AppendRecordRequest,
  MutationResponse,
} from '../../../src/domain/operations.js';
import { loadExecutablePolicy } from '../../../src/domain/policy/policy-loader.js';
import type { AuthenticatedPrincipal } from '../../../src/domain/principal.js';
import type { BrainRecord } from '../../../src/domain/records.js';
import { CanonicalRouter } from '../../../src/domain/routing/canonical-router.js';
import type {
  MutableKnowledgeProvider,
  ProviderMutationResult,
  RoutedAppend,
} from '../../../src/ports/knowledge-provider.js';
import { brainReadPrincipal } from '../../support/brain-read-fixtures.js';
import { FakeMutableKnowledgeProvider } from '../../support/fake-knowledge-providers.js';
import { SyntheticApprovalStore } from '../../support/synthetic-approval-store.js';

const now = new Date('2042-10-11T12:13:14.000Z');
const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);
const surfaces = [
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
const originalBody = 'Synthetic original packing list.';
const appendedBody = '\n- Synthetic appended flashlight';

function target(
  provider: 'notion' | 'drive' = 'notion',
  overrides: Partial<BrainRecord> = {},
): BrainRecord {
  return {
    brainRecordId: brainRecordId(`brn_provider_${provider}_append`),
    title: 'Synthetic packing list',
    excerpt: originalBody,
    content: originalBody,
    contentType: 'text/markdown',
    canonicalLocation: {
      provider,
      containerRef: `${provider}.family_shared`,
      displayPath: 'Synthetic / Packing',
    },
    provenance: {
      provider,
      providerRecordId: providerRecordId(`${provider}-record-append`),
      providerVersion: `${provider}-version-append`,
      creatorPrincipalId: principalId('prn_operator'),
      createdAt: new Date(now.getTime() - 60 * 60_000),
      updatedAt: new Date(now.getTime() - 30 * 60_000),
      integrityHash: 'c'.repeat(64),
    },
    policy: {
      scope: 'family_shared',
      sensitivity: 'family_shared',
      protectedClass: 'none',
    },
    ...overrides,
  };
}

function appendRequest(
  authenticated: AuthenticatedPrincipal = brainReadPrincipal(),
  overrides: Partial<AppendRecordRequest> = {},
): AppendRecordRequest {
  return {
    operationId: operationId(`op_${authenticated.principal.key}_append`),
    requestId: requestId(`req_${authenticated.principal.key}_append`),
    principalId: authenticated.principal.id,
    clientId: 'synthetic-client',
    brainRecordId: brainRecordId('brn_gateway_append_target'),
    content: appendedBody,
    ...overrides,
  };
}

function context(authenticated: AuthenticatedPrincipal = brainReadPrincipal()) {
  return {
    requestId: requestId(`req_${authenticated.principal.key}_append`),
    receivedAt: now,
    clientId: 'synthetic-client',
  };
}

function setup(
  record: BrainRecord,
  options: {
    readonly unknownOperationIds?: readonly ReturnType<typeof operationId>[];
    readonly appendOverride?: (
      base: MutableKnowledgeProvider,
      request: RoutedAppend,
      signal: AbortSignal,
    ) => Promise<ProviderMutationResult>;
    readonly aliasProvider?: 'github';
  } = {},
) {
  const store = new SyntheticApprovalStore();
  store.seedAlias({
    brainRecordId: brainRecordId('brn_gateway_append_target'),
    provider: options.aliasProvider ?? record.provenance.provider,
    providerRecordId: record.provenance.providerRecordId,
    canonicalLocation:
      options.aliasProvider === undefined
        ? record.canonicalLocation
        : { provider: 'github', containerRef: 'github.synthetic' },
    createdAt: now,
    updatedAt: now,
  });
  const calls = { append: 0, update: 0, reconcile: 0 };
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
        return (
          options.appendOverride?.(base, request, signal) ??
          base.append(request, signal)
        );
      },
      trash: base.trash.bind(base),
      reconcile: (request, signal) => {
        calls.reconcile += 1;
        return base.reconcile(request, signal);
      },
    };
  });
  const clock = { now: () => now };
  let generated = 0;
  const service = new MutationService(
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
              '40000000-0000-4000-8000-000000000051',
            ),
          }),
        update: () => Promise.resolve(),
      },
      clock,
    ),
    new ElevationService(store, clock, {
      challengeId: () => {
        generated += 1;
        return elevationChallengeId(`elv_append_${String(generated)}`);
      },
      confirmationToken: () =>
        `synthetic-append-token-${String(generated)}-${'a'.repeat(32)}`,
    }),
  );
  const current = () => {
    if (selected === undefined) throw new Error('missing synthetic provider');
    return selected.fetch(
      {
        providerRecordId: record.provenance.providerRecordId,
        access: {
          brainScopes: [record.policy.scope],
          rootRefs: [record.canonicalLocation.containerRef],
        },
      },
      new AbortController().signal,
    );
  };
  return { store, calls, service, current };
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

describe('MutationService append_to_record', () => {
  it.each(['notion', 'drive'] as const)(
    'freshly authorizes one version-guarded %s append that never replaces the body',
    async (provider) => {
      const harness = setup(target(provider));
      const operator = brainReadPrincipal();

      await expect(
        harness.service.appendToRecord(
          operator,
          context(),
          appendRequest(),
          signal(),
        ),
      ).resolves.toMatchObject({
        operationId: operationId('op_operator_append'),
        state: 'completed',
        record: { provider },
      });
      expect(harness.calls).toMatchObject({ append: 1, update: 0 });
      await expect(harness.current()).resolves.toMatchObject({
        content: `${originalBody}${appendedBody}`,
      });
      expect(
        harness.store.audits.map(({ operation, audit }) => [
          operation.state,
          audit.reasonCode,
        ]),
      ).toEqual([
        ['EXECUTING', 'routine_authorized'],
        ['COMPLETED', 'provider_mutation_completed'],
      ]);
      expect(JSON.stringify(harness.store.audits)).not.toContain(
        appendedBody.trim(),
      );
      expect(
        (await harness.store.getOperation(operationId('op_operator_append')))
          ?.mutationPayload,
      ).toBeUndefined();
    },
  );

  it('replays a terminal append without appending twice', async () => {
    const harness = setup(target());
    const operator = brainReadPrincipal();
    const first = await harness.service.appendToRecord(
      operator,
      context(),
      appendRequest(),
      signal(),
    );

    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(operator, { operationId: operationId('op_ignored') }),
        signal(),
      ),
    ).resolves.toEqual(first);
    expect(harness.calls.append).toBe(1);
  });

  it('rejects the same request ID with different content', async () => {
    const harness = setup(target());
    const operator = brainReadPrincipal();
    await harness.service.appendToRecord(
      operator,
      context(),
      appendRequest(),
      signal(),
    );

    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(operator, { content: '\n- Synthetic other item' }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(harness.calls.append).toBe(1);
  });

  it.each([
    ['empty content', ''],
    ['oversized content', 'x'.repeat(1_048_577)],
    ['non-string content', 42 as unknown as string],
    ['content with a NUL', 'Synthetic\u0000body'],
    ['content with a lone surrogate', 'Synthetic\ud800body'],
  ])('rejects %s before opening state', async (_, content) => {
    const harness = setup(target());
    const operator = brainReadPrincipal();

    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(operator, { content }),
        signal(),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'invalid_append_request' },
    });
    expect(
      await harness.store.getOperation(operationId('op_operator_append')),
    ).toBeNull();
  });

  it('rejects forged operation identity before opening state', async () => {
    const harness = setup(target());
    const operator = brainReadPrincipal();

    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(operator, { principalId: principalId('prn_steward') }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(harness.calls.append).toBe(0);
  });

  it('lets Participant append to an ordinary Family Shared record she did not create', async () => {
    const harness = setup(target());
    const participant = brainReadPrincipal('family_participant');

    await expect(
      harness.service.appendToRecord(
        participant,
        context(participant),
        appendRequest(participant),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
  });

  it('never lets Participant append to a parent-scope record', async () => {
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
      harness.service.appendToRecord(
        participant,
        context(participant),
        appendRequest(participant),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(
      await harness.store.getOperation(operationId('op_participant_append')),
    ).toMatchObject({ state: 'FAILED', errorCode: 'unauthorized' });
    expect(harness.calls.append).toBe(0);
  });

  it('queues a safe parent approval for an Participant append to a protected record', async () => {
    const harness = setup(
      target('notion', {
        policy: {
          scope: 'family_shared',
          sensitivity: 'protected',
          protectedClass: 'protected',
        },
      }),
    );
    const participant = brainReadPrincipal('family_participant');

    await expect(
      harness.service.appendToRecord(
        participant,
        context(participant),
        appendRequest(participant),
        signal(),
      ),
    ).resolves.toEqual({
      operationId: operationId('op_participant_append'),
      state: 'approval_required',
    });
    expect(harness.calls.append).toBe(0);
    const [approval] = await harness.store.listPendingApprovals();
    expect(approval).toMatchObject({
      operationId: operationId('op_participant_append'),
      summary: { action: 'Append to one Family Shared record' },
    });
    expect(JSON.stringify(approval)).not.toContain(appendedBody.trim());
    // Only an approval-pending append retains its body, as the pending payload.
    expect(
      (await harness.store.getOperation(operationId('op_participant_append')))
        ?.mutationPayload,
    ).toEqual({ content: appendedBody });
    await expect(
      harness.service.appendToRecord(
        participant,
        context(participant),
        appendRequest(participant),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'approval_required' });
    expect(await harness.store.listPendingApprovals()).toHaveLength(1);
  });

  it('executes an approved append once after fresh revalidation', async () => {
    const harness = setup(
      target('notion', {
        policy: {
          scope: 'family_shared',
          sensitivity: 'protected',
          protectedClass: 'protected',
        },
      }),
    );
    const participant = brainReadPrincipal('family_participant');
    await harness.service.appendToRecord(
      participant,
      context(participant),
      appendRequest(participant),
      signal(),
    );
    const pending = await harness.store.getOperation(
      operationId('op_participant_append'),
    );
    if (pending === null) throw new Error('missing synthetic pending append');

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
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls.append).toBe(1);
    await expect(harness.current()).resolves.toMatchObject({
      content: `${originalBody}${appendedBody}`,
    });
  });

  it('never re-appends an approved append stranded after its claim', async () => {
    const harness = setup(
      target('notion', {
        policy: {
          scope: 'family_shared',
          sensitivity: 'protected',
          protectedClass: 'protected',
        },
      }),
    );
    const participant = brainReadPrincipal('family_participant');
    await harness.service.appendToRecord(
      participant,
      context(participant),
      appendRequest(participant),
      signal(),
    );
    const executing = await harness.store.transitionOperationWithAudit(
      {
        operationId: operationId('op_participant_append'),
        expectedStates: ['APPROVAL_PENDING'],
        nextState: 'EXECUTING',
        transitionedAt: now,
      },
      { eventType: 'synthetic', reasonCode: 'synthetic_approved' },
    );

    await expect(
      harness.service.recoverApprovedUpdate(
        executing,
        participant.principal,
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    expect(harness.calls.append).toBe(0);
    await expect(harness.current()).resolves.toMatchObject({
      content: originalBody,
    });
    // The stored body stays available for operator reconciliation.
    expect(
      await harness.store.getOperation(operationId('op_participant_append')),
    ).toMatchObject({
      state: 'OUTCOME_UNKNOWN',
      mutationPayload: { content: appendedBody },
      resultMetadata: { recoveryReason: 'recovery_provider_marker_not_found' },
    });
  });

  it('requires one-time parent elevation before appending to a protected record', async () => {
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
    const challenged = await harness.service.appendToRecord(
      operator,
      context(),
      appendRequest(),
      signal(),
    );
    expect(challenged).toMatchObject({ state: 'elevation_required' });
    expect(harness.calls.append).toBe(0);
    const grant = grantOf(challenged);

    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(operator, { elevation: grant }),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(operator, { elevation: grant }),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls.append).toBe(1);
    expect(harness.store.audits.map(({ audit }) => audit.reasonCode)).toContain(
      'elevated_action_confirmed',
    );
    expect(
      (await harness.store.getOperation(operationId('op_operator_append')))
        ?.mutationPayload,
    ).toBeUndefined();
  });

  it('reconciles an uncertain append before replay and never appends twice', async () => {
    const harness = setup(target(), {
      unknownOperationIds: [operationId('op_operator_append')],
    });
    const operator = brainReadPrincipal();

    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls).toMatchObject({ append: 1, reconcile: 1 });
    await expect(harness.current()).resolves.toMatchObject({
      content: `${originalBody}${appendedBody}`,
    });
  });

  it('reconciles an uncertain elevated append under its consumed challenge', async () => {
    const harness = setup(
      target('notion', {
        policy: {
          scope: 'family_shared',
          sensitivity: 'protected',
          protectedClass: 'protected',
        },
      }),
      { unknownOperationIds: [operationId('op_operator_append')] },
    );
    const operator = brainReadPrincipal();
    const grant = grantOf(
      await harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(),
        signal(),
      ),
    );
    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(operator, { elevation: grant }),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });

    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls.append).toBe(1);
  });

  it('records a known provider rejection as failed', async () => {
    const harness = setup(target(), {
      appendOverride: () =>
        Promise.reject(
          new DomainError('idempotency_conflict', false, {
            reason: 'provider_version_conflict',
          }),
        ),
    });
    const operator = brainReadPrincipal();

    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(
      await harness.store.getOperation(operationId('op_operator_append')),
    ).toMatchObject({ state: 'FAILED', errorCode: 'idempotency_conflict' });
  });

  it('dispatches the version observed during fresh authorization', async () => {
    let expected: string | undefined;
    const harness = setup(target(), {
      appendOverride: (base, request, abort) => {
        expected = request.expectedProviderVersion;
        return base.append(request, abort);
      },
    });

    await harness.service.appendToRecord(
      brainReadPrincipal(),
      context(),
      appendRequest(),
      signal(),
    );
    expect(expected).toBe('notion-version-append');
  });

  it('fails closed before provider access for a GitHub alias', async () => {
    const harness = setup(target(), { aliasProvider: 'github' });
    const operator = brainReadPrincipal();

    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(harness.calls.append).toBe(0);
  });

  it.each(['owner_operator', 'parent_steward', 'family_participant'] as const)(
    'never lets %s append to legal-hold evidence',
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

      const response = await harness.service.appendToRecord(
        principal,
        context(principal),
        appendRequest(principal),
        signal(),
      );

      expect(response).toEqual({
        operationId: operationId(`op_${principal.principal.key}_append`),
        state: 'failed',
      });
      expect(harness.store.audits.at(-1)?.audit.reasonCode).toBe(
        'legal_hold_evidence_immutable',
      );
      expect(harness.calls.append).toBe(0);
      expect(harness.store.elevationChallenges()).toHaveLength(0);
      await expect(harness.current()).resolves.toMatchObject({
        content: originalBody,
      });
    },
  );

  it('rejects whitespace-only content before opening state', async () => {
    const harness = setup(target());
    const operator = brainReadPrincipal();
    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(operator, { content: ' \n\t ' }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(harness.calls.append).toBe(0);
  });

  it('fails closed when the target exposes no provider version', async () => {
    const original = target();
    const { providerVersion: _discarded, ...provenance } = original.provenance;
    const harness = setup({ ...original, provenance });
    await expect(
      harness.service.appendToRecord(
        brainReadPrincipal(),
        context(),
        appendRequest(),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(
      await harness.store.getOperation(operationId('op_operator_append')),
    ).toMatchObject({
      state: 'FAILED',
      errorCode: 'provider_capability_unsupported',
    });
    expect(harness.calls.append).toBe(0);
  });

  it.each([
    ['parent on a governance record', 'parent_steward', 'governance', 'failed'],
    [
      'owner on a security record',
      'owner_operator',
      'security',
      'elevation_required',
    ],
  ] as const)(
    'applies control-plane policy for %s',
    async (_, role, protectedClass, state) => {
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
        harness.service.appendToRecord(
          principal,
          context(principal),
          appendRequest(principal),
          signal(),
        ),
      ).resolves.toMatchObject({ state });
      expect(harness.calls.append).toBe(0);
    },
  );

  it('rejects an elevated confirmation that resends different content', async () => {
    const harness = setup(
      target('notion', {
        policy: {
          scope: 'family_shared',
          sensitivity: 'protected',
          protectedClass: 'protected',
        },
      }),
    );
    const operator = brainReadPrincipal();
    const grant = grantOf(
      await harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(),
        signal(),
      ),
    );
    await expect(
      harness.service.appendToRecord(
        operator,
        context(),
        appendRequest(operator, {
          content: '\n- Synthetic swapped item',
          elevation: grant,
        }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(harness.calls.append).toBe(0);
    expect(harness.store.elevationChallenges()[0]?.consumedAt).toBeUndefined();
  });

  it('namespaces append idempotency separately from update for the same request ID', async () => {
    const harness = setup(target());
    const operator = brainReadPrincipal();
    await harness.service.appendToRecord(
      operator,
      context(),
      appendRequest(),
      signal(),
    );

    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        {
          operationId: operationId('op_operator_update_same_request'),
          requestId: requestId('req_operator_append'),
          principalId: operator.principal.id,
          clientId: 'synthetic-client',
          brainRecordId: brainRecordId('brn_gateway_append_target'),
          mutation: { mode: 'patch', patch: { title: 'Synthetic retitled' } },
        },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls).toMatchObject({ append: 1, update: 1 });
  });
});
