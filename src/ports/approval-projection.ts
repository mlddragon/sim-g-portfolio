import type {
  ApprovalStatus,
  SafeApprovalSummary,
} from '../domain/approvals.js';
import type {
  ApprovalRequestId,
  OperationId,
  ProviderRecordId,
  RequestId,
} from '../domain/identifiers.js';

export interface CreateApprovalProjectionRequest {
  readonly approvalRequestId: ApprovalRequestId;
  readonly operationId: OperationId;
  readonly requestId: RequestId;
  readonly summary: SafeApprovalSummary;
  readonly status: ApprovalStatus;
}

export interface ApprovalProjectionReference {
  readonly providerRecordId: ProviderRecordId;
}

export type FindApprovalProjectionRequest = Pick<
  CreateApprovalProjectionRequest,
  'approvalRequestId' | 'operationId' | 'requestId'
>;

export interface UpdateApprovalProjectionRequest {
  readonly providerRecordId: ProviderRecordId;
  readonly approvalRequestId: ApprovalRequestId;
  readonly status: ApprovalStatus;
  readonly safeResolutionReason?: string;
}

/** Family Inbox is a safe human projection; PostgreSQL remains authoritative. */
export interface ApprovalProjectionPort {
  /** Find the stable projection before create/retry; multiple matches must fail closed. */
  findByApprovalRequestId(
    request: FindApprovalProjectionRequest,
    signal: AbortSignal,
  ): Promise<ApprovalProjectionReference | null>;
  create(
    request: CreateApprovalProjectionRequest,
    signal: AbortSignal,
  ): Promise<ApprovalProjectionReference>;
  update(
    request: UpdateApprovalProjectionRequest,
    signal: AbortSignal,
  ): Promise<void>;
}
