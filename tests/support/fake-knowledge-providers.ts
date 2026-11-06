import {
  brainRecordId,
  providerRecordId,
  type OperationId,
  type ProviderRecordId,
} from '../../src/domain/identifiers.js';
import type {
  ProviderMutationReference,
  UpdateMutation,
} from '../../src/domain/operations.js';
import {
  brainScopes,
  knowledgeProviderNames,
  type BrainRecord,
  type BrainRecordSummary,
  type BrainScope,
  type CanonicalLocation,
  type KnowledgeProviderName,
  type RecordPolicyMetadata,
  type RecordProvenance,
} from '../../src/domain/records.js';
import { DomainError } from '../../src/domain/errors.js';
import type {
  FetchableKnowledgeProvider,
  MutableKnowledgeProvider,
  ProviderAccessScope,
  ProviderFetchRequest,
  ProviderMutationResult,
  ProviderSearchRequest,
  ProviderSearchResponse,
  ReconciliationRequest,
  ReconciliationResult,
  RoutedAppend,
  RoutedCreate,
  RoutedTrash,
  RoutedUpdate,
} from '../../src/ports/knowledge-provider.js';

export interface FakeKnowledgeProviderOptions {
  readonly configuredAccess: ProviderAccessScope;
  readonly now?: () => Date;
  readonly unknownOperationIds?: readonly OperationId[];
}

type MutableProviderName = Exclude<KnowledgeProviderName, 'github'>;
type MutationKind = ReconciliationRequest['operation'];

interface RecordedMutation {
  readonly kind: MutationKind;
  readonly reference: ProviderMutationReference;
  readonly scope: BrainScope;
  readonly reconciliationKey: string;
  readonly uncertain: boolean;
}

const validProviders = new Set<KnowledgeProviderName>(knowledgeProviderNames);
const validBrainScopes = new Set<BrainScope>(brainScopes);

function isBrainScope(value: unknown): value is BrainScope {
  return typeof value === 'string' && validBrainScopes.has(value as BrainScope);
}

function isBrainScopeArray(value: unknown): value is readonly BrainScope[] {
  return Array.isArray(value) && value.every(isBrainScope);
}

function isRootRefArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (rootRef: unknown) =>
        typeof rootRef === 'string' &&
        rootRef.length > 0 &&
        rootRef.trim() === rootRef,
    )
  );
}

function cancelled(): DOMException {
  return new DOMException('Provider operation cancelled', 'AbortError');
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}

function invalidConfiguration(): TypeError {
  return new TypeError('invalid_fake_knowledge_provider_configuration');
}

function invalidRequest(reason: string): DomainError {
  return new DomainError('invalid_request', false, { reason });
}

function scopeRejected(): DomainError {
  return new DomainError('unauthorized', false, {
    reason: 'provider_scope_rejected',
  });
}

function recordNotFound(): DomainError {
  return new DomainError('not_found', false, { reason: 'record_not_found' });
}

function versionConflict(): DomainError {
  return new DomainError('idempotency_conflict', false, {
    reason: 'provider_version_mismatch',
  });
}

function cloneCanonicalLocation(
  location: CanonicalLocation,
): CanonicalLocation {
  return {
    provider: location.provider,
    containerRef: location.containerRef,
    ...(location.displayPath === undefined
      ? {}
      : { displayPath: location.displayPath }),
  };
}

function cloneProvenance(provenance: RecordProvenance): RecordProvenance {
  return {
    provider: provenance.provider,
    providerRecordId: provenance.providerRecordId,
    ...(provenance.providerVersion === undefined
      ? {}
      : { providerVersion: provenance.providerVersion }),
    ...(provenance.creatorPrincipalId === undefined
      ? {}
      : { creatorPrincipalId: provenance.creatorPrincipalId }),
    createdAt: new Date(provenance.createdAt.getTime()),
    updatedAt: new Date(provenance.updatedAt.getTime()),
    ...(provenance.integrityHash === undefined
      ? {}
      : { integrityHash: provenance.integrityHash }),
  };
}

