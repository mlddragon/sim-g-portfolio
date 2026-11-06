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
import type { MutationResponse } from '../../../src/domain/operations.js';
import {
  loadExecutablePolicy,
  type ExecutablePolicy,
} from '../../../src/domain/policy/policy-loader.js';
import type { AuthenticatedPrincipal } from '../../../src/domain/principal.js';
import type { BrainRecord } from '../../../src/domain/records.js';
import { CanonicalRouter } from '../../../src/domain/routing/canonical-router.js';
import type { MutableKnowledgeProvider } from '../../../src/ports/knowledge-provider.js';
import { brainReadPrincipal } from '../../support/brain-read-fixtures.js';
import { FakeMutableKnowledgeProvider } from '../../support/fake-knowledge-providers.js';
import { SyntheticApprovalStore } from '../../support/synthetic-approval-store.js';

const issuedAt = new Date('2042-08-09T10:11:12.000Z');
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
const confidentialTitle = 'Synthetic elevated revised title';

const steward: AuthenticatedPrincipal = {
  principal: {
    id: principalId('prn_steward'),
    key: 'steward',
    displayName: 'steward',
    role: 'parent_steward',
    status: 'active',
  },
  identity: {
    issuer: 'https://accounts.google.com',
    externalSubject: 'synthetic-subject-steward',
    email: 'steward@example.invalid',
    authenticatedAt: issuedAt,
    principalId: principalId('prn_steward'),
  },
};

function protectedRecord(
  provider: keyof typeof roots = 'notion',
  overrides: Partial<BrainRecord> = {},
): BrainRecord {
  return {
    brainRecordId: brainRecordId(`brn_provider_${provider}_elevated`),
    title: 'Synthetic protected record',
    excerpt: 'Synthetic protected content',
    content: 'Synthetic protected content',
    contentType: 'text/markdown',
    canonicalLocation: {
      provider,
      containerRef: roots[provider],
      displayPath: 'Synthetic / Protected',
    },
    provenance: {
      provider,
      providerRecordId: providerRecordId(`${provider}-record-elevated`),
      providerVersion: `${provider}-version-elevated`,
      creatorPrincipalId: principalId('prn_operator'),
      createdAt: new Date(issuedAt.getTime() - 60 * 60_000),
      updatedAt: new Date(issuedAt.getTime() - 30 * 60_000),
      integrityHash: 'b'.repeat(64),
    },
    policy: {
      scope: 'family_shared',
      sensitivity: 'protected',
      protectedClass: 'protected',
    },
    ...overrides,
  };
}

function request(
  authenticated: AuthenticatedPrincipal = brainReadPrincipal(),
  suffix = 'elevated',
) {
  return {
    operationId: operationId(`op_${authenticated.principal.key}_${suffix}`),
    requestId: requestId(`req_${authenticated.principal.key}_${suffix}`),
    principalId: authenticated.principal.id,
    clientId: 'synthetic-client',
    brainRecordId: brainRecordId('brn_gateway_elevated_target'),
    mutation: {
      mode: 'patch' as const,
      patch: { title: confidentialTitle },
    },
  };
}

function context(
  authenticated: AuthenticatedPrincipal = brainReadPrincipal(),
  suffix = 'elevated',
) {
  return {
    requestId: requestId(`req_${authenticated.principal.key}_${suffix}`),
    receivedAt: issuedAt,
    clientId: 'synthetic-client',
  };
}

function grantOf(response: MutationResponse) {
  const grant = response.elevation;
  if (grant === undefined) throw new Error('missing synthetic elevation grant');
  return {
    challengeId: grant.challengeId,
    confirmationToken: grant.confirmationToken,
  };
}

interface SetupOptions {
  readonly unknownOperationIds?: readonly ReturnType<typeof operationId>[];
  readonly policy?: ExecutablePolicy;
}

