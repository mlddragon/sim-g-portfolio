import { createHash } from 'node:crypto';

import type { AuthorizationEngine } from '../domain/authorization/authorization-engine.js';
import type {
  ApprovalRequest,
  ApprovalStatus,
  ListApprovalsResponse,
  ResolveApprovalRequest,
  ResolveApprovalResponse,
} from '../domain/approvals.js';
import { DomainError } from '../domain/errors.js';
import { approvalRequestId } from '../domain/identifiers.js';
import type { StoredOperation } from '../ports/operational-state-store.js';
import type {
  BrainPrincipal,
  AuthenticatedPrincipal,
} from '../domain/principal.js';
import type { RequestContext } from '../domain/request-context.js';
import type { ApprovalProjectionPort } from '../ports/approval-projection.js';
import type { Clock } from '../ports/clock.js';
import type { MutationResponse } from '../domain/operations.js';
import type { OperationalStateStore } from '../ports/operational-state-store.js';
import type { TelemetrySink } from '../ports/telemetry-sink.js';
import {
  assertActive,
  assertAuthenticated,
  enqueueReadAudit,
  observeTelemetry,
} from './brain-read-support.js';

export type ApprovalWorkflowStateStore = Pick<
  OperationalStateStore,
  | 'createApproval'
  | 'getApproval'
  | 'listPendingApprovals'
  | 'listApprovalsRequiringProjectionSync'
  | 'setApprovalProjectionReference'
  | 'markApprovalProjectionSynced'
  | 'getOperation'
  | 'getPrincipalById'
  | 'transitionOperationWithAudit'
  | 'resolveApprovalWithOperation'
  | 'enqueueAuditEvent'
>;

export interface ApprovedUpdateExecutor {
  resumeApprovedUpdate(
    operation: StoredOperation,
    originalPrincipal: BrainPrincipal,
    beforeDispatch: (operation: StoredOperation) => Promise<{
      readonly disposition: 'resolved' | 'existing';
      readonly operation: StoredOperation;
    }>,
    signal: AbortSignal,
  ): Promise<MutationResponse>;
  reconcileApprovedUpdate(
    operation: StoredOperation,
    originalPrincipal: BrainPrincipal,
    signal: AbortSignal,
  ): Promise<MutationResponse>;
  recoverApprovedUpdate(
    operation: StoredOperation,
    originalPrincipal: BrainPrincipal,
    signal: AbortSignal,
  ): Promise<MutationResponse>;
}

function stableApprovalId(operation: StoredOperation) {
  return approvalRequestId(
    `apr_${createHash('sha256').update(operation.operationId, 'utf8').digest('hex')}`,
  );
}

function unauthorized(reason: string): DomainError {
  return new DomainError('unauthorized', false, { reason });
}

function resolvedStatus(
  resolution: ResolveApprovalRequest['resolution'],
): Exclude<ApprovalStatus, 'pending'> {
  return resolution === 'approve'
    ? 'approved'
    : resolution === 'decline'
      ? 'declined'
      : 'cancelled';
}

function normalizeResolveRequest(value: unknown): ResolveApprovalRequest {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new DomainError('invalid_request', false, {
      reason: 'invalid_approval_resolution',
    });
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !['approvalRequestId', 'resolution', 'reason'].includes(key),
    )
  ) {
    throw new DomainError('invalid_request', false, {
      reason: 'invalid_approval_resolution',
    });
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new DomainError('invalid_request', false, {
        reason: 'invalid_approval_resolution',
      });
    }
    record[key] = descriptor.value;
  }
  const id = record['approvalRequestId'];
  const resolution = record['resolution'];
  const reason = record['reason'];
  if (
    typeof id !== 'string' ||
    typeof resolution !== 'string' ||
    !['approve', 'decline', 'cancel'].includes(resolution) ||
    (reason !== undefined &&
      (typeof reason !== 'string' ||
        reason.length === 0 ||
        // NUL and lone surrogates cannot be stored in PostgreSQL text.
        reason.includes('\u0000') ||
        !reason.isWellFormed() ||
        reason.length > 1_000 ||
        reason.trim() !== reason))
  ) {
    throw new DomainError('invalid_request', false, {
      reason: 'invalid_approval_resolution',
    });
  }
  return {
    approvalRequestId: approvalRequestId(id),
    resolution: resolution as ResolveApprovalRequest['resolution'],
    ...(reason === undefined ? {} : { reason }),
  };
}

