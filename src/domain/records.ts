import type {
  BrainRecordId,
  PrincipalId,
  ProviderRecordId,
} from './identifiers.js';

export const knowledgeProviderNames = ['notion', 'drive', 'github'] as const;
export type KnowledgeProviderName = (typeof knowledgeProviderNames)[number];

export const brainScopes = [
  'family_shared',
  'parent_and_stewardship',
  'governance',
  'security',
  'legal',
] as const;
export type BrainScope = (typeof brainScopes)[number];

export type Sensitivity =
  'family_shared' | 'parent_and_stewardship' | 'restricted' | 'protected';

export type ProtectedClass =
  'none' | 'protected' | 'legal_hold' | 'governance' | 'security';

export interface CanonicalLocation {
  readonly provider: KnowledgeProviderName;
  readonly containerRef: string;
  readonly displayPath?: string;
}

export interface RecordProvenance {
  readonly provider: KnowledgeProviderName;
  readonly providerRecordId: ProviderRecordId;
  readonly providerVersion?: string;
  readonly creatorPrincipalId?: PrincipalId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly integrityHash?: string;
}

export interface RecordPolicyMetadata {
  readonly scope: BrainScope;
  readonly sensitivity: Sensitivity;
  readonly protectedClass: ProtectedClass;
}

export interface BrainRecordSummary {
  readonly brainRecordId: BrainRecordId;
  readonly title: string;
  readonly excerpt: string;
  readonly canonicalLocation: CanonicalLocation;
  readonly provenance: RecordProvenance;
  readonly policy: RecordPolicyMetadata;
  readonly relevanceScore?: number;
}

export interface BrainRecord extends BrainRecordSummary {
  readonly content: string;
  readonly contentType: string;
}

export type ProviderCompletenessState =
  'complete' | 'partial' | 'unavailable' | 'timed_out';

export interface ProviderCompleteness {
  readonly provider: KnowledgeProviderName;
  readonly state: ProviderCompletenessState;
  readonly errorCode?: 'provider_unavailable' | 'partial_results';
}

export interface SearchCompleteness {
  readonly complete: boolean;
  readonly providers: readonly ProviderCompleteness[];
}
