import type { ApprovalRequest } from '../../src/domain/approvals.js';
import { DomainError } from '../../src/domain/errors.js';
import type { ApprovalWorkflowStateStore } from '../../src/application/approval-service.js';
import type {
  ApprovalResolutionTransaction,
  ApprovalResolutionTransactionResult,
} from '../../src/ports/operational-state-store.js';
import { SyntheticMutationStore } from './synthetic-mutation-store.js';

export class SyntheticApprovalStore
  extends SyntheticMutationStore
  implements ApprovalWorkflowStateStore
{
  readonly approvals = new Map<string, ApprovalRequest>();

  createApproval(request: ApprovalRequest): Promise<ApprovalRequest> {
    const byOperation = [...this.approvals.values()].find(
      (candidate) => candidate.operationId === request.operationId,
    );
    const existing = this.approvals.get(request.id) ?? byOperation;
    if (existing !== undefined) {
      if (
        existing.id === request.id &&
        existing.operationId === request.operationId &&
        existing.requestedByPrincipalId === request.requestedByPrincipalId
      ) {
        return Promise.resolve(existing);
      }
      return Promise.reject(
        new DomainError('idempotency_conflict', false, {
          reason: 'approval_identity_conflict',
        }),
      );
    }
    this.approvals.set(request.id, request);
    return Promise.resolve(request);
  }

  getApproval(id: ApprovalRequest['id']): Promise<ApprovalRequest | null> {
    return Promise.resolve(this.approvals.get(id) ?? null);
  }

  listPendingApprovals(): Promise<readonly ApprovalRequest[]> {
    return Promise.resolve(
      [...this.approvals.values()].filter(({ status }) => status === 'pending'),
    );
  }

  listApprovalsRequiringProjectionSync(): Promise<readonly ApprovalRequest[]> {
    return Promise.resolve(
      [...this.approvals.values()].filter(
        ({ projectionSyncStatus }) => projectionSyncStatus === 'pending',
      ),
    );
  }

  setApprovalProjectionReference(request: {
    readonly approvalRequestId: ApprovalRequest['id'];
    readonly familyInboxRecordId: NonNullable<
      ApprovalRequest['familyInboxRecordId']
    >;
  }): Promise<ApprovalRequest> {
    const current = this.approvals.get(request.approvalRequestId);
    if (current === undefined) {
      return Promise.reject(new DomainError('not_found', false));
    }
    if (
      current.familyInboxRecordId !== undefined &&
      current.familyInboxRecordId !== request.familyInboxRecordId
    ) {
      return Promise.reject(new DomainError('idempotency_conflict', false));
    }
    const next = {
      ...current,
      familyInboxRecordId: request.familyInboxRecordId,
      projectionSyncStatus:
        current.status === 'pending'
          ? ('synced' as const)
          : ('pending' as const),
    };
    this.approvals.set(next.id, next);
    return Promise.resolve(next);
  }

  markApprovalProjectionSynced(request: {
    readonly approvalRequestId: ApprovalRequest['id'];
    readonly expectedStatus: ApprovalRequest['status'];
  }): Promise<ApprovalRequest> {
    const current = this.approvals.get(request.approvalRequestId);
    if (current === undefined) {
      return Promise.reject(new DomainError('not_found', false));
    }
    if (current.status !== request.expectedStatus) {
      return Promise.reject(
        new DomainError('invalid_request', false, {
          reason: 'approval_projection_state_changed',
        }),
      );
    }
    const next = { ...current, projectionSyncStatus: 'synced' as const };
    this.approvals.set(next.id, next);
    return Promise.resolve(next);
  }

  resolveApprovalWithOperation(
    request: ApprovalResolutionTransaction,
  ): Promise<ApprovalResolutionTransactionResult> {
    const current = this.approvals.get(request.approvalRequestId);
    if (current === undefined) {
      return Promise.reject(new DomainError('not_found', false));
    }
    if (current.status !== 'pending') {
      if (
        current.status === request.status &&
        current.resolvedByPrincipalId === request.resolvedByPrincipalId &&
        current.resolutionReason === request.reason
      ) {
        return this.getOperation(current.operationId).then((operation) => {
          if (operation === null)
            throw new Error('missing synthetic operation');
          return { disposition: 'existing', approval: current, operation };
        });
      }
      return Promise.reject(
        new DomainError('invalid_request', false, {
          reason: 'approval_not_pending',
        }),
      );
    }
    const approval: ApprovalRequest = {
      ...current,
      status: request.status,
      resolvedByPrincipalId: request.resolvedByPrincipalId,
      ...(request.reason === undefined
        ? {}
        : { resolutionReason: request.reason }),
      resolvedAt: request.resolvedAt,
      projectionSyncStatus: 'pending',
    };
    return this.transitionOperationWithAudit(request.operationTransition, {
      eventType: request.audit.eventType,
      ...(request.audit.reasonCode === undefined
        ? {}
        : { reasonCode: request.audit.reasonCode }),
    }).then((operation) => {
      this.approvals.set(approval.id, approval);
      this.auditEvents.push({
        eventType: request.audit.eventType,
        requestId: request.audit.requestId,
        principalId: request.audit.principalId,
        ...(request.audit.clientId === undefined
          ? {}
          : { clientId: request.audit.clientId }),
        operationId: operation.operationId,
        operation: request.audit.operation,
        ...(operation.provider === undefined
          ? {}
          : { provider: operation.provider }),
        ...(operation.targetBrainRecordId === undefined
          ? {}
          : { brainRecordId: operation.targetBrainRecordId }),
        ...(operation.providerRecordId === undefined
          ? {}
          : { providerRecordId: operation.providerRecordId }),
        approvalRequestId: approval.id,
        ...(operation.policyVersion === undefined
          ? {}
          : { policyVersion: operation.policyVersion }),
        ...(operation.providerVersion === undefined
          ? {}
          : { providerVersion: operation.providerVersion }),
        outcome: operation.state,
        ...(request.audit.reasonCode === undefined
          ? {}
          : { reasonCode: request.audit.reasonCode }),
        timestamp: operation.updatedAt,
      });
      return { disposition: 'resolved', approval, operation };
    });
  }
}
