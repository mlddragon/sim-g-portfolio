import type {
  ApprovalRequest,
  ApprovalResolution,
} from '../domain/approvals.js';
import type { DomainErrorCode } from '../domain/errors.js';
import type {
  ApprovalRequestId,
  BrainRecordId,
  ElevationChallengeId,
  OperationId,
  PrincipalId,
  ProviderRecordId,
  RequestId,
} from '../domain/identifiers.js';
import type {
  BrainOperationName,
  OperationState,
  SemanticMetadata,
} from '../domain/operations.js';
import type { BrainPrincipal } from '../domain/principal.js';
import type {
  CanonicalLocation,
  KnowledgeProviderName,
} from '../domain/records.js';
import type { AuditEvent } from './audit-sink.js';
import type { GovernanceArtifactKind } from './governance-source.js';

export type OperationalJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly OperationalJsonValue[]
  | { readonly [key: string]: OperationalJsonValue };

export type OperationalJsonObject = Readonly<
  Record<string, OperationalJsonValue>
>;

export interface ExternalIdentityLookup {
  readonly issuer: string;
  readonly externalSubject: string;
}

export interface PrincipalIdentityBinding {
  readonly principal: BrainPrincipal;
  readonly issuer: string;
  readonly externalSubject: string;
  readonly email: string;
  readonly enabled: boolean;
}

export interface CreateOperationRecord {
  readonly operationId: OperationId;
  readonly requestId: RequestId;
  readonly principalId: PrincipalId;
  readonly clientId?: string;
  readonly operation: BrainOperationName;
  readonly requestFingerprint: string;
  readonly semanticMetadata?: SemanticMetadata;
  readonly mutationPayload?: OperationalJsonObject;
  readonly targetBrainRecordId?: BrainRecordId;
  readonly createdAt: Date;
}

export interface StoredOperation extends CreateOperationRecord {
  readonly state: OperationState;
  readonly provider?: KnowledgeProviderName;
  readonly providerRecordId?: ProviderRecordId;
  readonly providerVersion?: string;
  readonly resultMetadata?: OperationalJsonObject;
  readonly errorCode?: DomainErrorCode;
  readonly policyVersion?: string;
  readonly updatedAt: Date;
}

export interface OpenOperationResult {
  readonly disposition: 'created' | 'existing';
  readonly operation: StoredOperation;
}

export interface OperationTransition {
  readonly operationId: OperationId;
  readonly expectedStates: readonly OperationState[];
  readonly nextState: OperationState;
  /**
   * Minimum pending payload, accepted only when moving an append operation
   * that has none into AUTHORIZATION_REQUIRED; any other use fails the
   * compare-and-set. Every transition into COMPLETED, FAILED, CANCELLED or
   * SUPERSEDED clears the stored payload.
   */
  readonly mutationPayload?: OperationalJsonObject;
  readonly provider?: KnowledgeProviderName;
  readonly providerRecordId?: ProviderRecordId;
  readonly providerVersion?: string;
  readonly resultMetadata?: OperationalJsonObject;
  readonly errorCode?: DomainErrorCode;
  readonly policyVersion?: string;
  readonly transitionedAt: Date;
}

/** Correlation, target, versions, outcome and time come from the stored operation. */
export type OperationTransitionAudit = Pick<
  AuditEvent,
  'eventType' | 'reasonCode' | 'integrityHash'
>;

export interface ResolveStoredApproval {
  readonly approvalRequestId: ApprovalRequestId;
  readonly resolution: ApprovalResolution;
  readonly resolvedByPrincipalId: PrincipalId;
  readonly reason?: string;
  readonly resolvedAt: Date;
}

export type ResolvedApprovalStatus = Exclude<
  ApprovalRequest['status'],
  'pending'
>;

export interface ApprovalResolutionTransaction {
  readonly approvalRequestId: ApprovalRequestId;
  readonly status: ResolvedApprovalStatus;
  readonly resolvedByPrincipalId: PrincipalId;
  readonly reason?: string;
  readonly resolvedAt: Date;
  readonly operationTransition: OperationTransition;
  /** The resolver is an independent actor; operation target metadata is loaded by the store. */
  readonly audit: Pick<
    AuditEvent,
    | 'eventType'
    | 'requestId'
    | 'principalId'
    | 'clientId'
    | 'operation'
    | 'reasonCode'
  >;
}

