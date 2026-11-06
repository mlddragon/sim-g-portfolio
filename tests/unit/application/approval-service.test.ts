import { expectTelemetrySurvivesAdapter } from '../../support/telemetry-drift.js';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ApprovalRequestCoordinator,
  ApprovalService,
} from '../../../src/application/approval-service.js';
import { AuthorizationEngine } from '../../../src/domain/authorization/authorization-engine.js';
import { DomainError } from '../../../src/domain/errors.js';
import {
  operationId,
  principalId,
  providerRecordId,
  requestId,
} from '../../../src/domain/identifiers.js';
import { loadExecutablePolicy } from '../../../src/domain/policy/policy-loader.js';
import type { AuthenticatedPrincipal } from '../../../src/domain/principal.js';
import type { ApprovalProjectionPort } from '../../../src/ports/approval-projection.js';
import type { TelemetryObservation } from '../../../src/ports/telemetry-sink.js';
import {
  brainReadContext,
  brainReadPrincipal,
} from '../../support/brain-read-fixtures.js';
import { SyntheticApprovalStore } from '../../support/synthetic-approval-store.js';

const now = new Date('2042-07-08T09:10:11.000Z');
const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);

class ProjectionSpy implements ApprovalProjectionPort {
  readonly creates: Parameters<ApprovalProjectionPort['create']>[0][] = [];
  readonly updates: Parameters<ApprovalProjectionPort['update']>[0][] = [];
  failCreate = false;
  failUpdate = false;
  found: Awaited<
    ReturnType<ApprovalProjectionPort['findByApprovalRequestId']>
  > = null;

  findByApprovalRequestId(): ReturnType<
    ApprovalProjectionPort['findByApprovalRequestId']
  > {
    return Promise.resolve(this.found);
  }

  create(
    request: Parameters<ApprovalProjectionPort['create']>[0],
  ): ReturnType<ApprovalProjectionPort['create']> {
    this.creates.push(request);
    if (this.failCreate) return Promise.reject(new Error('synthetic outage'));
    return Promise.resolve({
      providerRecordId: providerRecordId(
        '40000000-0000-4000-8000-000000000003',
      ),
    });
  }

  update(
    request: Parameters<ApprovalProjectionPort['update']>[0],
  ): Promise<void> {
    this.updates.push(request);
    if (this.failUpdate) return Promise.reject(new Error('synthetic outage'));
    return Promise.resolve();
  }
}

function operation() {
  return {
    operationId: operationId('op_synthetic_approval'),
    requestId: requestId('req_synthetic_approval'),
    principalId: principalId('prn_participant'),
    clientId: 'synthetic-client',
    operation: 'update_record' as const,
    requestFingerprint: 'a'.repeat(64),
    targetBrainRecordId: 'brn_synthetic_target' as never,
    mutationPayload: {
      mode: 'replace' as const,
      replacement: { content: 'Synthetic private mutation payload' },
    },
    createdAt: now,
  };
}

function parent(key: 'operator' | 'steward'): AuthenticatedPrincipal {
  const id = principalId(`prn_${key}`);
  return {
    principal: {
      id,
      key,
      displayName: key === 'operator' ? 'Operator Example' : 'Steward Example',
      role: 'parent_steward',
      status: 'active',
    },
    identity: {
      issuer: 'https://accounts.google.com',
      externalSubject: `synthetic-${key}`,
      email: `${key}@example.invalid`,
      authenticatedAt: now,
      principalId: id,
    },
  };
}

async function pendingFixture() {
  const store = new SyntheticApprovalStore();
  const participant = brainReadPrincipal('family_participant');
  store.seedPrincipal(participant.principal);
  store.seedPrincipal(parent('operator').principal);
  store.seedPrincipal(parent('steward').principal);
  const opened = await store.openOperation(operation());
  await store.transitionOperationWithAudit(
    {
      operationId: opened.operation.operationId,
      expectedStates: ['RECEIVED'],
      nextState: 'AUTHORIZATION_REQUIRED',
      policyVersion: policy.version,
      transitionedAt: now,
    },
    { eventType: 'synthetic', reasonCode: 'synthetic_setup' },
  );
  const projection = new ProjectionSpy();
  const stored = await store.getOperation(operation().operationId);
  if (stored === null) throw new Error('missing synthetic operation');
  const approval = await new ApprovalRequestCoordinator(store, projection, {
    now: () => now,
  }).ensurePending(participant.principal, stored, new AbortController().signal);
  return { store, projection, approval };
}