function clonePolicy(policy: RecordPolicyMetadata): RecordPolicyMetadata {
  return {
    scope: policy.scope,
    sensitivity: policy.sensitivity,
    protectedClass: policy.protectedClass,
  };
}

function cloneRecord(record: BrainRecord): BrainRecord {
  return {
    brainRecordId: record.brainRecordId,
    title: record.title,
    excerpt: record.excerpt,
    content: record.content,
    contentType: record.contentType,
    canonicalLocation: cloneCanonicalLocation(record.canonicalLocation),
    provenance: cloneProvenance(record.provenance),
    policy: clonePolicy(record.policy),
    ...(record.relevanceScore === undefined
      ? {}
      : { relevanceScore: record.relevanceScore }),
  };
}

function summarize(record: BrainRecord): BrainRecordSummary {
  return {
    brainRecordId: record.brainRecordId,
    title: record.title,
    excerpt: record.excerpt,
    canonicalLocation: cloneCanonicalLocation(record.canonicalLocation),
    provenance: cloneProvenance(record.provenance),
    policy: clonePolicy(record.policy),
    ...(record.relevanceScore === undefined
      ? {}
      : { relevanceScore: record.relevanceScore }),
  };
}

function cloneReference(
  reference: ProviderMutationReference,
): ProviderMutationReference {
  return {
    provider: reference.provider,
    providerRecordId: reference.providerRecordId,
    ...(reference.providerVersion === undefined
      ? {}
      : { providerVersion: reference.providerVersion }),
    canonicalLocation: cloneCanonicalLocation(reference.canonicalLocation),
    ...(reference.integrityHash === undefined
      ? {}
      : { integrityHash: reference.integrityHash }),
  };
}

function recordReference(record: BrainRecord): ProviderMutationReference {
  return {
    provider: record.provenance.provider,
    providerRecordId: record.provenance.providerRecordId,
    ...(record.provenance.providerVersion === undefined
      ? {}
      : { providerVersion: record.provenance.providerVersion }),
    canonicalLocation: cloneCanonicalLocation(record.canonicalLocation),
    ...(record.provenance.integrityHash === undefined
      ? {}
      : { integrityHash: record.provenance.integrityHash }),
  };
}

function excerpt(content: string): string {
  return content.slice(0, 160);
}

class FakeKnowledgeStore {
  readonly #provider: KnowledgeProviderName;
  readonly #configuredBrainScopes: ReadonlySet<BrainScope>;
  readonly #configuredRootRefs: ReadonlySet<string>;
  readonly #records = new Map<string, BrainRecord>();
  readonly #mutations = new Map<string, RecordedMutation>();
  readonly #unknownOperationIds: ReadonlySet<string>;
  readonly #now: () => Date;

  constructor(
    provider: KnowledgeProviderName,
    records: readonly BrainRecord[],
    options: FakeKnowledgeProviderOptions,
  ) {
    if (!validProviders.has(provider)) throw invalidConfiguration();
    if (
      !isBrainScopeArray(options.configuredAccess.brainScopes) ||
      !isRootRefArray(options.configuredAccess.rootRefs)
    ) {
      throw invalidConfiguration();
    }

    this.#provider = provider;
    this.#configuredBrainScopes = new Set(options.configuredAccess.brainScopes);
    this.#configuredRootRefs = new Set(options.configuredAccess.rootRefs);
    this.#unknownOperationIds = new Set(
      (options.unknownOperationIds ?? []).map(String),
    );
    this.#now = options.now ?? (() => new Date());

