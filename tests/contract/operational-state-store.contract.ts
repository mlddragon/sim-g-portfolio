import { describe, expect, it } from 'vitest';

import type { ApprovalRequest } from '../../src/domain/approvals.js';
import { DomainError } from '../../src/domain/errors.js';
import {
  approvalRequestId,
  brainRecordId,
  elevationChallengeId,
  operationId,
  principalId,
  providerRecordId,
  requestId,
} from '../../src/domain/identifiers.js';
import type { CreateOperationRecord } from '../../src/ports/operational-state-store.js';
import type { OperationalStateStore } from '../../src/ports/operational-state-store.js';

interface ContractOptions {
  readonly getStore: () => OperationalStateStore;
  readonly query: <Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<readonly Row[]>;
  readonly restart: () => Promise<void>;
}

const masonId = principalId('prn_operator');
const jillId = principalId('prn_steward');
const addisonId = principalId('prn_participant');
const baseTime = new Date('2042-01-02T03:04:05.000Z');

function operation(
  overrides: Partial<CreateOperationRecord> = {},
): CreateOperationRecord {
  return {
    operationId: operationId('op_synthetic_001'),
    requestId: requestId('req_synthetic_001'),
    principalId: masonId,
    clientId: 'synthetic-test-client',
    operation: 'update_record',
    requestFingerprint: 'a'.repeat(64),
    semanticMetadata: {
      subject: 'fictional household procedure',
      recordType: 'procedure',
      sensitivity: 'family_shared',
    },
    mutationPayload: {
      mode: 'patch',
      title: 'Synthetic title',
    },
    targetBrainRecordId: brainRecordId('brn_synthetic_001'),
    createdAt: baseTime,
    ...overrides,
  };
}

function approval(
  operationIdValue = operationId('op_synthetic_001'),
): ApprovalRequest {
  return {
    id: approvalRequestId('apr_synthetic_001'),
    operationId: operationIdValue,
    requestedByPrincipalId: addisonId,
    status: 'pending',
    projectionSyncStatus: 'pending',
    summary: {
      requestedByDisplayName: 'Participant Example',
      action: 'Delete a fictional Family Shared record',
      safeTargetDescription: 'Synthetic chore note',
    },
    createdAt: new Date('2001-01-01T00:00:00.000Z'),
  };
}