function safeResolutionReason(status: Exclude<ApprovalStatus, 'pending'>) {
  return status === 'approved'
    ? 'Approved by a parent steward.'
    : status === 'declined'
      ? 'Declined by a parent steward.'
      : status === 'cancelled'
        ? 'Cancelled by a parent steward.'
        : status === 'superseded'
          ? 'The target or policy changed while approval was pending.'
          : 'The requested operation can no longer be completed.';
}

/** Operations whose approved execution the mutation service can resume. */
const approvableOperations = new Set<StoredOperation['operation']>([
  'update_record',
  'append_to_record',
  'delete_record',
]);

function approvalAction(operation: StoredOperation['operation']): string {
  switch (operation) {
    case 'delete_record':
      return 'Move one Family Shared record to trash';
    case 'append_to_record':
      return 'Append to one Family Shared record';
    default:
      return 'Update one Family Shared record';
  }
}

function safeSummary(principal: BrainPrincipal, operation: StoredOperation) {
  return {
    requestedByDisplayName: principal.displayName,
    action: approvalAction(operation.operation),
    safeTargetDescription: `Gateway record ${operation.targetBrainRecordId ?? 'unknown'}`,
  };
}

/** Creates the authoritative request before attempting its Family Inbox projection. */
export class ApprovalRequestCoordinator {
  constructor(
    private readonly store: ApprovalWorkflowStateStore,
    private readonly projection: ApprovalProjectionPort,
    private readonly clock: Clock,
    private readonly telemetry?: TelemetrySink,
  ) {}

  async ensurePending(
    principal: BrainPrincipal,
    operation: StoredOperation,
    signal: AbortSignal,
  ): Promise<ApprovalRequest> {
    assertActive(signal);
    if (
      !approvableOperations.has(operation.operation) ||
      (operation.state !== 'AUTHORIZATION_REQUIRED' &&
        operation.state !== 'APPROVAL_PENDING') ||
      operation.principalId !== principal.id
    ) {
      throw new DomainError('invalid_request', false, {
        reason: 'invalid_approval_operation',
      });
    }
    const id = stableApprovalId(operation);
    let approval = await approvalStateRead(() =>
      this.store.createApproval({
        id,
        operationId: operation.operationId,
        requestedByPrincipalId: principal.id,
        status: 'pending',
        projectionSyncStatus: 'pending',
        summary: safeSummary(principal, operation),
        createdAt: operation.createdAt,
      }),
    );
    if (operation.state === 'AUTHORIZATION_REQUIRED') {
      try {
        operation = await this.store.transitionOperationWithAudit(
          {
            operationId: operation.operationId,
            expectedStates: ['AUTHORIZATION_REQUIRED'],
            nextState: 'APPROVAL_PENDING',
            transitionedAt: this.clock.now(),
          },
          {
            eventType: 'brain.approval.created',
            reasonCode: 'approval_request_persisted',
          },
        );
      } catch (error) {
        // As in MutationService.transition: a failed reload keeps the
        // original error.
        let reloaded: StoredOperation | null;
        try {
          reloaded = await this.store.getOperation(operation.operationId);
        } catch {
          throw error;
        }
        if (reloaded?.state !== 'APPROVAL_PENDING') throw error;
        operation = reloaded;
      }
    }
    if (approval.familyInboxRecordId !== undefined) return approval;

    try {
      const existing = await this.projection.findByApprovalRequestId(
        {
          approvalRequestId: approval.id,
          operationId: approval.operationId,
          requestId: operation.requestId,
        },
        signal,
      );
      const reference =
        existing ??
        (await this.projection.create(
          {
            approvalRequestId: approval.id,
            operationId: approval.operationId,
            requestId: operation.requestId,
            summary: approval.summary,
            status: approval.status,
          },
          signal,
        ));
      approval = await this.store.setApprovalProjectionReference({
        approvalRequestId: approval.id,
        familyInboxRecordId: reference.providerRecordId,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      observeTelemetry(this.telemetry, {
        kind: 'counter',
        name: 'error.total',
        value: 1,
        tags: { operation: 'approval_projection_create' },
      });
    }
    return approval;
  }
}

/**
 * Reads approval state after an approved change may already have run: retry
 * the same resolution to read its outcome. Never internal.
 */
async function resolutionStateRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('provider_unavailable', true, {
      reason: 'approval_resolution_state_unavailable',
    });
  }
}

