import type {
  ApprovalRequestId,
  OperationId,
  PrincipalId,
  ProviderRecordId,
} from './identifiers.js';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'cancelled'
  | 'superseded'
  | 'impossible';

export type ApprovalResolution = 'approve' | 'decline' | 'cancel';

export interface SafeApprovalSummary {
  readonly requestedByDisplayName: string;
  readonly action: string;
  readonly safeTargetDescription: string;
}

export interface ApprovalRequest {
  readonly id: ApprovalRequestId;
  readonly operationId: OperationId;
  readonly requestedByPrincipalId: PrincipalId;
  readonly familyInboxRecordId?: ProviderRecordId;
  readonly status: ApprovalStatus;
  readonly projectionSyncStatus: 'pending' | 'synced';
  readonly summary: SafeApprovalSummary;
  readonly createdAt: Date;
  readonly resolvedAt?: Date;
  readonly resolvedByPrincipalId?: PrincipalId;
  readonly resolutionReason?: string;
}

export interface ResolveApprovalRequest {
  readonly approvalRequestId: ApprovalRequestId;
  readonly resolution: ApprovalResolution;
  readonly reason?: string;
}

export interface ApprovalListItem {
  readonly approvalRequestId: ApprovalRequestId;
  readonly operationId: OperationId;
  readonly status: ApprovalStatus;
  readonly summary: SafeApprovalSummary;
  readonly createdAt: Date;
}

export interface ListApprovalsResponse {
  readonly approvals: readonly ApprovalListItem[];
}

export interface ResolveApprovalResponse {
  readonly approvalRequestId: ApprovalRequestId;
  readonly operationId: OperationId;
  readonly approvalStatus: Exclude<ApprovalStatus, 'pending'>;
  readonly operationState: import('./operations.js').OperationState;
}
