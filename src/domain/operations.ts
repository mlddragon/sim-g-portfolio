import type {
  BrainRecordId,
  ElevationChallengeId,
  OperationId,
  PrincipalId,
  ProviderRecordId,
  RequestId,
} from './identifiers.js';
import type {
  BrainRecord,
  BrainRecordSummary,
  BrainScope,
  CanonicalLocation,
  KnowledgeProviderName,
  SearchCompleteness,
  Sensitivity,
} from './records.js';

export const brainOperationNames = [
  'search_brain',
  'fetch_record',
  'persist_knowledge',
  'update_record',
  'append_to_record',
  'delete_record',
  'list_approvals',
  'resolve_approval',
] as const;

export type BrainOperationName = (typeof brainOperationNames)[number];
export type MutationOperationName =
  'persist_knowledge' | 'update_record' | 'append_to_record' | 'delete_record';

export interface CanonicalHint {
  readonly provider?: KnowledgeProviderName;
  readonly containerRef?: string;
}

export interface SemanticMetadata {
  readonly subject?: string;
  readonly domain?: string;
  readonly recordType?: string;
  readonly durability?: string;
  readonly sensitivity?: Sensitivity;
  readonly provenance?: string;
  readonly projectReference?: string;
  /** Advisory only. The deterministic router remains authoritative. */
  readonly canonicalHint?: CanonicalHint;
}

export type UpdateMutation =
  | {
      readonly mode: 'patch';
      readonly patch: Readonly<Record<string, unknown>>;
    }
  | {
      readonly mode: 'replace';
      readonly replacement: {
        readonly title?: string;
        readonly content: string;
      };
    };

export type OperationState =
  | 'RECEIVED'
  | 'AUTHORIZATION_REQUIRED'
  | 'APPROVAL_PENDING'
  | 'ELEVATION_PENDING'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'OUTCOME_UNKNOWN'
  | 'CANCELLED'
  | 'SUPERSEDED';

export type AuthorizationDecisionKind =
  'ALLOW' | 'DENY' | 'APPROVAL_REQUIRED' | 'ELEVATION_REQUIRED';

export interface AuthorizationDecision {
  readonly kind: AuthorizationDecisionKind;
  readonly reasonCode: string;
  readonly policyVersion: string;
}

export interface OperationIdentity {
  readonly operationId: OperationId;
  readonly requestId: RequestId;
  readonly principalId: PrincipalId;
  readonly clientId?: string;
}

export interface SearchBrainRequest {
  readonly query: string;
  readonly limit: number;
}

export interface SearchBrainResponse {
  readonly requestId: RequestId;
  readonly results: readonly BrainRecordSummary[];
  readonly completeness: SearchCompleteness;
}

export interface FetchRecordRequest {
  readonly brainRecordId: BrainRecordId;
}

export interface FetchRecordResponse {
  readonly record: BrainRecord;
}

export interface PersistKnowledgeRequest extends OperationIdentity {
  readonly title: string;
  readonly content: string;
  readonly semanticMetadata: SemanticMetadata;
  /** Second call of the elevation flow; never part of the request fingerprint. */
  readonly elevation?: ElevationConfirmation;
}

export interface UpdateRecordRequest extends OperationIdentity {
  readonly brainRecordId: BrainRecordId;
  readonly mutation: UpdateMutation;
  /** Second call of the elevation flow; never part of the request fingerprint. */
  readonly elevation?: ElevationConfirmation;
}

export interface AppendRecordRequest extends OperationIdentity {
  readonly brainRecordId: BrainRecordId;
  readonly content: string;
  /** Second call of the elevation flow; never part of the request fingerprint. */
  readonly elevation?: ElevationConfirmation;
}

export interface ElevationConfirmation {
  readonly challengeId: ElevationChallengeId;
  readonly confirmationToken: string;
}

/** One-time, five-minute challenge returned only to the elevating principal. */
export interface ElevationChallengeGrant {
  readonly challengeId: ElevationChallengeId;
  readonly confirmationToken: string;
  readonly expiresAt: Date;
}

export interface DeleteRecordRequest extends OperationIdentity {
  readonly brainRecordId: BrainRecordId;
  readonly explicitIntent: true;
  readonly elevation?: ElevationConfirmation;
}

export interface ProviderMutationReference {
  readonly provider: KnowledgeProviderName;
  readonly providerRecordId: ProviderRecordId;
  readonly providerVersion?: string;
  readonly canonicalLocation: CanonicalLocation;
  readonly integrityHash?: string;
}

export type ClientOperationState =
  | 'completed'
  | 'failed'
  | 'approval_required'
  | 'elevation_required'
  | 'outcome_unknown';

export interface MutationResponse {
  readonly operationId: OperationId;
  readonly state: ClientOperationState;
  /** Stable gateway alias of a created record; clients never parse provider IDs. */
  readonly brainRecordId?: BrainRecordId;
  readonly record?: ProviderMutationReference;
  readonly elevation?: ElevationChallengeGrant;
}

export interface TargetAuthorizationFacts {
  readonly scope: BrainScope;
  readonly creatorPrincipalId?: PrincipalId;
  readonly createdAt: Date;
  readonly protectedClass:
    'none' | 'protected' | 'legal_hold' | 'governance' | 'security';
  readonly providerVersion?: string;
}