    for (const candidate of records) {
      if (
        candidate.provenance.provider !== provider ||
        candidate.canonicalLocation.provider !== provider ||
        !Number.isFinite(candidate.provenance.createdAt.getTime()) ||
        !Number.isFinite(candidate.provenance.updatedAt.getTime()) ||
        this.#records.has(candidate.provenance.providerRecordId)
      ) {
        throw invalidConfiguration();
      }
      this.#records.set(
        candidate.provenance.providerRecordId,
        cloneRecord(candidate),
      );
    }
  }

  async search(
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ): Promise<ProviderSearchResponse> {
    await Promise.resolve();
    assertActive(signal);
    this.assertAccess(request.access);
    if (
      typeof request.query !== 'string' ||
      request.query.trim().length === 0 ||
      !Number.isInteger(request.limit) ||
      request.limit < 1
    ) {
      throw invalidRequest('invalid_provider_search_request');
    }

    const query = request.query.toLocaleLowerCase();
    const records = [...this.#records.values()]
      .filter((record) => this.isVisible(record, request.access))
      .filter((record) =>
        [record.title, record.excerpt, record.content]
          .join('\n')
          .toLocaleLowerCase()
          .includes(query),
      )
      .slice(0, request.limit)
      .map(summarize);

    assertActive(signal);
    return {
      records,
      completeness: { provider: this.#provider, state: 'complete' },
    };
  }

  async fetch(
    request: ProviderFetchRequest,
    signal: AbortSignal,
  ): Promise<BrainRecord> {
    await Promise.resolve();
    assertActive(signal);
    this.assertAccess(request.access);
    const record = this.#records.get(request.providerRecordId);
    if (record === undefined || !this.isVisible(record, request.access)) {
      throw recordNotFound();
    }
    assertActive(signal);
    return cloneRecord(record);
  }

  async create(
    request: RoutedCreate,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    await Promise.resolve();
    assertActive(signal);
    this.assertAccess(request.access);
    this.rejectRepeatedMutation(request.operationId);
    if (
      request.canonicalLocation.provider !== this.#provider ||
      !request.access.rootRefs.includes(
        request.canonicalLocation.containerRef,
      ) ||
      !this.#configuredRootRefs.has(request.canonicalLocation.containerRef) ||
      !request.access.brainScopes.includes(request.policy.scope) ||
      !this.#configuredBrainScopes.has(request.policy.scope) ||
      typeof request.title !== 'string' ||
      request.title.length === 0 ||
      typeof request.content !== 'string' ||
      typeof request.contentType !== 'string' ||
      request.contentType.length === 0
    ) {
      throw invalidRequest('invalid_routed_create');
    }

    const timestamp = this.currentTime();
    const version = this.version(request.operationId);
    const record: BrainRecord = {
      brainRecordId: brainRecordId(
        `brn_fake_${this.#provider}_${String(request.operationId)}`,
      ),
      title: request.title,
      excerpt: excerpt(request.content),
      content: request.content,
      contentType: request.contentType,
      canonicalLocation: cloneCanonicalLocation(request.canonicalLocation),
      provenance: {
        provider: this.#provider,
        providerRecordId: providerRecordId(
          `fake_${this.#provider}_${String(request.operationId)}`,
        ),
        providerVersion: version,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      policy: clonePolicy(request.policy),
    };
    this.#records.set(record.provenance.providerRecordId, record);
    assertActive(signal);
    return this.recordMutation(request.operationId, 'create', record);
  }

  async update(
    request: RoutedUpdate,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    await Promise.resolve();
    assertActive(signal);
    this.assertAccess(request.access);
    this.rejectRepeatedMutation(request.operationId);
    const current = this.targetRecord(
      request.providerRecordId,
      request.access,
      request.expectedProviderVersion,
    );
    const updated = this.applyUpdate(
      current,
      request.mutation,
      request.operationId,
    );
    this.#records.set(request.providerRecordId, updated);
    assertActive(signal);
    return this.recordMutation(request.operationId, 'update', updated);
  }

  async append(
    request: RoutedAppend,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    await Promise.resolve();
    assertActive(signal);
    this.assertAccess(request.access);
    this.rejectRepeatedMutation(request.operationId);
    if (typeof request.content !== 'string' || request.content.length === 0) {
      throw invalidRequest('invalid_routed_append');
    }
    const current = this.targetRecord(
      request.providerRecordId,
      request.access,
      request.expectedProviderVersion,
    );
    const content = `${current.content}${request.content}`;
    const updated = this.nextRecord(current, request.operationId, {
      content,
      excerpt: excerpt(content),
    });
    this.#records.set(request.providerRecordId, updated);
    assertActive(signal);
    return this.recordMutation(request.operationId, 'append', updated);
  }

  async trash(
    request: RoutedTrash,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    await Promise.resolve();
    assertActive(signal);
    this.assertAccess(request.access);
    this.rejectRepeatedMutation(request.operationId);
    const current = this.targetRecord(
      request.providerRecordId,
      request.access,
      request.expectedProviderVersion,
    );
    const trashed = this.nextRecord(current, request.operationId);
    const result = this.recordMutation(request.operationId, 'trash', trashed);
    this.#records.delete(request.providerRecordId);
    assertActive(signal);
    return result;
  }

  async reconcile(
    request: ReconciliationRequest,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    await Promise.resolve();
    assertActive(signal);
    this.assertAccess(request.access);
    const recorded = this.#mutations.get(request.operationId);
    if (recorded === undefined) return { outcome: 'not_found' };
    if (
      recorded.kind !== request.operation ||
      (request.providerRecordId !== undefined &&
        request.providerRecordId !== recorded.reference.providerRecordId) ||
      (request.reconciliationKey !== undefined &&
        request.reconciliationKey !== recorded.reconciliationKey)
    ) {
      return { outcome: 'inconclusive' };
    }
    if (
      !request.access.brainScopes.includes(recorded.scope) ||
      !request.access.rootRefs.includes(
        recorded.reference.canonicalLocation.containerRef,
      )
    ) {
      return { outcome: 'not_found' };
    }
    assertActive(signal);
    return { outcome: 'completed', record: cloneReference(recorded.reference) };
  }

  private assertAccess(access: ProviderAccessScope): void {
    if (
      !isBrainScopeArray(access.brainScopes) ||
      !isRootRefArray(access.rootRefs) ||
      access.brainScopes.some(
        (scope) => !this.#configuredBrainScopes.has(scope),
      ) ||
      access.rootRefs.some((rootRef) => !this.#configuredRootRefs.has(rootRef))
    ) {
      throw scopeRejected();
    }
  }

  private isVisible(record: BrainRecord, access: ProviderAccessScope): boolean {
    return (
      access.brainScopes.includes(record.policy.scope) &&
      access.rootRefs.includes(record.canonicalLocation.containerRef)
    );
  }

  private targetRecord(
    providerRecordId: ProviderRecordId,
    access: ProviderAccessScope,
    expectedProviderVersion?: string,
  ): BrainRecord {
    const record = this.#records.get(providerRecordId);
    if (record === undefined || !this.isVisible(record, access)) {
      throw recordNotFound();
    }
    if (
      expectedProviderVersion !== undefined &&
      expectedProviderVersion !== record.provenance.providerVersion
    ) {
      throw versionConflict();
    }
    return record;
  }

  private applyUpdate(
    current: BrainRecord,
    mutation: UpdateMutation,
    id: OperationId,
  ): BrainRecord {
    if (mutation.mode === 'replace') {
      if (
        typeof mutation.replacement.content !== 'string' ||
        (mutation.replacement.title !== undefined &&
          typeof mutation.replacement.title !== 'string')
      ) {
        throw invalidRequest('invalid_routed_update');
      }
      return this.nextRecord(current, id, {
        title: mutation.replacement.title ?? current.title,
        content: mutation.replacement.content,
        excerpt: excerpt(mutation.replacement.content),
      });
    }

    const keys = Object.keys(mutation.patch);
    if (
      keys.length === 0 ||
      keys.some((key) => key !== 'title' && key !== 'content') ||
      (mutation.patch['title'] !== undefined &&
        typeof mutation.patch['title'] !== 'string') ||
      (mutation.patch['content'] !== undefined &&
        typeof mutation.patch['content'] !== 'string')
    ) {
      throw invalidRequest('invalid_routed_update');
    }
    const title = mutation.patch['title'];
    const content = mutation.patch['content'];
    return this.nextRecord(current, id, {
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof content === 'string'
        ? { content, excerpt: excerpt(content) }
        : {}),
    });
  }

  private nextRecord(
    current: BrainRecord,
    id: OperationId,
    changes: Partial<Pick<BrainRecord, 'title' | 'content' | 'excerpt'>> = {},
  ): BrainRecord {
    return {
      ...cloneRecord(current),
      ...changes,
      provenance: {
        ...cloneProvenance(current.provenance),
        providerVersion: this.version(id),
        updatedAt: this.currentTime(),
      },
    };
  }

  private currentTime(): Date {
    const value = this.#now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw invalidConfiguration();
    }
    return new Date(value.getTime());
  }

  private version(id: OperationId): string {
    return `fake_version_${String(id)}`;
  }

  private rejectRepeatedMutation(id: OperationId): void {
    if (this.#mutations.has(id)) {
      throw new DomainError('idempotency_conflict', false, {
        reason: 'provider_operation_repeated',
      });
    }
  }

  private recordMutation(
    id: OperationId,
    kind: MutationKind,
    record: BrainRecord,
  ): ProviderMutationResult {
    const reference = recordReference(record);
    const reconciliationKey = `fake_reconcile_${this.#provider}_${String(id)}`;
    const uncertain = this.#unknownOperationIds.has(id);
    this.#mutations.set(id, {
      kind,
      reference,
      scope: record.policy.scope,
      reconciliationKey,
      uncertain,
    });
    return uncertain
      ? { outcome: 'unknown', reconciliationKey }
      : { outcome: 'completed', record: cloneReference(reference) };
  }
}