export interface ApprovalResolutionTransactionResult {
  readonly disposition: 'resolved' | 'existing';
  readonly approval: ApprovalRequest;
  readonly operation: StoredOperation;
}

export interface SetApprovalProjectionReference {
  readonly approvalRequestId: ApprovalRequestId;
  readonly familyInboxRecordId: ProviderRecordId;
}

export interface MarkApprovalProjectionSynced {
  readonly approvalRequestId: ApprovalRequestId;
  readonly expectedStatus: ApprovalRequest['status'];
}

export interface StoredElevationChallenge {
  readonly id: ElevationChallengeId;
  readonly operationId: OperationId;
  readonly principalId: PrincipalId;
  readonly confirmationTokenHash: string;
  readonly requestFingerprint: string;
  readonly policyVersion: string;
  readonly frozenTargetIds: readonly BrainRecordId[];
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
  /** Set when a newer challenge was issued for the same operation. */
  readonly supersededAt?: Date;
}

export interface ConsumeElevationChallenge {
  readonly challengeId: ElevationChallengeId;
  readonly operationId: OperationId;
  readonly principalId: PrincipalId;
  readonly confirmationTokenHash: string;
  readonly requestFingerprint: string;
  readonly policyVersion: string;
  readonly frozenTargetIds: readonly BrainRecordId[];
  readonly consumedAt: Date;
}

export interface ElevationConfirmationTransaction {
  readonly consume: ConsumeElevationChallenge;
  /** Must move the same operation from ELEVATION_PENDING to EXECUTING. */
  readonly operationTransition: OperationTransition;
  readonly audit: OperationTransitionAudit;
}

export interface ElevationConfirmationTransactionResult {
  readonly challenge: StoredElevationChallenge;
  readonly operation: StoredOperation;
}

export interface BrainRecordAlias {
  readonly brainRecordId: BrainRecordId;
  readonly provider: KnowledgeProviderName;
  readonly providerRecordId: ProviderRecordId;
  readonly canonicalLocation: CanonicalLocation;
  /**
   * Gateway-recorded creator of a record created through persist_knowledge.
   * Ensuring an alias fills it only when missing and never overwrites it.
   */
  readonly creatorPrincipalId?: PrincipalId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface GovernanceVersionRecord {
  readonly kind: GovernanceArtifactKind;
  readonly version: string;
  readonly contentHash: string;
  readonly sourceReference: string;
  readonly canonicalMarker: string;
  readonly activatedAt: Date;
}

export interface ReconciliationAttempt {
  readonly operationId: OperationId;
  readonly attempt: number;
  readonly outcome: 'completed' | 'not_found' | 'inconclusive' | 'failed';
  readonly safeMetadata?: OperationalJsonObject;
  readonly attemptedAt: Date;
}

export interface AuditOutboxRecord {
  readonly id: string;
  readonly event: AuditEvent;
  readonly attempts: number;
  readonly availableAt: Date;
  readonly deliveredAt?: Date;
  readonly lastErrorCode?: string;
}

export interface ClaimedAuditOutboxRecord extends AuditOutboxRecord {
  /** Fresh for each acquisition; never a caller-supplied worker identity. */
  readonly claimToken: string;
  readonly claimExpiresAt: Date;
}

export type AuditDeliveryErrorCode =
  'audit_sink_unavailable' | 'audit_sink_timeout' | 'audit_delivery_cancelled';

/** Durable machine state only; implementations must not mirror provider content. */
export interface OperationalStateStore {
  findPrincipalByExternalIdentity(
    lookup: ExternalIdentityLookup,
  ): Promise<PrincipalIdentityBinding | null>;
  getPrincipalById(principalId: PrincipalId): Promise<BrainPrincipal | null>;