describe('ApprovalRequestCoordinator', () => {
  it('reports an unreachable approval insert as retryable', async () => {
    const store = new SyntheticApprovalStore();
    store.seedPrincipal(brainReadPrincipal('family_participant').principal);
    const opened = await store.openOperation(operation());
    await store.transitionOperationWithAudit(
      {
        operationId: opened.operation.operationId,
        expectedStates: ['RECEIVED'],
        nextState: 'AUTHORIZATION_REQUIRED',
        policyVersion: policy.version,
        transitionedAt: now,
      },
      { eventType: 'synthetic', reasonCode: 'synthetic_setup' },
    );
    const stored = await store.getOperation(operation().operationId);
    if (stored === null) throw new Error('missing synthetic operation');
    store.createApproval = () =>
      Promise.reject(new Error('synthetic connection terminated'));

    await expect(
      new ApprovalRequestCoordinator(store, new ProjectionSpy(), {
        now: () => now,
      }).ensurePending(
        brainReadPrincipal('family_participant').principal,
        stored,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'approval_state_unavailable' },
    });
  });

  it('keeps the store-mapped transition error when the reload also fails', async () => {
    const store = new SyntheticApprovalStore();
    store.seedPrincipal(brainReadPrincipal('family_participant').principal);
    const opened = await store.openOperation(operation());
    await store.transitionOperationWithAudit(
      {
        operationId: opened.operation.operationId,
        expectedStates: ['RECEIVED'],
        nextState: 'AUTHORIZATION_REQUIRED',
        policyVersion: policy.version,
        transitionedAt: now,
      },
      { eventType: 'synthetic', reasonCode: 'synthetic_setup' },
    );
    const stored = await store.getOperation(operation().operationId);
    if (stored === null) throw new Error('missing synthetic operation');
    store.transitionOperationWithAudit = () =>
      Promise.reject(
        new DomainError('provider_unavailable', true, {
          reason: 'operation_audit_state_unavailable',
        }),
      );
    store.getOperation = () =>
      Promise.reject(new Error('synthetic connection terminated'));
    const coordinator = new ApprovalRequestCoordinator(
      store,
      new ProjectionSpy(),
      { now: () => now },
    );

    await expect(
      coordinator.ensurePending(
        brainReadPrincipal('family_participant').principal,
        stored,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      details: { reason: 'operation_audit_state_unavailable' },
    });
  });

  it('creates one durable safe approval and replays without duplicate projection', async () => {
    const store = new SyntheticApprovalStore();
    store.seedPrincipal(brainReadPrincipal('family_participant').principal);
    const opened = await store.openOperation(operation());
    await store.transitionOperationWithAudit(
      {
        operationId: opened.operation.operationId,
        expectedStates: ['RECEIVED'],
        nextState: 'AUTHORIZATION_REQUIRED',
        policyVersion: policy.version,
        transitionedAt: now,
      },
      { eventType: 'synthetic', reasonCode: 'synthetic_setup' },
    );
    const projection = new ProjectionSpy();
    const coordinator = new ApprovalRequestCoordinator(store, projection, {
      now: () => now,
    });

    const stored = await store.getOperation(operation().operationId);
    if (stored === null) throw new Error('missing synthetic operation');
    const first = await coordinator.ensurePending(
      brainReadPrincipal('family_participant').principal,
      stored,
      new AbortController().signal,
    );
    const replay = await coordinator.ensurePending(
      brainReadPrincipal('family_participant').principal,
      stored,
      new AbortController().signal,
    );

    expect(replay).toEqual(first);
    expect(await store.listPendingApprovals()).toHaveLength(1);
    expect(projection.creates).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain('private mutation payload');
    expect((await store.getOperation(operation().operationId))?.state).toBe(
      'APPROVAL_PENDING',
    );
  });

  it('keeps PostgreSQL authoritative when the Family Inbox projection fails', async () => {
    const store = new SyntheticApprovalStore();
    store.seedPrincipal(brainReadPrincipal('family_participant').principal);
    const opened = await store.openOperation(operation());
    await store.transitionOperationWithAudit(
      {
        operationId: opened.operation.operationId,
        expectedStates: ['RECEIVED'],
        nextState: 'AUTHORIZATION_REQUIRED',
        policyVersion: policy.version,
        transitionedAt: now,
      },
      { eventType: 'synthetic', reasonCode: 'synthetic_setup' },
    );
    const projection = new ProjectionSpy();
    projection.failCreate = true;

    const coordinator = new ApprovalRequestCoordinator(store, projection, {
      now: () => now,
    });
    const stored = await store.getOperation(operation().operationId);
    if (stored === null) throw new Error('missing synthetic operation');
    await expect(
      coordinator.ensurePending(
        brainReadPrincipal('family_participant').principal,
        stored,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'pending' });
    expect(await store.listPendingApprovals()).toHaveLength(1);
    projection.failCreate = false;
    await expect(
      coordinator.ensurePending(
        brainReadPrincipal('family_participant').principal,
        stored,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      familyInboxRecordId: '40000000-0000-4000-8000-000000000003',
    });
    expect(await store.listPendingApprovals()).toHaveLength(1);
    expect(projection.creates).toHaveLength(2);
  });

  it('recovers an uncertain projection by stable approval id before creating again', async () => {
    const store = new SyntheticApprovalStore();
    const participant = brainReadPrincipal('family_participant');
    store.seedPrincipal(participant.principal);
    const opened = await store.openOperation(operation());
    await store.transitionOperationWithAudit(
      {
        operationId: opened.operation.operationId,
        expectedStates: ['RECEIVED'],
        nextState: 'AUTHORIZATION_REQUIRED',
        transitionedAt: now,
      },
      { eventType: 'synthetic', reasonCode: 'synthetic_setup' },
    );
    const projection = new ProjectionSpy();
    projection.failCreate = true;
    const coordinator = new ApprovalRequestCoordinator(store, projection, {
      now: () => now,
    });
    const stored = await store.getOperation(opened.operation.operationId);
    if (stored === null) throw new Error('missing synthetic operation');
    await coordinator.ensurePending(
      participant.principal,
      stored,
      new AbortController().signal,
    );
    projection.failCreate = false;
    projection.found = {
      providerRecordId: providerRecordId(
        '40000000-0000-4000-8000-000000000003',
      ),
    };

    await expect(
      coordinator.ensurePending(
        participant.principal,
        (await store.getOperation(opened.operation.operationId)) ?? stored,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      familyInboxRecordId: '40000000-0000-4000-8000-000000000003',
    });
    expect(projection.creates).toHaveLength(1);
  });
});