export class FakeFetchableKnowledgeProvider implements FetchableKnowledgeProvider {
  readonly provider: KnowledgeProviderName;
  readonly #store: FakeKnowledgeStore;

  constructor(
    provider: KnowledgeProviderName,
    records: readonly BrainRecord[],
    options: FakeKnowledgeProviderOptions,
  ) {
    this.provider = provider;
    this.#store = new FakeKnowledgeStore(provider, records, options);
  }

  search(
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ): Promise<ProviderSearchResponse> {
    return this.#store.search(request, signal);
  }

  fetch(
    request: ProviderFetchRequest,
    signal: AbortSignal,
  ): Promise<BrainRecord> {
    return this.#store.fetch(request, signal);
  }
}

export class FakeMutableKnowledgeProvider implements MutableKnowledgeProvider {
  readonly provider: MutableProviderName;
  readonly #store: FakeKnowledgeStore;

  constructor(
    provider: MutableProviderName,
    records: readonly BrainRecord[],
    options: FakeKnowledgeProviderOptions,
  );
  constructor(
    provider: unknown,
    records: readonly BrainRecord[],
    options: FakeKnowledgeProviderOptions,
  ) {
    if (provider !== 'notion' && provider !== 'drive') {
      throw invalidConfiguration();
    }
    this.provider = provider;
    this.#store = new FakeKnowledgeStore(provider, records, options);
  }

  search(
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ): Promise<ProviderSearchResponse> {
    return this.#store.search(request, signal);
  }

  fetch(
    request: ProviderFetchRequest,
    signal: AbortSignal,
  ): Promise<BrainRecord> {
    return this.#store.fetch(request, signal);
  }

  create(
    request: RoutedCreate,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    return this.#store.create(request, signal);
  }

  update(
    request: RoutedUpdate,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    return this.#store.update(request, signal);
  }

  append(
    request: RoutedAppend,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    return this.#store.append(request, signal);
  }

  trash(
    request: RoutedTrash,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    return this.#store.trash(request, signal);
  }

  reconcile(
    request: ReconciliationRequest,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    return this.#store.reconcile(request, signal);
  }
}
