import type {
  ApprovalRequestId,
  BrainRecordId,
  OperationId,
  PrincipalId,
  ProviderRecordId,
  RequestId,
} from '../domain/identifiers.js';
import type {
  BrainOperationName,
  OperationState,
} from '../domain/operations.js';
import type { KnowledgeProviderName } from '../domain/records.js';

export interface AuditEvent {
  readonly eventType: string;
  readonly requestId: RequestId;
  readonly principalId: PrincipalId;
  readonly clientId?: string;
  readonly operationId?: OperationId;
  readonly operation: BrainOperationName;
  readonly provider?: KnowledgeProviderName;
  readonly brainRecordId?: BrainRecordId;
  readonly providerRecordId?: ProviderRecordId;
  readonly approvalRequestId?: ApprovalRequestId;
  readonly policyVersion?: string;
  readonly providerVersion?: string;
  readonly integrityHash?: string;
  readonly outcome: OperationState | 'DENIED';
  readonly reasonCode?: string;
  readonly timestamp: Date;
}

export interface AuditSink {
  emit(event: AuditEvent, signal: AbortSignal): Promise<void>;
}