describe('ApprovalService authorization', () => {
  const unusedResume = {
    resumeApprovedUpdate: () => Promise.reject(new Error('not exercised')),
    reconcileApprovedUpdate: () => Promise.reject(new Error('not exercised')),
    recoverApprovedUpdate: () => Promise.reject(new Error('not exercised')),
  };
  const outage = () =>
    Promise.reject(new Error('synthetic connection terminated'));
  const unavailable = {
    code: 'provider_unavailable',
    retryable: true,
    details: { reason: 'approval_state_unavailable' },
  };

  it('reports an unreachable approval store as retryable when listing', async () => {
    const store = new SyntheticApprovalStore();
    store.listPendingApprovals = outage;
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      new ProjectionSpy(),
      unusedResume,
      { now: () => now },
    );

    await expect(
      service.listApprovals(
        brainReadPrincipal('parent_steward'),
        brainReadContext('list-approvals-outage'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject(unavailable);
  });

  it.each(['getApproval', 'getOperation'] as const)(
    'reports an unreachable %s as retryable when resolving, before any change',
    async (method) => {
      const { store, projection, approval } = await pendingFixture();
      store[method] = outage;
      const service = new ApprovalService(
        new AuthorizationEngine(policy, { now: () => now }),
        store,
        projection,
        unusedResume,
        { now: () => now },
      );

      await expect(
        service.resolveApproval(
          parent('steward'),
          brainReadContext(`resolve-outage-${method}`),
          {
            approvalRequestId: approval.id,
            resolution: 'decline',
            reason: 'Synthetic outage check',
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject(unavailable);
      // Nothing changed: the approval is still pending, and nothing projected.
      expect((await store.listPendingApprovals()).map(({ id }) => id)).toEqual([
        approval.id,
      ]);
      expect(projection.updates).toHaveLength(0);
    },
  );

  it('reports an unreachable requester lookup as retryable before resolving', async () => {
    const { store, projection, approval } = await pendingFixture();
    store.getPrincipalById = outage;
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      projection,
      unusedResume,
      { now: () => now },
    );

    await expect(
      service.resolveApproval(
        parent('steward'),
        brainReadContext('resolve-principal-outage'),
        {
          approvalRequestId: approval.id,
          resolution: 'approve',
          reason: 'Synthetic outage check',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject(unavailable);
    expect((await store.listPendingApprovals()).map(({ id }) => id)).toEqual([
      approval.id,
    ]);
  });

  it('allows parents to list pending approvals and denies Participant', async () => {
    const store = new SyntheticApprovalStore();
    const projection = new ProjectionSpy();
    const telemetry: TelemetryObservation[] = [];
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      projection,
      {
        resumeApprovedUpdate: () =>
          Promise.reject(new Error('not exercised by list')),
        reconcileApprovedUpdate: () =>
          Promise.reject(new Error('not exercised by list')),
        recoverApprovedUpdate: () =>
          Promise.reject(new Error('not exercised by list')),
      },
      { now: () => now },
      {
        observe: (observation) => {
          telemetry.push(observation);
        },
      },
    );

    await expect(
      service.listApprovals(
        brainReadPrincipal('family_participant'),
        brainReadContext('list-approvals'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      service.listApprovals(
        brainReadPrincipal('parent_steward'),
        brainReadContext('list-approvals-parent'),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ approvals: [] });
    expect(telemetry).toEqual([
      { kind: 'gauge', name: 'approval.pending_count', value: 0 },
      {
        kind: 'gauge',
        name: 'approval.oldest_age',
        value: 0,
        tags: { unit: 'milliseconds' },
      },
    ]);
    await expectTelemetrySurvivesAdapter(telemetry);
  });

  it('lets either parent decline once with correlated metadata-only audit', async () => {
    const { store, projection, approval } = await pendingFixture();
    let executions = 0;
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      projection,
      {
        resumeApprovedUpdate: () => {
          executions += 1;
          return Promise.reject(new Error('unexpected execution'));
        },
        reconcileApprovedUpdate: () =>
          Promise.reject(new Error('unexpected reconciliation')),
        recoverApprovedUpdate: () =>
          Promise.reject(new Error('unexpected recovery')),
      },
      { now: () => now },
    );
    const request = {
      approvalRequestId: approval.id,
      resolution: 'decline' as const,
      reason: 'Do not apply the fictional change',
    };

    const first = await service.resolveApproval(
      parent('steward'),
      brainReadContext('decline-approval'),
      request,
      new AbortController().signal,
    );
    const replay = await service.resolveApproval(
      parent('steward'),
      brainReadContext('decline-approval-replay'),
      request,
      new AbortController().signal,
    );

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      approvalStatus: 'declined',
      operationState: 'FAILED',
    });
    expect(executions).toBe(0);
    expect(projection.updates).toHaveLength(2);
    const audit = store.auditEvents.at(-1);
    expect(audit).toMatchObject({
      principalId: principalId('prn_steward'),
      approvalRequestId: approval.id,
      operation: 'resolve_approval',
    });
    expect(JSON.stringify(audit)).not.toContain('fictional change');
  });

  it('durably records a failed terminal Inbox update until a replay repairs it', async () => {
    const { store, projection, approval } = await pendingFixture();
    projection.failUpdate = true;
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      projection,
      {
        resumeApprovedUpdate: () => Promise.reject(new Error('unexpected')),
        reconcileApprovedUpdate: () => Promise.reject(new Error('unexpected')),
        recoverApprovedUpdate: () => Promise.reject(new Error('unexpected')),
      },
      { now: () => now },
    );
    const request = {
      approvalRequestId: approval.id,
      resolution: 'decline' as const,
    };

    await service.resolveApproval(
      parent('steward'),
      brainReadContext('decline-outage'),
      request,
      new AbortController().signal,
    );
    await expect(store.listApprovalsRequiringProjectionSync()).resolves.toEqual(
      [expect.objectContaining({ id: approval.id })],
    );

    projection.failUpdate = false;
    await service.resolveApproval(
      parent('steward'),
      brainReadContext('decline-outage-replay'),
      request,
      new AbortController().signal,
    );
    await expect(store.listApprovalsRequiringProjectionSync()).resolves.toEqual(
      [],
    );
  });

  it('lets a parent cancel a pending request without mutation execution', async () => {
    const { store, projection, approval } = await pendingFixture();
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      projection,
      {
        resumeApprovedUpdate: () => Promise.reject(new Error('unexpected')),
        reconcileApprovedUpdate: () => Promise.reject(new Error('unexpected')),
        recoverApprovedUpdate: () => Promise.reject(new Error('unexpected')),
      },
      { now: () => now },
    );

    await expect(
      service.resolveApproval(
        parent('operator'),
        brainReadContext('cancel-approval'),
        { approvalRequestId: approval.id, resolution: 'cancel' },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      approvalStatus: 'cancelled',
      operationState: 'CANCELLED',
    });
  });

  it('approves once through the guarded continuation and replays without a second write', async () => {
    const { store, projection, approval } = await pendingFixture();
    let executions = 0;
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      projection,
      {
        resumeApprovedUpdate: async (stored, original, beforeDispatch) => {
          expect(original.id).toBe(principalId('prn_participant'));
          const claimed = await beforeDispatch(stored);
          if (claimed.disposition === 'existing') {
            return { operationId: stored.operationId, state: 'completed' };
          }
          executions += 1;
          await store.transitionOperationWithAudit(
            {
              operationId: stored.operationId,
              expectedStates: ['EXECUTING'],
              nextState: 'COMPLETED',
              transitionedAt: now,
            },
            { eventType: 'synthetic', reasonCode: 'synthetic_complete' },
          );
          return { operationId: stored.operationId, state: 'completed' };
        },
        reconcileApprovedUpdate: () =>
          Promise.reject(new Error('unexpected reconciliation')),
        recoverApprovedUpdate: () =>
          Promise.reject(new Error('unexpected recovery')),
      },
      { now: () => now },
    );
    const request = {
      approvalRequestId: approval.id,
      resolution: 'approve' as const,
    };

    const first = await service.resolveApproval(
      parent('operator'),
      brainReadContext('approve'),
      request,
      new AbortController().signal,
    );
    const replay = await service.resolveApproval(
      parent('operator'),
      brainReadContext('approve-replay'),
      request,
      new AbortController().signal,
    );

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      approvalStatus: 'approved',
      operationState: 'COMPLETED',
    });
    expect(executions).toBe(1);
  });

  it('answers a retryable outage when the outcome cannot be read after an approved write, and replays it on retry', async () => {
    const { store, projection, approval } = await pendingFixture();
    const getApproval = store.getApproval.bind(store);
    let executions = 0;
    let unreachable = false;
    store.getApproval = (id) =>
      unreachable
        ? Promise.reject(new Error('synthetic connection terminated'))
        : getApproval(id);
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      projection,
      {
        resumeApprovedUpdate: async (stored, _original, beforeDispatch) => {
          const claimed = await beforeDispatch(stored);
          if (claimed.disposition === 'existing') {
            return { operationId: stored.operationId, state: 'completed' };
          }
          executions += 1;
          await store.transitionOperationWithAudit(
            {
              operationId: stored.operationId,
              expectedStates: ['EXECUTING'],
              nextState: 'COMPLETED',
              transitionedAt: now,
            },
            { eventType: 'synthetic', reasonCode: 'synthetic_complete' },
          );
          // The write happened; the database then drops.
          unreachable = true;
          return { operationId: stored.operationId, state: 'completed' };
        },
        reconcileApprovedUpdate: () =>
          Promise.reject(new Error('unexpected reconciliation')),
        recoverApprovedUpdate: () =>
          Promise.reject(new Error('unexpected recovery')),
      },
      { now: () => now },
    );
    const request = {
      approvalRequestId: approval.id,
      resolution: 'approve' as const,
    };

    await expect(
      service.resolveApproval(
        parent('operator'),
        brainReadContext('approve-outage'),
        request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'approval_resolution_state_unavailable' },
    });
    unreachable = false;
    await expect(
      service.resolveApproval(
        parent('operator'),
        brainReadContext('approve-outage-retry'),
        request,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      approvalStatus: 'approved',
      operationState: 'COMPLETED',
    });
    expect(executions).toBe(1);
  });

  it('does not leave an approval pending behind a final-looking answer when its state cannot be re-read', async () => {
    const { store, projection, approval } = await pendingFixture();
    const getApproval = store.getApproval.bind(store);
    let unreachable = false;
    store.getApproval = (id) =>
      unreachable
        ? Promise.reject(new Error('synthetic connection terminated'))
        : getApproval(id);
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      projection,
      {
        // The resumed change finds its target gone, then the database drops.
        resumeApprovedUpdate: () => {
          unreachable = true;
          return Promise.reject(
            new DomainError('not_found', false, {
              reason: 'approval_target_changed',
            }),
          );
        },
        reconcileApprovedUpdate: () =>
          Promise.reject(new Error('unexpected reconciliation')),
        recoverApprovedUpdate: () =>
          Promise.reject(new Error('unexpected recovery')),
      },
      { now: () => now },
    );

    await expect(
      service.resolveApproval(
        parent('operator'),
        brainReadContext('approve-invalidated-outage'),
        { approvalRequestId: approval.id, resolution: 'approve' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'approval_state_unavailable' },
    });
    unreachable = false;
    expect((await store.getApproval(approval.id))?.status).toBe('pending');
  });

  it('answers a retryable outage when the final operation cannot be read after an approved write', async () => {
    const { store, projection, approval } = await pendingFixture();
    const getOperation = store.getOperation.bind(store);
    let unreachable = false;
    store.getOperation = (id) =>
      unreachable
        ? Promise.reject(new Error('synthetic connection terminated'))
        : getOperation(id);
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      projection,
      {
        resumeApprovedUpdate: async (stored, _original, beforeDispatch) => {
          await beforeDispatch(stored);
          await store.transitionOperationWithAudit(
            {
              operationId: stored.operationId,
              expectedStates: ['EXECUTING'],
              nextState: 'COMPLETED',
              transitionedAt: now,
            },
            { eventType: 'synthetic', reasonCode: 'synthetic_complete' },
          );
          unreachable = true;
          return { operationId: stored.operationId, state: 'completed' };
        },
        reconcileApprovedUpdate: () =>
          Promise.reject(new Error('unexpected reconciliation')),
        recoverApprovedUpdate: () =>
          Promise.reject(new Error('unexpected recovery')),
      },
      { now: () => now },
    );

    await expect(
      service.resolveApproval(
        parent('operator'),
        brainReadContext('approve-final-outage'),
        { approvalRequestId: approval.id, resolution: 'approve' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'approval_resolution_state_unavailable' },
    });
  });

  it('denies Participant resolution without changing authoritative state', async () => {
    const { store, projection, approval } = await pendingFixture();
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      projection,
      {
        resumeApprovedUpdate: () => Promise.reject(new Error('unexpected')),
        reconcileApprovedUpdate: () =>
          Promise.reject(new Error('unexpected reconciliation')),
        recoverApprovedUpdate: () =>
          Promise.reject(new Error('unexpected recovery')),
      },
      { now: () => now },
    );

    await expect(
      service.resolveApproval(
        brainReadPrincipal('family_participant'),
        brainReadContext('forged-resolution'),
        { approvalRequestId: approval.id, resolution: 'approve' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await store.getApproval(approval.id))?.status).toBe('pending');
  });

  it('rejects an unknown resolution value rather than treating it as cancellation', async () => {
    const { store, projection, approval } = await pendingFixture();
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      projection,
      {
        resumeApprovedUpdate: () => Promise.reject(new Error('unexpected')),
        reconcileApprovedUpdate: () => Promise.reject(new Error('unexpected')),
        recoverApprovedUpdate: () => Promise.reject(new Error('unexpected')),
      },
      { now: () => now },
    );

    await expect(
      service.resolveApproval(
        parent('operator'),
        brainReadContext('invalid-resolution'),
        {
          approvalRequestId: approval.id,
          resolution: 'authorize',
        } as never,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await store.getApproval(approval.id))?.status).toBe('pending');
  });

  it.each(['Synthetic\u0000reason', 'Synthetic\ud800reason'])(
    'rejects an unstorable resolution reason %j before any state change',
    async (reason) => {
      const { store, projection, approval } = await pendingFixture();
      const service = new ApprovalService(
        new AuthorizationEngine(policy, { now: () => now }),
        store,
        projection,
        {
          resumeApprovedUpdate: () => Promise.reject(new Error('unexpected')),
          reconcileApprovedUpdate: () =>
            Promise.reject(new Error('unexpected')),
          recoverApprovedUpdate: () => Promise.reject(new Error('unexpected')),
        },
        { now: () => now },
      );

      await expect(
        service.resolveApproval(
          parent('operator'),
          brainReadContext('unstorable-reason'),
          { approvalRequestId: approval.id, resolution: 'decline', reason },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        details: { reason: 'invalid_approval_resolution' },
      });
      expect((await store.getApproval(approval.id))?.status).toBe('pending');
    },
  );

  it('marks a missing target request superseded during fresh validation', async () => {
    const { store, projection, approval } = await pendingFixture();
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      projection,
      {
        resumeApprovedUpdate: () =>
          Promise.reject(
            new DomainError('not_found', false, { reason: 'record_not_found' }),
          ),
        reconcileApprovedUpdate: () =>
          Promise.reject(new Error('unexpected reconciliation')),
        recoverApprovedUpdate: () =>
          Promise.reject(new Error('unexpected recovery')),
      },
      { now: () => now },
    );

    await expect(
      service.resolveApproval(
        parent('operator'),
        brainReadContext('stale-approval'),
        { approvalRequestId: approval.id, resolution: 'approve' },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      approvalStatus: 'superseded',
      operationState: 'SUPERSEDED',
    });
  });

  it('keeps approval pending when fresh validation is only temporarily unavailable', async () => {
    const { store, projection, approval } = await pendingFixture();
    const service = new ApprovalService(
      new AuthorizationEngine(policy, { now: () => now }),
      store,
      projection,
      {
        resumeApprovedUpdate: () =>
          Promise.reject(
            new DomainError('provider_unavailable', true, {
              reason: 'synthetic_provider_outage',
            }),
          ),
        reconcileApprovedUpdate: () =>
          Promise.reject(new Error('unexpected reconciliation')),
        recoverApprovedUpdate: () =>
          Promise.reject(new Error('unexpected recovery')),
      },
      { now: () => now },
    );

    await expect(
      service.resolveApproval(
        parent('operator'),
        brainReadContext('temporary-outage'),
        { approvalRequestId: approval.id, resolution: 'approve' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect((await store.getApproval(approval.id))?.status).toBe('pending');
  });
});