export function operationalStateStoreContract(options: ContractOptions): void {
  describe('OperationalStateStore contract', () => {
    it('persists a correlated transition and audit together across restart and rejects a duplicate', async () => {
      const request = operation();
      await options.getStore().openOperation(request);
      const transition = {
        operationId: request.operationId,
        expectedStates: ['RECEIVED'] as const,
        nextState: 'EXECUTING' as const,
        transitionedAt: new Date('2042-01-02T03:04:06.000Z'),
      };
      await options.getStore().transitionOperationWithAudit(transition, {
        eventType: 'brain.operation.transitioned',
      });
      await options.restart();
      expect(
        await options.getStore().getOperation(request.operationId),
      ).toMatchObject({
        state: 'EXECUTING',
        updatedAt: new Date('2042-01-02T03:04:06.000Z'),
      });
      expect(await options.getStore().listPendingAuditEvents(10)).toMatchObject(
        [
          {
            event: {
              operationId: 'op_synthetic_001',
              requestId: 'req_synthetic_001',
              principalId: 'prn_operator',
              operation: 'update_record',
              outcome: 'EXECUTING',
              timestamp: new Date('2042-01-02T03:04:06.000Z'),
            },
          },
        ],
      );
      await expect(
        options.getStore().transitionOperationWithAudit(transition, {
          eventType: 'brain.operation.transitioned',
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(await options.getStore().listPendingAuditEvents(10)).toHaveLength(
        1,
      );
    });

    it('loads an immutable issuer/subject principal binding', async () => {
      await options.query(
        `INSERT INTO identity_bindings
          (id, principal_id, issuer, external_subject, email, enabled)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [
          'idb_synthetic_operator',
          masonId,
          'https://accounts.google.com',
          'synthetic-subject-operator',
          'operator@example.invalid',
        ],
      );

      const binding = await options.getStore().findPrincipalByExternalIdentity({
        issuer: 'https://accounts.google.com',
        externalSubject: 'synthetic-subject-operator',
      });

      expect(binding).toEqual({
        principal: {
          id: masonId,
          key: 'operator',
          displayName: 'Operator',
          role: 'owner_operator',
          status: 'active',
        },
        issuer: 'https://accounts.google.com',
        externalSubject: 'synthetic-subject-operator',
        email: 'operator@example.invalid',
        enabled: true,
      });

      await expect(
        options.query(
          `INSERT INTO identity_bindings
            (id, principal_id, issuer, external_subject, email, enabled)
           VALUES ($1, $2, $3, $4, $5, true)`,
          [
            'idb_duplicate_subject',
            jillId,
            'https://accounts.google.com',
            'synthetic-subject-operator',
            'steward@example.invalid',
          ],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('opens one operation per principal, operation, and request fingerprint', async () => {
      const store = options.getStore();
      const first = await store.openOperation(operation());
      const replay = await store.openOperation(
        operation({ operationId: operationId('op_replayed_client_value') }),
      );

      expect(first.disposition).toBe('created');
      expect(first.operation.state).toBe('RECEIVED');
      expect(replay).toEqual({
        disposition: 'existing',
        operation: first.operation,
      });

      await expect(
        store.openOperation(
          operation({
            operationId: operationId('op_conflicting_payload'),
            requestFingerprint: 'b'.repeat(64),
          }),
        ),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'idempotency_conflict',
        retryable: false,
      });

      const rows = await options.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM operations',
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('never lets another principal claim or replay an existing operation ID', async () => {
      const store = options.getStore();
      const first = await store.openOperation(operation());

      await expect(
        store.openOperation(
          operation({
            principalId: addisonId,
            requestId: requestId('req_participant_squat'),
          }),
        ),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'idempotency_conflict',
        retryable: false,
      });
      await expect(
        store.getOperation(operationId('op_synthetic_001')),
      ).resolves.toEqual(first.operation);
    });

    it.each([
      [
        'a NUL in semantic metadata',
        { semanticMetadata: { subject: 'Synthetic\u0000subject' } },
      ],
      [
        'a lone surrogate in a mutation payload',
        { mutationPayload: { mode: 'patch', title: 'Synthetic\ud800' } },
      ],
    ])('rejects %s as a safe invalid request', async (_, overrides) => {
      const store = options.getStore();

      await expect(
        store.openOperation(
          operation(overrides as Partial<CreateOperationRecord>),
        ),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'invalid_request',
        retryable: false,
        details: { reason: 'unstorable_operation_text' },
      });
      const rows = await options.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM operations',
      );
      expect(rows[0]?.count).toBe('0');
    });

    it('performs compare-and-set operation transitions atomically', async () => {
      const store = options.getStore();
      await store.openOperation(operation());

      const executing = await store.transitionOperation({
        operationId: operationId('op_synthetic_001'),
        expectedStates: ['RECEIVED'],
        nextState: 'EXECUTING',
        provider: 'notion',
        policyVersion: 'policy-v1',
        transitionedAt: new Date('2042-01-02T03:05:05.000Z'),
      });
      expect(executing.state).toBe('EXECUTING');
      expect(executing.provider).toBe('notion');

      await expect(
        store.transitionOperation({
          operationId: operationId('op_synthetic_001'),
          expectedStates: ['RECEIVED'],
          nextState: 'COMPLETED',
          transitionedAt: new Date('2042-01-02T03:06:05.000Z'),
        }),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'invalid_request',
        retryable: false,
      });

      expect(
        await store.getOperation(operationId('op_synthetic_001')),
      ).toMatchObject({ state: 'EXECUTING' });
    });

    it('replays createApproval after the projection is attached, and still refuses a different identity', async () => {
      const store = options.getStore();
      await store.openOperation(
        operation({
          principalId: addisonId,
          operation: 'delete_record',
        }),
      );
      await store.createApproval(approval());
      await store.setApprovalProjectionReference({
        approvalRequestId: approvalRequestId('apr_synthetic_001'),
        familyInboxRecordId: providerRecordId('notion_inbox_synthetic_001'),
      });

      // The coordinator's retry sends the same request without the reference.
      await expect(store.createApproval(approval())).resolves.toMatchObject({
        id: approvalRequestId('apr_synthetic_001'),
        familyInboxRecordId: 'notion_inbox_synthetic_001',
        projectionSyncStatus: 'synced',
      });
      await expect(
        store.createApproval({
          ...approval(),
          requestedByPrincipalId: masonId,
        }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    });

    it('keeps approvals pending indefinitely and resolves once', async () => {
      const store = options.getStore();
      await store.openOperation(
        operation({
          principalId: addisonId,
          operation: 'delete_record',
        }),
      );
      await store.createApproval(approval());

      expect(await store.listPendingApprovals()).toHaveLength(1);

      const projected = await store.setApprovalProjectionReference({
        approvalRequestId: approvalRequestId('apr_synthetic_001'),
        familyInboxRecordId: providerRecordId('notion_inbox_synthetic_001'),
      });
      expect(projected.familyInboxRecordId).toBe('notion_inbox_synthetic_001');
      expect(projected.projectionSyncStatus).toBe('synced');

      const resolved = await store.resolveApproval({
        approvalRequestId: approvalRequestId('apr_synthetic_001'),
        resolution: 'approve',
        resolvedByPrincipalId: jillId,
        reason: 'Reviewed fictional fixture',
        resolvedAt: new Date('2042-02-03T04:05:06.000Z'),
      });
      expect(resolved).toMatchObject({
        status: 'approved',
        resolvedByPrincipalId: jillId,
      });
      expect(await store.listPendingApprovals()).toEqual([]);
      await expect(
        store.listApprovalsRequiringProjectionSync(),
      ).resolves.toEqual([
        expect.objectContaining({
          id: approvalRequestId('apr_synthetic_001'),
          projectionSyncStatus: 'pending',
        }),
      ]);
      await expect(
        store.markApprovalProjectionSynced({
          approvalRequestId: approvalRequestId('apr_synthetic_001'),
          expectedStatus: 'approved',
        }),
      ).resolves.toMatchObject({ projectionSyncStatus: 'synced' });
      await expect(
        store.listApprovalsRequiringProjectionSync(),
      ).resolves.toEqual([]);

      await expect(
        store.resolveApproval({
          approvalRequestId: approvalRequestId('apr_synthetic_001'),
          resolution: 'decline',
          resolvedByPrincipalId: masonId,
          resolvedAt: new Date('2042-02-03T04:06:06.000Z'),
        }),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'invalid_request',
      });
    });

    it('preserves terminal projection repair when the Inbox reference arrives after resolution', async () => {
      const store = options.getStore();
      await store.openOperation(
        operation({
          principalId: addisonId,
          operation: 'delete_record',
        }),
      );
      await store.createApproval(approval());
      await store.resolveApproval({
        approvalRequestId: approvalRequestId('apr_synthetic_001'),
        resolution: 'decline',
        resolvedByPrincipalId: jillId,
        resolvedAt: new Date('2042-02-03T04:05:06.000Z'),
      });

      await expect(
        store.setApprovalProjectionReference({
          approvalRequestId: approvalRequestId('apr_synthetic_001'),
          familyInboxRecordId: providerRecordId(
            'notion_inbox_synthetic_late_reference',
          ),
        }),
      ).resolves.toMatchObject({
        status: 'declined',
        projectionSyncStatus: 'pending',
      });
      await options.restart();
      await expect(
        options.getStore().listApprovalsRequiringProjectionSync(),
      ).resolves.toEqual([
        expect.objectContaining({
          id: approvalRequestId('apr_synthetic_001'),
          projectionSyncStatus: 'pending',
        }),
      ]);
    });

    it('atomically resolves an approval, transitions its operation, and audits the parent across restart', async () => {
      const store = options.getStore();
      const original = operation({ principalId: addisonId });
      await store.openOperation(original);
      await store.transitionOperation({
        operationId: original.operationId,
        expectedStates: ['RECEIVED'],
        nextState: 'APPROVAL_PENDING',
        policyVersion: 'policy-v1',
        transitionedAt: new Date('2042-01-02T03:05:05.000Z'),
      });
      await store.createApproval(approval());
      const request = {
        approvalRequestId: approvalRequestId('apr_synthetic_001'),
        status: 'declined' as const,
        resolvedByPrincipalId: jillId,
        reason: 'Declined by a parent steward.',
        resolvedAt: new Date('2042-02-03T04:05:06.000Z'),
        operationTransition: {
          operationId: original.operationId,
          expectedStates: ['APPROVAL_PENDING'] as const,
          nextState: 'FAILED' as const,
          policyVersion: 'policy-v1',
          transitionedAt: new Date('2042-02-03T04:05:06.000Z'),
        },
        audit: {
          eventType: 'brain.approval.resolved',
          requestId: requestId('req_synthetic_resolution'),
          principalId: jillId,
          clientId: 'synthetic-test-client',
          operation: 'resolve_approval' as const,
          reasonCode: 'approval_declined',
        },
      };

      await store.openOperation(
        operation({
          operationId: operationId('op_synthetic_other'),
          requestId: requestId('req_synthetic_other'),
        }),
      );
      await expect(
        store.resolveApprovalWithOperation({
          ...request,
          operationTransition: {
            ...request.operationTransition,
            operationId: operationId('op_synthetic_other'),
            expectedStates: ['RECEIVED'],
          },
        }),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        details: { reason: 'approval_operation_mismatch' },
      });
      expect(await store.getApproval(request.approvalRequestId)).toMatchObject({
        status: 'pending',
      });

      await expect(
        store.resolveApprovalWithOperation(request),
      ).resolves.toMatchObject({
        disposition: 'resolved',
        approval: { status: 'declined', resolvedByPrincipalId: jillId },
        operation: { state: 'FAILED' },
      });
      await options.restart();
      await expect(
        options.getStore().resolveApprovalWithOperation(request),
      ).resolves.toMatchObject({ disposition: 'existing' });
      expect(
        await options.getStore().getPrincipalById(addisonId),
      ).toMatchObject({
        id: addisonId,
        role: 'family_participant',
        status: 'active',
      });
      const audits = await options.getStore().listPendingAuditEvents(10);
      expect(
        audits.some(
          ({ event }) =>
            event.eventType === 'brain.approval.resolved' &&
            event.principalId === jillId &&
            event.approvalRequestId ===
              approvalRequestId('apr_synthetic_001') &&
            event.operation === 'resolve_approval' &&
            event.outcome === 'FAILED',
        ),
      ).toBe(true);
    });

    it('consumes an exact unexpired elevation challenge only once', async () => {
      const store = options.getStore();
      await pendingElevation(store);
      await store.createElevationChallenge({
        id: elevationChallengeId('elv_synthetic_001'),
        operationId: operationId('op_synthetic_001'),
        principalId: masonId,
        confirmationTokenHash: 'c'.repeat(64),
        requestFingerprint: 'a'.repeat(64),
        policyVersion: 'policy-v1',
        frozenTargetIds: [brainRecordId('brn_synthetic_001')],
        createdAt: baseTime,
        expiresAt: new Date('2042-01-02T03:09:05.000Z'),
      });

      await expect(
        store.consumeElevationChallenge({
          challengeId: elevationChallengeId('elv_synthetic_001'),
          operationId: operationId('op_synthetic_001'),
          principalId: masonId,
          confirmationTokenHash: 'c'.repeat(64),
          requestFingerprint: 'a'.repeat(64),
          policyVersion: 'policy-v1',
          frozenTargetIds: [brainRecordId('brn_wrong_target')],
          consumedAt: new Date('2042-01-02T03:08:04.000Z'),
        }),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'elevation_required',
      });

      const consumed = await store.consumeElevationChallenge({
        challengeId: elevationChallengeId('elv_synthetic_001'),
        operationId: operationId('op_synthetic_001'),
        principalId: masonId,
        confirmationTokenHash: 'c'.repeat(64),
        requestFingerprint: 'a'.repeat(64),
        policyVersion: 'policy-v1',
        frozenTargetIds: [brainRecordId('brn_synthetic_001')],
        consumedAt: new Date('2042-01-02T03:08:05.000Z'),
      });
      expect(consumed.consumedAt).toEqual(new Date('2042-01-02T03:08:05.000Z'));

      await expect(
        store.consumeElevationChallenge({
          challengeId: elevationChallengeId('elv_synthetic_001'),
          operationId: operationId('op_synthetic_001'),
          principalId: masonId,
          confirmationTokenHash: 'c'.repeat(64),
          requestFingerprint: 'a'.repeat(64),
          policyVersion: 'policy-v1',
          frozenTargetIds: [brainRecordId('brn_synthetic_001')],
          consumedAt: new Date('2042-01-02T03:08:06.000Z'),
        }),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'elevation_required',
      });
    });

    it('stores a pending payload only when moving an operation without one into approval', async () => {
      const store = options.getStore();
      const { mutationPayload: _discarded, ...withoutPayload } = operation({
        operationId: operationId('op_synthetic_append'),
        requestId: requestId('req_synthetic_append'),
        operation: 'append_to_record',
      });
      await store.openOperation(withoutPayload);
      const append = await store.getOperation(
        operationId('op_synthetic_append'),
      );
      expect(append?.mutationPayload).toBeUndefined();

      await expect(
        store.transitionOperationWithAudit(
          {
            operationId: operationId('op_synthetic_append'),
            expectedStates: ['RECEIVED'],
            nextState: 'EXECUTING',
            mutationPayload: { content: 'Synthetic pending body' },
            transitionedAt: baseTime,
          },
          { eventType: 'brain.mutation.transitioned' },
        ),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'invalid_request',
      });

      const pending = await store.transitionOperationWithAudit(
        {
          operationId: operationId('op_synthetic_append'),
          expectedStates: ['RECEIVED'],
          nextState: 'AUTHORIZATION_REQUIRED',
          mutationPayload: { content: 'Synthetic pending body' },
          transitionedAt: baseTime,
        },
        { eventType: 'brain.mutation.transitioned' },
      );
      expect(pending.mutationPayload).toEqual({
        content: 'Synthetic pending body',
      });
      const audits = await store.listPendingAuditEvents(10);
      expect(JSON.stringify(audits)).not.toContain('Synthetic pending body');

      await store.openOperation(operation());
      await expect(
        store.transitionOperationWithAudit(
          {
            operationId: operationId('op_synthetic_001'),
            expectedStates: ['RECEIVED'],
            nextState: 'AUTHORIZATION_REQUIRED',
            mutationPayload: { content: 'Synthetic overwrite' },
            transitionedAt: baseTime,
          },
          { eventType: 'brain.mutation.transitioned' },
        ),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'invalid_request',
      });
      expect(
        (await store.getOperation(operationId('op_synthetic_001')))
          ?.mutationPayload,
      ).toEqual({ mode: 'patch', title: 'Synthetic title' });
    });

    it.each(['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'] as const)(
      'clears the pending payload when an operation becomes %s',
      async (terminal) => {
        const store = options.getStore();
        await store.openOperation(operation());
        await store.transitionOperation({
          operationId: operationId('op_synthetic_001'),
          expectedStates: ['RECEIVED'],
          nextState: 'EXECUTING',
          transitionedAt: baseTime,
        });
        expect(
          (await store.getOperation(operationId('op_synthetic_001')))
            ?.mutationPayload,
        ).toEqual({ mode: 'patch', title: 'Synthetic title' });

        const settled = await store.transitionOperationWithAudit(
          {
            operationId: operationId('op_synthetic_001'),
            expectedStates: ['EXECUTING'],
            nextState: terminal,
            transitionedAt: baseTime,
          },
          { eventType: 'brain.mutation.transitioned' },
        );

        expect(settled.mutationPayload).toBeUndefined();
        await options.restart();
        expect(
          (
            await options
              .getStore()
              .getOperation(operationId('op_synthetic_001'))
          )?.mutationPayload,
        ).toBeUndefined();
      },
    );

    it('refuses a pending payload for any operation other than an append', async () => {
      const store = options.getStore();
      const { mutationPayload: _discarded, ...withoutPayload } = operation({
        operationId: operationId('op_synthetic_delete'),
        requestId: requestId('req_synthetic_delete'),
        operation: 'delete_record',
      });
      await store.openOperation(withoutPayload);
      await expect(
        store.transitionOperationWithAudit(
          {
            operationId: operationId('op_synthetic_delete'),
            expectedStates: ['RECEIVED'],
            nextState: 'AUTHORIZATION_REQUIRED',
            mutationPayload: { content: 'Synthetic smuggled body' },
            transitionedAt: baseTime,
          },
          { eventType: 'brain.mutation.transitioned' },
        ),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'invalid_request',
      });
    });

    async function pendingElevation(store: OperationalStateStore) {
      await store.openOperation(operation());
      await store.transitionOperation({
        operationId: operationId('op_synthetic_001'),
        expectedStates: ['RECEIVED'],
        nextState: 'ELEVATION_PENDING',
        policyVersion: 'policy-v1',
        transitionedAt: baseTime,
      });
    }

    function elevationChallenge(index: number, createdAt = baseTime) {
      return {
        id: elevationChallengeId(`elv_synthetic_00${String(index)}`),
        operationId: operationId('op_synthetic_001'),
        principalId: masonId,
        confirmationTokenHash: String(index).repeat(64),
        requestFingerprint: 'a'.repeat(64),
        policyVersion: 'policy-v1',
        frozenTargetIds: [brainRecordId('brn_synthetic_001')],
        createdAt,
        expiresAt: new Date(createdAt.getTime() + 5 * 60_000),
      };
    }

    function confirmation(
      index: number,
      consumedAt = new Date(baseTime.getTime() + 60_000),
    ) {
      const challenge = elevationChallenge(index);
      return {
        consume: {
          challengeId: challenge.id,
          operationId: challenge.operationId,
          principalId: challenge.principalId,
          confirmationTokenHash: challenge.confirmationTokenHash,
          requestFingerprint: challenge.requestFingerprint,
          policyVersion: challenge.policyVersion,
          frozenTargetIds: challenge.frozenTargetIds,
          consumedAt,
        },
        operationTransition: {
          operationId: challenge.operationId,
          expectedStates: ['ELEVATION_PENDING'] as const,
          nextState: 'EXECUTING' as const,
          provider: 'notion' as const,
          providerRecordId: providerRecordId('notion-synthetic-elevated'),
          providerVersion: 'notion-version-synthetic',
          policyVersion: 'policy-v1',
          transitionedAt: consumedAt,
        },
        audit: {
          eventType: 'brain.mutation.transitioned',
          reasonCode: 'elevated_action_confirmed',
        },
      };
    }

    it('supersedes every earlier live challenge when a new one is issued', async () => {
      const store = options.getStore();
      await pendingElevation(store);
      await store.createElevationChallenge(elevationChallenge(1));
      await store.createElevationChallenge(
        elevationChallenge(2, new Date(baseTime.getTime() + 1_000)),
      );
      expect(
        await store.createElevationChallenge(
          elevationChallenge(2, new Date(baseTime.getTime() + 1_000)),
        ),
      ).toMatchObject({ id: elevationChallengeId('elv_synthetic_002') });

      await expect(
        store.confirmElevationWithOperation(confirmation(1)),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'elevation_required',
      });
      await expect(
        store.consumeElevationChallenge(confirmation(1).consume),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'elevation_required',
      });
      await expect(
        store.confirmElevationWithOperation(confirmation(2)),
      ).resolves.toMatchObject({
        challenge: { id: elevationChallengeId('elv_synthetic_002') },
        operation: { state: 'EXECUTING' },
      });
    });

    it('consumes a challenge and claims execution with one audit in one transaction', async () => {
      const store = options.getStore();
      await pendingElevation(store);
      await store.createElevationChallenge(elevationChallenge(1));

      const claimed = await store.confirmElevationWithOperation(
        confirmation(1),
      );

      expect(claimed.challenge.consumedAt).toEqual(
        new Date(baseTime.getTime() + 60_000),
      );
      expect(claimed.operation).toMatchObject({
        state: 'EXECUTING',
        provider: 'notion',
        providerVersion: 'notion-version-synthetic',
      });
      await options.restart();
      const restarted = options.getStore();
      expect(
        await restarted.findConsumedElevationChallenge(
          operationId('op_synthetic_001'),
        ),
      ).toMatchObject({ id: elevationChallengeId('elv_synthetic_001') });
      expect(
        (await restarted.listPendingAuditEvents(10)).map(({ event }) => [
          event.outcome,
          event.reasonCode,
        ]),
      ).toEqual([['EXECUTING', 'elevated_action_confirmed']]);
      await expect(
        restarted.confirmElevationWithOperation(confirmation(1)),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'elevation_required',
      });
      expect(await restarted.listPendingAuditEvents(10)).toHaveLength(1);
    });

    it('issues challenges only for an operation pending elevation by the same principal', async () => {
      const store = options.getStore();
      await store.openOperation(operation());
      await expect(
        store.createElevationChallenge(elevationChallenge(1)),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'elevation_required',
      });
      await store.transitionOperation({
        operationId: operationId('op_synthetic_001'),
        expectedStates: ['RECEIVED'],
        nextState: 'ELEVATION_PENDING',
        policyVersion: 'policy-v1',
        transitionedAt: baseTime,
      });
      await expect(
        store.createElevationChallenge({
          ...elevationChallenge(1),
          principalId: jillId,
        }),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'elevation_required',
      });
      await expect(
        store.createElevationChallenge({
          ...elevationChallenge(1),
          operationId: operationId('op_synthetic_missing'),
        }),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'elevation_required',
      });
      const live = await options.query<{ readonly count: string }>(
        'SELECT count(*)::text AS count FROM elevation_challenges',
      );
      expect(live[0]?.count).toBe('0');
    });

    it('leaves the challenge live when the operation is no longer pending elevation', async () => {
      const store = options.getStore();
      await pendingElevation(store);
      await store.createElevationChallenge(elevationChallenge(1));
      await store.transitionOperation({
        operationId: operationId('op_synthetic_001'),
        expectedStates: ['ELEVATION_PENDING'],
        nextState: 'FAILED',
        transitionedAt: baseTime,
      });

      await expect(
        store.confirmElevationWithOperation(confirmation(1)),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'elevation_required',
      });
      expect(
        await store.findConsumedElevationChallenge(
          operationId('op_synthetic_001'),
        ),
      ).toBeNull();
      expect(await store.listPendingAuditEvents(10)).toHaveLength(0);
      expect(
        await store.consumeElevationChallenge(confirmation(1).consume),
      ).toMatchObject({ id: elevationChallengeId('elv_synthetic_001') });
    });

    it('rejects a confirmation by a different principal or for a different operation', async () => {
      const store = options.getStore();
      await pendingElevation(store);
      await store.createElevationChallenge(elevationChallenge(1));
      const valid = confirmation(1);

      await expect(
        store.confirmElevationWithOperation({
          ...valid,
          consume: { ...valid.consume, principalId: jillId },
        }),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'elevation_required',
      });
      await expect(
        store.confirmElevationWithOperation({
          ...valid,
          operationTransition: {
            ...valid.operationTransition,
            operationId: operationId('op_synthetic_other'),
          },
        }),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'invalid_request',
      });
      expect(
        await store.findConsumedElevationChallenge(
          operationId('op_synthetic_001'),
        ),
      ).toBeNull();
    });

    it('serializes issuance racing a confirmation so the claim never uses a superseded challenge', async () => {
      const store = options.getStore();
      await pendingElevation(store);
      await store.createElevationChallenge(elevationChallenge(1));

      const [issued, confirmed] = await Promise.allSettled([
        options
          .getStore()
          .createElevationChallenge(
            elevationChallenge(2, new Date(baseTime.getTime() + 1_000)),
          ),
        options.getStore().confirmElevationWithOperation(confirmation(1)),
      ]);

      const rows = await options.query<{
        readonly id: string;
        readonly consumed: boolean;
        readonly superseded: boolean;
      }>(
        `SELECT id, consumed_at IS NOT NULL AS consumed,
                superseded_at IS NOT NULL AS superseded
         FROM elevation_challenges ORDER BY id`,
      );
      const state = (await store.getOperation(operationId('op_synthetic_001')))
        ?.state;
      if (confirmed.status === 'fulfilled') {
        // Confirmation won the lock: issuance must then refuse a settled operation.
        expect(issued.status).toBe('rejected');
        expect(state).toBe('EXECUTING');
        expect(rows).toEqual([
          { id: 'elv_synthetic_001', consumed: true, superseded: false },
        ]);
      } else {
        // Issuance won the lock: the held challenge is superseded, nothing executes.
        expect(issued.status).toBe('fulfilled');
        expect(state).toBe('ELEVATION_PENDING');
        expect(rows).toEqual([
          { id: 'elv_synthetic_001', consumed: false, superseded: true },
          { id: 'elv_synthetic_002', consumed: false, superseded: false },
        ]);
      }
    });

    it('lets exactly one concurrent confirmation claim execution', async () => {
      const store = options.getStore();
      await pendingElevation(store);
      await store.createElevationChallenge(elevationChallenge(1));

      const outcomes = await Promise.allSettled([
        options.getStore().confirmElevationWithOperation(confirmation(1)),
        options
          .getStore()
          .confirmElevationWithOperation(
            confirmation(1, new Date(baseTime.getTime() + 61_000)),
          ),
      ]);

      expect(
        outcomes.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      expect(await store.listPendingAuditEvents(10)).toHaveLength(1);
      expect(
        await store.getOperation(operationId('op_synthetic_001')),
      ).toMatchObject({ state: 'EXECUTING' });
    });

    it('persists a gateway creator on an alias and only fills a missing one', async () => {
      const store = options.getStore();
      const base = {
        brainRecordId: brainRecordId('brn_synthetic_created'),
        provider: 'notion' as const,
        providerRecordId: providerRecordId('notion-synthetic-created'),
        canonicalLocation: {
          provider: 'notion' as const,
          containerRef: 'notion.family_shared',
        },
        createdAt: baseTime,
        updatedAt: baseTime,
      };
      expect(await store.ensureBrainRecordAlias(base)).not.toHaveProperty(
        'creatorPrincipalId',
      );
      expect(
        await store.ensureBrainRecordAlias({
          ...base,
          brainRecordId: brainRecordId('brn_synthetic_candidate'),
          creatorPrincipalId: addisonId,
        }),
      ).toMatchObject({
        brainRecordId: brainRecordId('brn_synthetic_created'),
        creatorPrincipalId: addisonId,
      });
      expect(
        await store.ensureBrainRecordAlias({
          ...base,
          creatorPrincipalId: masonId,
        }),
      ).toMatchObject({ creatorPrincipalId: addisonId });
      await options.restart();
      expect(
        await options
          .getStore()
          .findBrainRecordAlias(brainRecordId('brn_synthetic_created')),
      ).toMatchObject({ creatorPrincipalId: addisonId });
    });

    it('reuses a stable alias for the same provider record', async () => {
      const store = options.getStore();
      const first = await store.ensureBrainRecordAlias({
        brainRecordId: brainRecordId('brn_synthetic_001'),
        provider: 'drive',
        providerRecordId: providerRecordId('drive_file_synthetic_001'),
        canonicalLocation: {
          provider: 'drive',
          containerRef: 'drive_root_synthetic',
        },
        createdAt: baseTime,
        updatedAt: baseTime,
      });
      const reused = await store.ensureBrainRecordAlias({
        brainRecordId: brainRecordId('brn_different_proposal'),
        provider: 'drive',
        providerRecordId: providerRecordId('drive_file_synthetic_001'),
        canonicalLocation: {
          provider: 'drive',
          containerRef: 'drive_root_synthetic',
        },
        createdAt: new Date('2042-01-02T03:06:05.000Z'),
        updatedAt: new Date('2042-01-02T03:06:05.000Z'),
      });

      expect(reused).toEqual(first);
      await expect(
        store.findBrainRecordAlias(brainRecordId('brn_synthetic_001')),
      ).resolves.toEqual(first);
      await expect(
        store.findBrainRecordAliasByProvider(
          'drive',
          providerRecordId('drive_file_synthetic_001'),
        ),
      ).resolves.toEqual(first);
    });

    it('persists independently versioned governance and registry locks', async () => {
      const store = options.getStore();
      await store.recordGovernanceVersion({
        kind: 'executable_policy',
        version: 'policy-v1',
        contentHash: 'd'.repeat(64),
        sourceReference: 'config://test/policy-v1',
        canonicalMarker: 'brain-policy-v1',
        activatedAt: baseTime,
      });
      await store.recordGovernanceVersion({
        kind: 'project_registry',
        version: 'registry-v1',
        contentHash: 'e'.repeat(64),
        sourceReference: 'registry://test/projects-v1',
        canonicalMarker: 'brain-registry-v1',
        activatedAt: baseTime,
      });

      await expect(
        store.getActiveGovernanceVersion('executable_policy'),
      ).resolves.toMatchObject({ version: 'policy-v1' });
      await expect(
        store.getActiveGovernanceVersion('project_registry'),
      ).resolves.toMatchObject({ version: 'registry-v1' });

      await expect(
        store.recordGovernanceVersion({
          kind: 'executable_policy',
          version: 'policy-v1',
          contentHash: 'f'.repeat(64),
          sourceReference: 'config://test/policy-v1',
          canonicalMarker: 'brain-policy-v1',
          activatedAt: baseTime,
        }),
      ).rejects.toMatchObject<Partial<DomainError>>({ code: 'policy_drift' });
    });

    it('records reconciliation attempts without accepting conflicting replay', async () => {
      const store = options.getStore();
      await store.openOperation(operation());
      const attempt = {
        operationId: operationId('op_synthetic_001'),
        attempt: 1,
        outcome: 'inconclusive' as const,
        safeMetadata: { reason: 'synthetic_timeout' },
        attemptedAt: new Date('2042-01-02T03:07:05.000Z'),
      };
      await store.recordReconciliationAttempt(attempt);
      await store.recordReconciliationAttempt(attempt);

      expect(
        await store.listReconciliationAttempts(operationId('op_synthetic_001')),
      ).toEqual([attempt]);

      await expect(
        store.recordReconciliationAttempt({
          ...attempt,
          outcome: 'completed',
        }),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'idempotency_conflict',
      });
    });

    it('durably retries and acknowledges metadata-only audit outbox events', async () => {
      const store = options.getStore();
      const event = {
        eventType: 'brain.mutation.completed',
        requestId: requestId('req_synthetic_001'),
        principalId: masonId,
        operationId: operationId('op_synthetic_001'),
        operation: 'update_record' as const,
        provider: 'notion' as const,
        brainRecordId: brainRecordId('brn_synthetic_001'),
        providerRecordId: providerRecordId('notion_synthetic_001'),
        policyVersion: 'policy-v1',
        outcome: 'COMPLETED' as const,
        timestamp: baseTime,
        sensitiveContent: 'SYNTHETIC_SECRET_MARKER_DO_NOT_PERSIST',
      };
      const queued = await store.enqueueAuditEvent(event);
      expect(queued).toMatchObject({
        event: {
          eventType: event.eventType,
          requestId: event.requestId,
          principalId: event.principalId,
          operationId: event.operationId,
          operation: event.operation,
          provider: event.provider,
          brainRecordId: event.brainRecordId,
          providerRecordId: event.providerRecordId,
          policyVersion: event.policyVersion,
          outcome: event.outcome,
          timestamp: event.timestamp,
        },
        attempts: 0,
      });
      expect(queued.event).not.toHaveProperty('sensitiveContent');
      const rawRows = await options.query<{ has_sensitive_content: boolean }>(
        `SELECT event ? 'sensitiveContent' AS has_sensitive_content
         FROM audit_outbox
         WHERE id = $1`,
        [queued.id],
      );
      expect(rawRows[0]?.has_sensitive_content).toBe(false);
      expect(await store.listPendingAuditEvents(10)).toHaveLength(1);

      const claim = await store.claimAuditEvent(30_000);
      if (claim === null) throw new Error('missing synthetic audit claim');
      await store.markAuditEventFailed(
        queued.id,
        claim.claimToken,
        'audit_sink_unavailable',
        1,
      );
      await options.query(
        "UPDATE audit_outbox SET available_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [queued.id],
      );
      expect(await store.listPendingAuditEvents(10)).toMatchObject([
        { attempts: 1, lastErrorCode: 'audit_sink_unavailable' },
      ]);

      const retry = await store.claimAuditEvent(30_000);
      if (retry === null) throw new Error('missing synthetic retry claim');
      expect(
        await store.markAuditEventDelivered(queued.id, retry.claimToken),
      ).toBe(true);
      expect(await store.listPendingAuditEvents(10)).toEqual([]);
    });

    it('survives adapter and connection-pool restart', async () => {
      let store = options.getStore();
      await store.openOperation(operation());
      const completed = await store.transitionOperation({
        operationId: operationId('op_synthetic_001'),
        expectedStates: ['RECEIVED'],
        nextState: 'COMPLETED',
        provider: 'notion',
        providerRecordId: providerRecordId('notion_synthetic_001'),
        providerVersion: 'notion-version-synthetic-001',
        resultMetadata: { result: 'synthetic_success' },
        policyVersion: 'policy-v1',
        transitionedAt: new Date('2042-01-02T03:05:05.000Z'),
      });
      await store.createApproval(approval());
      await store.ensureBrainRecordAlias({
        brainRecordId: brainRecordId('brn_synthetic_001'),
        provider: 'notion',
        providerRecordId: providerRecordId('notion_synthetic_001'),
        canonicalLocation: {
          provider: 'notion',
          containerRef: 'notion_root_synthetic',
        },
        createdAt: baseTime,
        updatedAt: baseTime,
      });

      await options.restart();
      store = options.getStore();

      await expect(
        store.getOperation(operationId('op_synthetic_001')),
      ).resolves.toEqual(completed);
      await expect(
        store.openOperation(
          operation({ operationId: operationId('op_after_restart_replay') }),
        ),
      ).resolves.toEqual({
        disposition: 'existing',
        operation: completed,
      });
      await expect(
        store.openOperation(
          operation({
            operationId: operationId('op_after_restart_conflict'),
            requestFingerprint: '9'.repeat(64),
          }),
        ),
      ).rejects.toMatchObject<Partial<DomainError>>({
        code: 'idempotency_conflict',
      });
      await expect(
        store.getApproval(approvalRequestId('apr_synthetic_001')),
      ).resolves.toMatchObject({ status: 'pending' });
      await expect(
        store.findBrainRecordAlias(brainRecordId('brn_synthetic_001')),
      ).resolves.toMatchObject({ provider: 'notion' });
    });
  });
}