function setup(initial: BrainRecord, options: SetupOptions = {}) {
  let current = issuedAt;
  const clock = { now: () => current };
  const store = new SyntheticApprovalStore();
  store.seedAlias({
    brainRecordId: brainRecordId('brn_gateway_elevated_target'),
    provider: initial.provenance.provider,
    providerRecordId: initial.provenance.providerRecordId,
    canonicalLocation: initial.canonicalLocation,
    createdAt: issuedAt,
    updatedAt: issuedAt,
  });
  const calls = { update: 0, reconcile: 0 };
  const control: {
    fetchOverride?: (record: BrainRecord) => BrainRecord;
    fetchFailure?: DomainError;
  } = {};
  const providers: MutableKnowledgeProvider[] = (
    ['notion', 'drive'] as const
  ).map((provider) => {
    const base = new FakeMutableKnowledgeProvider(
      provider,
      provider === initial.provenance.provider ? [initial] : [],
      {
        configuredAccess: {
          brainScopes: ['family_shared'],
          rootRefs: [roots[provider]],
        },
        now: () => current,
        ...(options.unknownOperationIds === undefined
          ? {}
          : { unknownOperationIds: options.unknownOperationIds }),
      },
    );
    if (provider !== initial.provenance.provider) return base;
    return {
      provider: base.provider,
      search: base.search.bind(base),
      fetch: async (fetchRequest, signal) => {
        if (control.fetchFailure !== undefined) throw control.fetchFailure;
        const fetched = await base.fetch(fetchRequest, signal);
        return control.fetchOverride?.(fetched) ?? fetched;
      },
      create: base.create.bind(base),
      update: (updateRequest, signal) => {
        calls.update += 1;
        return base.update(updateRequest, signal);
      },
      append: base.append.bind(base),
      trash: base.trash.bind(base),
      reconcile: (reconcileRequest, signal) => {
        calls.reconcile += 1;
        return base.reconcile(reconcileRequest, signal);
      },
    };
  });
  let generated = 0;
  const elevations = new ElevationService(store, clock, {
    challengeId: () =>
      elevationChallengeId(`elv_synthetic_${String(++generated)}`),
    confirmationToken: () =>
      `synthetic-confirmation-token-${String(generated)}-${'k'.repeat(32)}`,
  });
  const makeService = (selectedPolicy: ExecutablePolicy = policy) =>
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
                '40000000-0000-4000-8000-000000000011',
              ),
            }),
          update: () => Promise.resolve(),
        },
        clock,
      ),
      elevations,
    );
  const fetchCurrent = () => {
    const selected = providers.find(
      (candidate) => candidate.provider === initial.provenance.provider,
    );
    if (selected === undefined) throw new Error('missing synthetic provider');
    return selected.fetch(
      {
        providerRecordId: initial.provenance.providerRecordId,
        access: {
          brainScopes: ['family_shared'],
          rootRefs: [roots[initial.provenance.provider as keyof typeof roots]],
        },
      },
      new AbortController().signal,
    );
  };
  return {
    store,
    calls,
    control,
    service: makeService(options.policy),
    makeService,
    fetchCurrent,
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

const signal = () => new AbortController().signal;

describe('MutationService elevated update_record confirmation', () => {
  it.each(['notion', 'drive'] as const)(
    'issues a hashed five-minute challenge, then executes one confirmed %s update',
    async (provider) => {
      const harness = setup(protectedRecord(provider));
      const operator = brainReadPrincipal();

      const first = await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      );

      expect(first).toMatchObject({
        operationId: operationId('op_operator_elevated'),
        state: 'elevation_required',
        elevation: {
          challengeId: elevationChallengeId('elv_synthetic_1'),
          expiresAt: new Date(issuedAt.getTime() + 5 * 60_000),
        },
      });
      expect(harness.calls.update).toBe(0);
      const grant = grantOf(first);
      const [stored] = harness.store.elevationChallenges();
      expect(stored?.confirmationTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(harness.store.elevationChallenges())).not.toContain(
        grant.confirmationToken,
      );

      const confirmed = await harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: grant },
        signal(),
      );

      expect(confirmed).toMatchObject({
        operationId: operationId('op_operator_elevated'),
        state: 'completed',
        record: { provider },
      });
      expect(confirmed.elevation).toBeUndefined();
      expect(harness.calls.update).toBe(1);
      await expect(harness.fetchCurrent()).resolves.toMatchObject({
        title: confidentialTitle,
      });
      expect(
        harness.store.audits.map(({ operation, audit }) => [
          operation.state,
          audit.reasonCode,
        ]),
      ).toEqual([
        ['ELEVATION_PENDING', 'explicit_elevation_required'],
        ['EXECUTING', 'elevated_action_confirmed'],
        ['COMPLETED', 'provider_mutation_completed'],
      ]);
      const serializedAudit = JSON.stringify([
        harness.store.audits.map(({ audit }) => audit),
        harness.store.auditEvents,
      ]);
      expect(serializedAudit).not.toContain(grant.confirmationToken);
      expect(serializedAudit).not.toContain(confidentialTitle);
      expect(harness.store.elevationChallenges()[0]?.consumedAt).toEqual(
        issuedAt,
      );
    },
  );

  it('replays a confirmed result without consuming again or dispatching twice', async () => {
    const harness = setup(protectedRecord());
    const operator = brainReadPrincipal();
    const grant = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );
    await harness.service.updateRecord(
      operator,
      context(),
      { ...request(), elevation: grant },
      signal(),
    );

    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: grant },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    await expect(
      harness.service.updateRecord(operator, context(), request(), signal()),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls.update).toBe(1);
    expect(harness.store.elevationChallenges()).toHaveLength(1);
  });

  it('lets exactly one concurrent confirmation dispatch the provider update', async () => {
    const harness = setup(protectedRecord());
    const operator = brainReadPrincipal();
    const grant = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );

    const outcomes = await Promise.allSettled([
      harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: grant },
        signal(),
      ),
      harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: grant },
        signal(),
      ),
    ]);

    expect(harness.calls.update).toBe(1);
    const [winner, loser] = outcomes;
    expect(winner).toMatchObject({
      status: 'fulfilled',
      value: { state: 'completed' },
    });
    // The loser observes the winner's claim, never a second dispatch.
    expect(loser).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'provider_unavailable',
        details: { reason: 'operation_in_progress' },
      },
    });
    expect(
      (await harness.store.getOperation(operationId('op_operator_elevated')))
        ?.state,
    ).toBe('COMPLETED');
  });

  it('accepts a confirmation at exactly five minutes and rejects one millisecond later', async () => {
    const accepted = setup(protectedRecord());
    const operator = brainReadPrincipal();
    const onTime = grantOf(
      await accepted.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );
    accepted.advance(5 * 60_000);
    await expect(
      accepted.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: onTime },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });

    const expired = setup(protectedRecord());
    const late = grantOf(
      await expired.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );
    expired.advance(5 * 60_000 + 1);
    await expect(
      expired.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: late },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'elevation_required' });
    expect(expired.calls.update).toBe(0);
    expect(
      (await expired.store.getOperation(operationId('op_operator_elevated')))
        ?.state,
    ).toBe('ELEVATION_PENDING');
    expect(expired.store.elevationChallenges()[0]?.consumedAt).toBeUndefined();
    expect(
      expired.store.auditEvents.filter(
        ({ eventType }) => eventType === 'brain.elevation.rejected',
      ),
    ).toMatchObject([
      {
        principalId: operator.principal.id,
        operationId: operationId('op_operator_elevated'),
        operation: 'update_record',
        outcome: 'DENIED',
      },
    ]);
  });

  it.each([
    [
      'forged token',
      (grant: ReturnType<typeof grantOf>) => ({
        ...grant,
        confirmationToken: `forged-${'f'.repeat(40)}`,
      }),
    ],
    [
      'unknown challenge',
      (grant: ReturnType<typeof grantOf>) => ({
        ...grant,
        challengeId: elevationChallengeId('elv_synthetic_unknown'),
      }),
    ],
  ])('rejects a %s without consuming the real challenge', async (_, forge) => {
    const harness = setup(protectedRecord());
    const operator = brainReadPrincipal();
    const grant = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );

    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: forge(grant) },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'elevation_required' });
    expect(harness.calls.update).toBe(0);

    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: grant },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
  });

  it('rejects a challenge presented by another parent on their own operation', async () => {
    const harness = setup(protectedRecord());
    const operator = brainReadPrincipal();
    const masonGrant = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );
    await expect(
      harness.service.updateRecord(
        steward,
        context(steward),
        request(steward),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'elevation_required' });

    await expect(
      harness.service.updateRecord(
        steward,
        context(steward),
        { ...request(steward), elevation: masonGrant },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'elevation_required' });
    expect(harness.calls.update).toBe(0);

    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: masonGrant },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
  });

  it('supersedes an earlier challenge when the pending request is replayed', async () => {
    const harness = setup(protectedRecord());
    const operator = brainReadPrincipal();
    const original = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );
    const replayed = await harness.service.updateRecord(
      operator,
      context(),
      request(),
      signal(),
    );
    expect(replayed).toMatchObject({
      state: 'elevation_required',
      elevation: { challengeId: elevationChallengeId('elv_synthetic_2') },
    });

    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: original },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'elevation_required' });
    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: grantOf(replayed) },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls.update).toBe(1);
  });

  it('rejects a confirmation whose mutation payload differs from the challenged request', async () => {
    const harness = setup(protectedRecord());
    const operator = brainReadPrincipal();
    const grant = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );

    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        {
          ...request(),
          mutation: { mode: 'patch', patch: { title: 'Synthetic other' } },
          elevation: grant,
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(harness.store.elevationChallenges()[0]?.consumedAt).toBeUndefined();
    expect(harness.calls.update).toBe(0);
  });

  it.each([
    [
      'provider version',
      (record: BrainRecord): BrainRecord => ({
        ...record,
        provenance: {
          ...record.provenance,
          providerVersion: 'notion-version-concurrently-edited',
        },
      }),
    ],
    [
      'protection removal',
      (record: BrainRecord): BrainRecord => ({
        ...record,
        policy: { ...record.policy, protectedClass: 'none' },
      }),
    ],
  ])(
    'supersedes the operation without dispatch after a %s change',
    async (_, change) => {
      const harness = setup(protectedRecord());
      const operator = brainReadPrincipal();
      const grant = grantOf(
        await harness.service.updateRecord(
          operator,
          context(),
          request(),
          signal(),
        ),
      );
      harness.control.fetchOverride = change;

      await expect(
        harness.service.updateRecord(
          operator,
          context(),
          { ...request(), elevation: grant },
          signal(),
        ),
      ).resolves.toMatchObject({ state: 'failed' });
      expect(harness.calls.update).toBe(0);
      expect(
        (await harness.store.getOperation(operationId('op_operator_elevated')))
          ?.state,
      ).toBe('SUPERSEDED');
      expect(
        harness.store.elevationChallenges()[0]?.consumedAt,
      ).toBeUndefined();
    },
  );

  it.each([
    ['not_found', 'SUPERSEDED', undefined],
    ['unauthorized', 'FAILED', 'unauthorized'],
  ] as const)(
    'settles a %s target as %s without consuming the challenge',
    async (code, state, errorCode) => {
      const harness = setup(protectedRecord());
      const operator = brainReadPrincipal();
      const grant = grantOf(
        await harness.service.updateRecord(
          operator,
          context(),
          request(),
          signal(),
        ),
      );
      harness.control.fetchFailure = new DomainError(code, false, {
        reason: `synthetic_${code}`,
      });

      await expect(
        harness.service.updateRecord(
          operator,
          context(),
          { ...request(), elevation: grant },
          signal(),
        ),
      ).resolves.toMatchObject({ state: 'failed' });
      const settled = await harness.store.getOperation(
        operationId('op_operator_elevated'),
      );
      expect(settled?.state).toBe(state);
      expect(settled?.errorCode).toBe(errorCode);
      expect(harness.calls.update).toBe(0);

      delete harness.control.fetchFailure;
      await expect(
        harness.service.updateRecord(
          operator,
          context(),
          { ...request(), elevation: grant },
          signal(),
        ),
      ).resolves.toMatchObject({ state: 'failed' });
      expect(harness.calls.update).toBe(0);
      expect(
        harness.store.elevationChallenges()[0]?.consumedAt,
      ).toBeUndefined();
    },
  );

  it('never lets elevation override a target that became forbidden', async () => {
    const harness = setup(protectedRecord());
    const operator = brainReadPrincipal();
    const replace = {
      ...request(),
      mutation: {
        mode: 'replace' as const,
        replacement: { content: 'Synthetic elevated replacement body' },
      },
    };
    const grant = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        replace,
        signal(),
      ),
    );
    harness.control.fetchOverride = (record) => ({
      ...record,
      policy: { ...record.policy, protectedClass: 'legal_hold' },
    });

    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        { ...replace, elevation: grant },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    const failed = await harness.store.getOperation(
      operationId('op_operator_elevated'),
    );
    expect(failed).toMatchObject({
      state: 'FAILED',
      errorCode: 'unauthorized',
    });
    expect(harness.calls.update).toBe(0);
    expect(harness.store.elevationChallenges()[0]?.consumedAt).toBeUndefined();
  });

  it('fails an elevated title patch whose target became legal-hold evidence', async () => {
    const harness = setup(protectedRecord());
    const operator = brainReadPrincipal();
    const grant = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );
    harness.control.fetchOverride = (record) => ({
      ...record,
      policy: { ...record.policy, protectedClass: 'legal_hold' },
    });

    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: grant },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(harness.store.audits.at(-1)?.audit.reasonCode).toBe(
      'legal_hold_evidence_immutable',
    );
    expect(harness.calls.update).toBe(0);
    expect(harness.store.elevationChallenges()[0]?.consumedAt).toBeUndefined();
  });

  it('supersedes a pending elevation after an executable policy version change', async () => {
    const harness = setup(protectedRecord());
    const operator = brainReadPrincipal();
    const grant = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );
    const changed = harness.makeService({
      ...policy,
      version: 'family-brain-v1.0.1-synthetic',
    });

    await expect(
      changed.updateRecord(
        operator,
        context(),
        { ...request(), elevation: grant },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(harness.calls.update).toBe(0);
    expect(
      (await harness.store.getOperation(operationId('op_operator_elevated')))
        ?.state,
    ).toBe('SUPERSEDED');
  });

  it('keeps the challenge reusable after a transient target fetch failure', async () => {
    const harness = setup(protectedRecord());
    const operator = brainReadPrincipal();
    const grant = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );
    harness.control.fetchFailure = new DomainError(
      'provider_unavailable',
      true,
      { reason: 'synthetic_provider_timeout' },
    );

    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: grant },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(
      (await harness.store.getOperation(operationId('op_operator_elevated')))
        ?.state,
    ).toBe('ELEVATION_PENDING');

    delete harness.control.fetchFailure;
    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: grant },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
  });

  it('never dispatches after the confirmation commit acknowledgement is lost', async () => {
    const harness = setup(protectedRecord());
    const operator = brainReadPrincipal();
    const grant = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );
    harness.store.failAfterCommitStates.add('EXECUTING');

    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: grant },
        signal(),
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      details: { reason: 'operation_in_progress' },
    });
    expect(harness.calls.update).toBe(0);
    expect(
      (await harness.store.getOperation(operationId('op_operator_elevated')))
        ?.state,
    ).toBe('EXECUTING');
  });

  it('reconciles an uncertain elevated outcome on replay without repeating the update', async () => {
    const operator = brainReadPrincipal();
    const harness = setup(protectedRecord(), {
      unknownOperationIds: [operationId('op_operator_elevated')],
    });
    const grant = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );
    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        { ...request(), elevation: grant },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });

    await expect(
      harness.service.updateRecord(operator, context(), request(), signal()),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls.update).toBe(1);
    expect(harness.calls.reconcile).toBe(1);
  });

  it('refuses to reconcile an uncertain elevated outcome after a policy change', async () => {
    const operator = brainReadPrincipal();
    const harness = setup(protectedRecord(), {
      unknownOperationIds: [operationId('op_operator_elevated')],
    });
    const grant = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );
    await harness.service.updateRecord(
      operator,
      context(),
      { ...request(), elevation: grant },
      signal(),
    );
    const changed = harness.makeService({
      ...policy,
      version: 'family-brain-v1.0.1-synthetic',
    });

    await expect(
      changed.updateRecord(operator, context(), request(), signal()),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    expect(harness.calls.reconcile).toBe(0);
    expect(harness.calls.update).toBe(1);
  });

  it('never issues an elevation challenge to Participant', async () => {
    const harness = setup(
      protectedRecord('notion', {
        policy: {
          scope: 'family_shared',
          sensitivity: 'family_shared',
          protectedClass: 'none',
        },
      }),
      {
        // Synthetic policy the loader would reject; it exercises the fail-closed guard.
        policy: {
          ...policy,
          protectedMutationScopes: [
            'legal',
            'family_shared',
          ] as unknown as ExecutablePolicy['protectedMutationScopes'],
        },
      },
    );
    const participant = brainReadPrincipal('family_participant');

    await expect(
      harness.service.updateRecord(
        participant,
        context(participant),
        request(participant),
        signal(),
      ),
    ).resolves.toEqual({
      operationId: operationId('op_participant_elevated'),
      state: 'failed',
    });
    expect(harness.store.elevationChallenges()).toHaveLength(0);
    expect(
      await harness.store.getOperation(operationId('op_participant_elevated')),
    ).toMatchObject({ state: 'FAILED', errorCode: 'unauthorized' });
    expect(harness.calls.update).toBe(0);
  });

  it('ignores a parent challenge presented on an Participant approval request', async () => {
    const harness = setup(protectedRecord());
    const operator = brainReadPrincipal();
    const masonGrant = grantOf(
      await harness.service.updateRecord(
        operator,
        context(),
        request(),
        signal(),
      ),
    );
    const participant = brainReadPrincipal('family_participant');

    await expect(
      harness.service.updateRecord(
        participant,
        context(participant),
        { ...request(participant), elevation: masonGrant },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'approval_required' });
    await expect(
      harness.service.updateRecord(
        participant,
        context(participant),
        { ...request(participant), elevation: masonGrant },
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'approval_required' });
    expect(harness.store.elevationChallenges()[0]?.consumedAt).toBeUndefined();
    expect(harness.calls.update).toBe(0);
  });

  it('rejects a malformed elevation confirmation before opening state', async () => {
    const harness = setup(protectedRecord());
    const operator = brainReadPrincipal();

    await expect(
      harness.service.updateRecord(
        operator,
        context(),
        {
          ...request(),
          elevation: {
            challengeId: elevationChallengeId('elv_synthetic_1'),
            confirmationToken: '',
          },
        },
        signal(),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'invalid_elevation_confirmation' },
    });
    expect(
      await harness.store.getOperation(operationId('op_operator_elevated')),
    ).toBeNull();
  });
});
