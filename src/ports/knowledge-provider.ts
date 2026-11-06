import type { OperationId, ProviderRecordId } from '../domain/identifiers.js';
import type {
  ProviderMutationReference,
  UpdateMutation,
} from '../domain/operations.js';
import type {
  BrainRecord,
  BrainRecordSummary,
  BrainScope,
  CanonicalLocation,
  KnowledgeProviderName,
  ProviderCompleteness,
  RecordPolicyMetadata,
} from '../domain/records.js';

/**
 * Server-derived bounds that every adapter must enforce again. Values are
 * provider-native opaque root/repository identifiers, never client authority.
 */
export interface ProviderAccessScope {
  readonly brainScopes: readonly BrainScope[];
  readonly rootRefs: readonly string[];
}

export interface ProviderSearchRequest {
  readonly query: string;
  readonly limit: number;
  readonly access: ProviderAccessScope;
}

export interface ProviderSearchResponse {
  readonly records: readonly BrainRecordSummary[];
  readonly completeness: ProviderCompleteness;
}

export interface ProviderFetchRequest {
  readonly providerRecordId: ProviderRecordId;
  readonly access: ProviderAccessScope;
}

interface RoutedMutation {
  readonly operationId: OperationId;
  readonly access: ProviderAccessScope;
}

export interface RoutedCreate extends RoutedMutation {
  readonly title: string;
  readonly content: string;
  readonly contentType: string;
  readonly canonicalLocation: CanonicalLocation;
  readonly policy: RecordPolicyMetadata;
}

interface RoutedTargetMutation extends RoutedMutation {
  readonly providerRecordId: ProviderRecordId;
  readonly expectedProviderVersion?: string;
}

export interface RoutedUpdate extends RoutedTargetMutation {
  readonly mutation: UpdateMutation;
}

export interface RoutedAppend extends RoutedTargetMutation {
  readonly content: string;
}

/** v1 provider deletion is recoverable trash/archive, never permanent deletion. */
export type RoutedTrash = RoutedTargetMutation;

export type ProviderMutationResult =
  | {
      readonly outcome: 'completed';
      readonly record: ProviderMutationReference;
    }
  | {
      readonly outcome: 'unknown';
      readonly reconciliationKey?: string;
    };

export interface ReconciliationRequest {
  readonly operationId: OperationId;
  readonly operation: 'create' | 'update' | 'append' | 'trash';
  readonly access: ProviderAccessScope;
  readonly providerRecordId?: ProviderRecordId;
  readonly reconciliationKey?: string;
}

export type ReconciliationResult =
  | {
      readonly outcome: 'completed';
      readonly record: ProviderMutationReference;
    }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'inconclusive' };

export interface SearchableKnowledgeProvider {
  readonly provider: KnowledgeProviderName;
  /**
   * `unavailable` marks a provider that cannot serve at all (for example
   * GitHub before its Registry is bound): search reports it unavailable
   * without calling it, rather than complete for lack of surfaces.
   */
  readonly availability?: 'unavailable';
  search(
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ): Promise<ProviderSearchResponse>;
}

export interface FetchableKnowledgeProvider extends SearchableKnowledgeProvider {
  fetch(
    request: ProviderFetchRequest,
    signal: AbortSignal,
  ): Promise<BrainRecord>;
}

export interface MutableKnowledgeProvider extends FetchableKnowledgeProvider {
  readonly provider: Exclude<KnowledgeProviderName, 'github'>;
  create(
    request: RoutedCreate,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult>;
  update(
    request: RoutedUpdate,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult>;
  append(
    request: RoutedAppend,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult>;
  trash(
    request: RoutedTrash,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult>;
  reconcile(
    request: ReconciliationRequest,
    signal: AbortSignal,
  ): Promise<ReconciliationResult>;
}