/** Reads approval state; a dropped connection is retryable, never internal. */
async function approvalStateRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('provider_unavailable', true, {
      reason: 'approval_state_unavailable',
    });
  }
}

/** Parent-facing semantic approval operations; Notion never initiates execution. */
export class ApprovalService {
  constructor(
    private readonly authorization: AuthorizationEngine,
    private readonly store: ApprovalWorkflowStateStore,
    private readonly projection: ApprovalProjectionPort,
    private readonly updates: ApprovedUpdateExecutor,
    private readonly clock: Clock,
    private readonly telemetry?: TelemetrySink,
  ) {}

  async listApprovals(
    authenticated: AuthenticatedPrincipal,
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<ListApprovalsResponse> {
    assertAuthenticated(authenticated);
    assertActive(signal);
    const decision = this.authorization.evaluate({
      principal: authenticated.principal,
      operation: 'list_approvals',
    });
    if (decision.kind !== 'ALLOW') throw unauthorized(decision.reasonCode);
    const approvals = await approvalStateRead(() =>
      this.store.listPendingApprovals(),
    );
    assertActive(signal);
    const observedAt = this.clock.now();
    await enqueueReadAudit(this.store, {
      eventType: 'brain.approval.listed',
      requestId: context.requestId,
      principalId: authenticated.principal.id,
      ...(context.clientId === undefined ? {} : { clientId: context.clientId }),
      operation: 'list_approvals',
      policyVersion: decision.policyVersion,
      outcome: 'COMPLETED',
      reasonCode: decision.reasonCode,
      timestamp: observedAt,
    });
    observeTelemetry(this.telemetry, {
      kind: 'gauge',
      name: 'approval.pending_count',
      value: approvals.length,
    });
    observeTelemetry(this.telemetry, {
      kind: 'gauge',
      name: 'approval.oldest_age',
      value:
        approvals.length === 0
          ? 0
          : Math.max(
              0,
              ...approvals.map(
                ({ createdAt }) => observedAt.getTime() - createdAt.getTime(),
              ),
            ),
      tags: { unit: 'milliseconds' },
    });
    return {
      approvals: approvals.map((approval) => ({
        approvalRequestId: approval.id,
        operationId: approval.operationId,
        status: approval.status,
        summary: approval.summary,
        createdAt: approval.createdAt,
      })),
    };
  }

  async resolveApproval(
    authenticated: AuthenticatedPrincipal,
    context: RequestContext,
    request: ResolveApprovalRequest,
    signal: AbortSignal,
  ): Promise<ResolveApprovalResponse> {
    assertAuthenticated(authenticated);
    assertActive(signal);
    request = normalizeResolveRequest(request);
    const decision = this.authorization.evaluate({
      principal: authenticated.principal,
      operation: 'resolve_approval',
    });
    if (decision.kind !== 'ALLOW') throw unauthorized(decision.reasonCode);
    const wantedStatus = resolvedStatus(request.resolution);
    const approval = await approvalStateRead(() =>
      this.store.getApproval(request.approvalRequestId),
    );
    if (approval === null) {
      throw new DomainError('not_found', false, {
        resource: 'approval_request',
      });
    }
    const operation = await approvalStateRead(() =>
      this.store.getOperation(approval.operationId),
    );
    if (operation === null || !approvableOperations.has(operation.operation)) {
      throw new DomainError('invalid_request', false, {
        reason: 'approval_operation_invalid',
      });
    }
    if (approval.status !== 'pending') {
      // An approve can durably end impossible or superseded; the same
      // resolver's retry must replay that outcome, not report a failure.
      const replayable =
        approval.status === wantedStatus ||
        (wantedStatus === 'approved' &&
          (approval.status === 'impossible' ||
            approval.status === 'superseded'));
      if (
        !replayable ||
        approval.resolvedByPrincipalId !== authenticated.principal.id
      ) {
        throw new DomainError('invalid_request', false, {
          reason: 'approval_not_pending',
        });
      }
      let currentOperation = operation;
      if (
        approval.status === 'approved' &&
        operation.state === 'OUTCOME_UNKNOWN'
      ) {
        const original = await approvalStateRead(() =>
          this.store.getPrincipalById(approval.requestedByPrincipalId),
        );
        if (original !== null && original.status === 'active') {
          await this.updates.reconcileApprovedUpdate(
            operation,
            original,
            signal,
          );
          currentOperation =
            (await resolutionStateRead(() =>
              this.store.getOperation(operation.operationId),
            )) ?? operation;
        }
      } else if (
        approval.status === 'approved' &&
        operation.state === 'EXECUTING'
      ) {
        const original = await approvalStateRead(() =>
          this.store.getPrincipalById(approval.requestedByPrincipalId),
        );
        if (original !== null && original.status === 'active') {
          await this.updates.recoverApprovedUpdate(operation, original, signal);
          currentOperation =
            (await resolutionStateRead(() =>
              this.store.getOperation(operation.operationId),
            )) ?? operation;
        }
      }
      await this.updateProjection(approval, signal);
      return this.response(approval, currentOperation);
    }
    if (operation.state !== 'APPROVAL_PENDING') {
      throw new DomainError('invalid_request', false, {
        reason: 'approval_operation_not_pending',
      });
    }

    if (request.resolution !== 'approve') {
      const resolved = await this.resolveState(
        authenticated,
        context,
        approval,
        operation,
        wantedStatus,
        request.resolution === 'cancel' ? 'CANCELLED' : 'FAILED',
        decision.policyVersion,
      );
      await this.updateProjection(resolved.approval, signal);
      return this.response(resolved.approval, resolved.operation);
    }

    const originalPrincipal = await approvalStateRead(() =>
      this.store.getPrincipalById(approval.requestedByPrincipalId),
    );
    if (originalPrincipal === null || originalPrincipal.status !== 'active') {
      const impossible = await this.resolveState(
        authenticated,
        context,
        approval,
        operation,
        'impossible',
        'FAILED',
        decision.policyVersion,
      );
      await this.updateProjection(impossible.approval, signal);
      return this.response(impossible.approval, impossible.operation);
    }

    try {
      const mutation = await this.updates.resumeApprovedUpdate(
        operation,
        originalPrincipal,
        async (validated) => {
          const result = await this.resolveState(
            authenticated,
            context,
            approval,
            validated,
            'approved',
            'EXECUTING',
            decision.policyVersion,
          );
          return {
            disposition: result.disposition,
            operation: result.operation,
          };
        },
        signal,
      );
      const resolved = await resolutionStateRead(() =>
        this.store.getApproval(approval.id),
      );
      if (resolved === null || resolved.status === 'pending') {
        throw new DomainError('provider_unavailable', true, {
          reason: 'approval_resolution_state_unavailable',
        });
      }
      await this.updateProjection(resolved, signal);
      const finalOperation = await resolutionStateRead(() =>
        this.store.getOperation(operation.operationId),
      );
      if (finalOperation === null) {
        throw new DomainError('provider_unavailable', true, {
          reason: 'approval_operation_state_unavailable',
        });
      }
      return {
        ...this.response(resolved, finalOperation),
        operationState:
          mutation.state === 'completed' ? 'COMPLETED' : finalOperation.state,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      const invalidating =
        error instanceof DomainError &&
        [
          'not_found',
          'unauthorized',
          'protected_record',
          // A stored change that no longer validates can never execute.
          'invalid_request',
          'idempotency_conflict',
        ].includes(error.code);
      let durableApproval: Awaited<ReturnType<typeof this.store.getApproval>>;
      try {
        durableApproval = await this.store.getApproval(approval.id);
      } catch {
        // An error that would settle the approval cannot be acted on without
        // its state: report a retryable outage instead of leaving it pending
        // behind a final-looking answer. Anything else keeps the original.
        if (invalidating) {
          throw new DomainError('provider_unavailable', true, {
            reason: 'approval_state_unavailable',
          });
        }
        throw error;
      }
      if (durableApproval?.status !== 'pending') throw error;
      if (!invalidating) throw error;
      const invalidated = await this.resolveState(
        authenticated,
        context,
        approval,
        operation,
        error instanceof DomainError && error.code === 'not_found'
          ? 'superseded'
          : 'impossible',
        error instanceof DomainError && error.code === 'not_found'
          ? 'SUPERSEDED'
          : 'FAILED',
        decision.policyVersion,
      );
      await this.updateProjection(invalidated.approval, signal);
      return this.response(invalidated.approval, invalidated.operation);
    }
  }

  private resolveState(
    authenticated: AuthenticatedPrincipal,
    context: RequestContext,
    approval: ApprovalRequest,
    operation: StoredOperation,
    status: Exclude<ApprovalStatus, 'pending'>,
    operationState: StoredOperation['state'],
    policyVersion: string,
  ) {
    return this.store.resolveApprovalWithOperation({
      approvalRequestId: approval.id,
      status,
      resolvedByPrincipalId: authenticated.principal.id,
      reason: safeResolutionReason(status),
      resolvedAt: this.clock.now(),
      operationTransition: {
        operationId: operation.operationId,
        expectedStates: ['APPROVAL_PENDING'],
        nextState: operationState,
        ...(operation.provider === undefined
          ? {}
          : { provider: operation.provider }),
        ...(operation.providerRecordId === undefined
          ? {}
          : { providerRecordId: operation.providerRecordId }),
        ...(operation.providerVersion === undefined
          ? {}
          : { providerVersion: operation.providerVersion }),
        policyVersion,
        transitionedAt: this.clock.now(),
      },
      audit: {
        eventType: 'brain.approval.resolved',
        requestId: context.requestId,
        principalId: authenticated.principal.id,
        ...(context.clientId === undefined
          ? {}
          : { clientId: context.clientId }),
        operation: 'resolve_approval',
        reasonCode: `approval_${status}`,
      },
    });
  }

  private async updateProjection(
    approval: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      approval.familyInboxRecordId === undefined ||
      approval.status === 'pending'
    ) {
      return;
    }
    try {
      await this.projection.update(
        {
          providerRecordId: approval.familyInboxRecordId,
          approvalRequestId: approval.id,
          status: approval.status,
          safeResolutionReason: safeResolutionReason(approval.status),
        },
        signal,
      );
      await this.store.markApprovalProjectionSynced({
        approvalRequestId: approval.id,
        expectedStatus: approval.status,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError')
        throw error;
      observeTelemetry(this.telemetry, {
        kind: 'counter',
        name: 'error.total',
        value: 1,
        tags: { operation: 'approval_projection_update' },
      });
    }
  }

  private response(
    approval: ApprovalRequest,
    operation: StoredOperation,
  ): ResolveApprovalResponse {
    if (approval.status === 'pending') {
      throw new DomainError('internal_error', false, {
        reason: 'approval_resolution_incomplete',
      });
    }
    return {
      approvalRequestId: approval.id,
      operationId: operation.operationId,
      approvalStatus: approval.status,
      operationState: operation.state,
    };
  }
}