  openOperation(request: CreateOperationRecord): Promise<OpenOperationResult>;
  getOperation(operationId: OperationId): Promise<StoredOperation | null>;
  transitionOperation(request: OperationTransition): Promise<StoredOperation>;
  /**
   * Commit a compare-and-set transition and its metadata-only event together.
   * expectedStates must exclude nextState; a losing/repeated attempt inserts nothing.
   * Audits the operation initiator, not an independently acting approver.
   * Contains no provider/sink I/O and does not enforce the application transition graph.
   * On uncertain database failure, reload state before retry; never repeat provider I/O.
   */
  transitionOperationWithAudit(
    request: OperationTransition,
    audit: OperationTransitionAudit,
  ): Promise<StoredOperation>;

  createApproval(request: ApprovalRequest): Promise<ApprovalRequest>;
  getApproval(
    approvalRequestId: ApprovalRequestId,
  ): Promise<ApprovalRequest | null>;
  listPendingApprovals(): Promise<readonly ApprovalRequest[]>;
  listApprovalsRequiringProjectionSync(): Promise<readonly ApprovalRequest[]>;
  setApprovalProjectionReference(
    request: SetApprovalProjectionReference,
  ): Promise<ApprovalRequest>;
  markApprovalProjectionSynced(
    request: MarkApprovalProjectionSynced,
  ): Promise<ApprovalRequest>;
  resolveApproval(request: ResolveStoredApproval): Promise<ApprovalRequest>;
  /** Resolve one approval, transition its operation, and enqueue approver audit atomically. */
  resolveApprovalWithOperation(
    request: ApprovalResolutionTransaction,
  ): Promise<ApprovalResolutionTransactionResult>;

  /**
   * Insert one challenge for an operation pending elevation by the same
   * principal, superseding the operation's other live challenges.
   */
  createElevationChallenge(
    challenge: StoredElevationChallenge,
  ): Promise<StoredElevationChallenge>;
  /**
   * Storage primitive only. Application code must use
   * confirmElevationWithOperation so consumption always claims execution.
   */
  consumeElevationChallenge(
    request: ConsumeElevationChallenge,
  ): Promise<StoredElevationChallenge>;
  /**
   * Consume one exact live challenge, claim its pending operation for execution
   * and enqueue the transition audit atomically. Any mismatch changes nothing.
   */
  confirmElevationWithOperation(
    request: ElevationConfirmationTransaction,
  ): Promise<ElevationConfirmationTransactionResult>;
  findConsumedElevationChallenge(
    operationId: OperationId,
  ): Promise<StoredElevationChallenge | null>;

  ensureBrainRecordAlias(alias: BrainRecordAlias): Promise<BrainRecordAlias>;
  findBrainRecordAlias(
    brainRecordId: BrainRecordId,
  ): Promise<BrainRecordAlias | null>;
  findBrainRecordAliasByProvider(
    provider: KnowledgeProviderName,
    providerRecordId: ProviderRecordId,
  ): Promise<BrainRecordAlias | null>;

  recordGovernanceVersion(version: GovernanceVersionRecord): Promise<void>;
  getActiveGovernanceVersion(
    kind: GovernanceArtifactKind,
  ): Promise<GovernanceVersionRecord | null>;

  recordReconciliationAttempt(attempt: ReconciliationAttempt): Promise<void>;
  listReconciliationAttempts(
    operationId: OperationId,
  ): Promise<readonly ReconciliationAttempt[]>;

  enqueueAuditEvent(event: AuditEvent): Promise<AuditOutboxRecord>;
  /** Diagnostic read only, excluding active claims; never authorizes delivery. */
  listPendingAuditEvents(limit: number): Promise<readonly AuditOutboxRecord[]>;
  /** Atomically claim one due event using store time; count every acquisition. */
  claimAuditEvent(
    leaseMilliseconds: number,
  ): Promise<ClaimedAuditOutboxRecord | null>;
  /** False means the claim expired, was replaced, or is already settled. */
  markAuditEventDelivered(id: string, claimToken: string): Promise<boolean>;
  markAuditEventFailed(
    id: string,
    claimToken: string,
    safeErrorCode: AuditDeliveryErrorCode,
    retryDelayMilliseconds: number,
  ): Promise<boolean>;
}
