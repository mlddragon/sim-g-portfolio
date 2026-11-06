import { createHash } from 'node:crypto';

import {
  APIErrorCode,
  isNotionClientError,
  type PageObjectResponse,
} from '@notionhq/client';

import { DomainError } from '../../domain/errors.js';
import {
  providerRecordId,
  type OperationId,
  type ProviderRecordId,
} from '../../domain/identifiers.js';
import type { ProviderMutationReference } from '../../domain/operations.js';
import type {
  BrainRecord,
  BrainScope,
  CanonicalLocation,
  ProtectedClass,
  RecordPolicyMetadata,
  Sensitivity,
} from '../../domain/records.js';
import { brainScopes } from '../../domain/records.js';
import type {
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
} from '../../ports/knowledge-provider.js';
import {
  canonicalNotionId,
  NOTION_API_VERSION,
  type NotionMutationSdkClient,
  type NotionPageSnapshot,
  type NotionRetrievalClient,
} from './notion-client.js';
import { NotionKnowledgeProvider } from './notion-knowledge-provider.js';
import {
  NotionScopeGuard,
  type NotionGovernedRoot,
} from './notion-scope-guard.js';

const maxConfiguredTargets = 32;
const maxIdentifierLength = 512;
const maxTitleLength = 2_000;
const maxContentBytes = 400_000;
const supportedContentTypes = new Set(['text/markdown', 'text/plain']);
const unsafeObjectKeys = new Set(['__proto__', 'constructor', 'prototype']);
const validScopes = new Set<BrainScope>(brainScopes);
const validSensitivities = new Set<Sensitivity>([
  'family_shared',
  'parent_and_stewardship',
  'restricted',
  'protected',
]);
const validProtectedClasses = new Set<ProtectedClass>([
  'none',
  'protected',
  'legal_hold',
  'governance',
  'security',
]);

export interface NotionMutationPropertyIds {
  readonly title: string;
  readonly operationMarker: string;
  readonly contentType: string;
  readonly contentHash: string;
}

export interface NotionMutationTarget {
  readonly rootRef: string;
  readonly propertyIds: NotionMutationPropertyIds;
}

export interface NotionMutableKnowledgeProviderOptions {
  readonly roots: readonly NotionGovernedRoot[];
  readonly mutationTargets: readonly NotionMutationTarget[];
}

interface MutationTargetSnapshot {
  readonly root: NotionGovernedRoot;
  readonly dataSourceId: string;
  readonly propertyIds: NotionMutationPropertyIds;
}

interface TargetState {
  readonly page: PageObjectResponse;
  readonly target: MutationTargetSnapshot;
  readonly title: string;
  readonly contentType: string;
}

interface ParsedUpdateMutation {
  readonly title?: string;
  readonly content?: string;
}

interface ParsedCreateRequest {
  readonly operationId: OperationId;
  readonly access: ProviderAccessScope;
  readonly title: string;
  readonly content: string;
  readonly contentType: string;
  readonly containerRef: string;
  readonly policy: RecordPolicyMetadata;
}

interface ParsedTargetRequest {
  readonly operationId: OperationId;
  readonly access: ProviderAccessScope;
  readonly providerRecordId: ProviderRecordId;
  readonly expectedProviderVersion?: string;
}

interface ParsedUpdateRequest extends ParsedTargetRequest {
  readonly mutation: ParsedUpdateMutation;
}

interface ParsedAppendRequest extends ParsedTargetRequest {
  readonly content: string;
}

type ParsedTrashRequest = ParsedTargetRequest;

interface ParsedReconciliationRequest {
  readonly operationId: OperationId;
  readonly operation: ReconciliationRequest['operation'];
  readonly access: ProviderAccessScope;
  readonly providerRecordId?: ProviderRecordId;
  readonly reconciliationKey?: string;
}

interface MutationOptionsSnapshot {
  readonly roots: readonly NotionGovernedRoot[];
  readonly mutationTargets: readonly NotionMutationTarget[];
}

interface ParsedReconciliationKey {
  readonly operation: ReconciliationRequest['operation'];
  readonly operationId: string;
  readonly rootRef: string;
  readonly contentHash: string;
  readonly contentTypeHash: string;
  readonly titleHash: string;
}

function cancellation(): DOMException {
  return new DOMException('Provider operation cancelled', 'AbortError');
}

function invalidRequest(reason: string): DomainError {
  return new DomainError('invalid_request', false, { reason });
}

const safeNotionErrorCodes: ReadonlySet<string> = new Set(
  Object.values(APIErrorCode),
);

// The stored body no longer hashes to the gateway's recorded content hash.
function integrityMismatch(): DomainError {
  return new DomainError('provider_unavailable', true, {
    reason: 'notion_content_integrity_mismatch',
  });
}

// Title, content type or content hash changed between the checks and the write.
function targetChanged(): DomainError {
  return new DomainError('provider_unavailable', true, {
    reason: 'notion_target_changed_before_write',
  });
}

// Names the failed step and Notion's closed-set error code, never its message.
function unavailable(
  step?:
    | 'create_lookup'
    | 'create'
    | 'update'
    | 'update_content'
    | 'trash'
    | 'reconcile_lookup'
    | 'reconcile'
    | 'reconcile_content'
    | 'load'
    | 'read_content',
  error?: unknown,
): DomainError {
  const code =
    isNotionClientError(error) && safeNotionErrorCodes.has(error.code)
      ? error.code
      : 'unclassified';
  return new DomainError('provider_unavailable', true, {
    reason:
      step === undefined
        ? 'notion_mutation_request_failed'
        : `notion_mutation_request_failed_${step}_${code}`,
  });
}

function notFound(): DomainError {
  return new DomainError('not_found', false, {
    reason: 'record_not_found',
  });
}

function repeatedOperation(): DomainError {
  return new DomainError('idempotency_conflict', false, {
    reason: 'provider_operation_repeated',
  });
}

function versionConflict(): DomainError {
  return new DomainError('idempotency_conflict', false, {
    reason: 'provider_version_mismatch',
  });
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function validText(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= maxLength &&
    (allowEmpty || value.trim() === value) &&
    !containsControlCharacter(value)
  );
}

function validContent(value: unknown, allowEmpty: boolean): value is string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxContentBytes ||
    !contentWithinBound(value)
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint <= 31 &&
        codePoint !== 9 &&
        codePoint !== 10 &&
        codePoint !== 13) ||
        codePoint === 127)
    ) {
      return false;
    }
  }
  return true;
}

function validNotionObjectId(value: unknown): value is string {
  return (
    validText(value, maxIdentifierLength) &&
    /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.test(
      value,
    )
  );
}

function validConfigurationId(value: unknown): value is string {
  return validText(value, maxIdentifierLength) && !unsafeObjectKeys.has(value);
}

function exactDataObject(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some(
      (key) =>
        typeof key !== 'string' ||
        !allowed.has(key) ||
        unsafeObjectKeys.has(key),
    ) ||
    requiredKeys.some((key) => !ownKeys.includes(key))
  ) {
    return undefined;
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of ownKeys) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      return undefined;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotDenseArray(
  value: unknown,
  maxLength: number,
): readonly unknown[] | undefined {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maxLength
  ) {
    return undefined;
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      return undefined;
    }
    snapshot.push(descriptor.value);
  }
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        key !== 'length' &&
        (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)),
    )
  ) {
    return undefined;
  }
  return Object.freeze(snapshot);
}

function snapshotAccessCandidate(
  value: unknown,
): ProviderAccessScope | undefined {
  const record = exactDataObject(value, ['brainScopes', 'rootRefs']);
  if (record === undefined) return undefined;
  const scopes = snapshotDenseArray(record['brainScopes'], brainScopes.length);
  const roots = snapshotDenseArray(record['rootRefs'], maxConfiguredTargets);
  if (scopes === undefined || roots === undefined) return undefined;
  return Object.freeze({
    brainScopes: scopes as readonly BrainScope[],
    rootRefs: roots as readonly string[],
  });
}

function snapshotPolicy(value: unknown): RecordPolicyMetadata | undefined {
  const record = exactDataObject(value, [
    'scope',
    'sensitivity',
    'protectedClass',
  ]);
  if (
    record === undefined ||
    typeof record['scope'] !== 'string' ||
    !validScopes.has(record['scope'] as BrainScope) ||
    typeof record['sensitivity'] !== 'string' ||
    !validSensitivities.has(record['sensitivity'] as Sensitivity) ||
    typeof record['protectedClass'] !== 'string' ||
    !validProtectedClasses.has(record['protectedClass'] as ProtectedClass)
  ) {
    return undefined;
  }
  return Object.freeze({
    scope: record['scope'] as BrainScope,
    sensitivity: record['sensitivity'] as Sensitivity,
    protectedClass: record['protectedClass'] as ProtectedClass,
  });
}

function snapshotGovernedRoot(value: unknown): NotionGovernedRoot | undefined {
  const record = exactDataObject(value, [
    'rootRef',
    'notionObject',
    'displayPath',
    'policy',
  ]);
  if (
    record === undefined ||
    !validConfigurationId(record['rootRef']) ||
    !validText(record['displayPath'], maxTitleLength)
  ) {
    return undefined;
  }
  const notionObject = exactDataObject(record['notionObject'], ['kind', 'id']);
  const policy = snapshotPolicy(record['policy']);
  if (
    notionObject === undefined ||
    (notionObject['kind'] !== 'page' &&
      notionObject['kind'] !== 'data_source') ||
    !validNotionObjectId(notionObject['id']) ||
    policy === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    rootRef: record['rootRef'],
    notionObject: Object.freeze({
      kind: notionObject['kind'],
      id: notionObject['id'],
    }),
    displayPath: record['displayPath'],
    policy,
  });
}

function snapshotMutationTarget(
  value: unknown,
): NotionMutationTarget | undefined {
  const record = exactDataObject(value, ['rootRef', 'propertyIds']);
  if (record === undefined || !validConfigurationId(record['rootRef'])) {
    return undefined;
  }
  const propertyRecord = exactDataObject(record['propertyIds'], [
    'title',
    'operationMarker',
    'contentType',
    'contentHash',
  ]);
  if (propertyRecord === undefined) return undefined;
  const values = [
    propertyRecord['title'],
    propertyRecord['operationMarker'],
    propertyRecord['contentType'],
    propertyRecord['contentHash'],
  ];
  if (
    !values.every(validConfigurationId) ||
    new Set(values).size !== values.length
  ) {
    return undefined;
  }
  return Object.freeze({
    rootRef: record['rootRef'],
    propertyIds: Object.freeze({
      title: propertyRecord['title'] as string,
      operationMarker: propertyRecord['operationMarker'] as string,
      contentType: propertyRecord['contentType'] as string,
      contentHash: propertyRecord['contentHash'] as string,
    }),
  });
}

function snapshotOptions(value: unknown): MutationOptionsSnapshot | undefined {
  const record = exactDataObject(value, ['roots', 'mutationTargets']);
  if (record === undefined) return undefined;
  const rootValues = snapshotDenseArray(record['roots'], maxConfiguredTargets);
  const targetValues = snapshotDenseArray(
    record['mutationTargets'],
    maxConfiguredTargets,
  );
  if (
    rootValues === undefined ||
    rootValues.length === 0 ||
    targetValues === undefined ||
    targetValues.length === 0
  ) {
    return undefined;
  }
  const roots = rootValues.map(snapshotGovernedRoot);
  const targets = targetValues.map(snapshotMutationTarget);
  if (
    roots.some((root) => root === undefined) ||
    targets.some((target) => target === undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    roots: Object.freeze(roots as NotionGovernedRoot[]),
    mutationTargets: Object.freeze(targets as NotionMutationTarget[]),
  });
}

function parseCreateRequest(value: unknown): ParsedCreateRequest | undefined {
  const request = exactDataObject(value, [
    'operationId',
    'access',
    'title',
    'content',
    'contentType',
    'canonicalLocation',
    'policy',
  ]);
  if (
    request === undefined ||
    !validText(request['operationId'], maxIdentifierLength) ||
    !validText(request['title'], maxTitleLength) ||
    !validContent(request['content'], true) ||
    typeof request['contentType'] !== 'string' ||
    !supportedContentTypes.has(request['contentType'])
  ) {
    return undefined;
  }
  const access = snapshotAccessCandidate(request['access']);
  const location = exactDataObject(
    request['canonicalLocation'],
    ['provider', 'containerRef'],
    ['displayPath'],
  );
  const policy = snapshotPolicy(request['policy']);
  if (
    access === undefined ||
    location === undefined ||
    location['provider'] !== 'notion' ||
    !validText(location['containerRef'], maxIdentifierLength) ||
    (location['displayPath'] !== undefined &&
      !validText(location['displayPath'], maxTitleLength)) ||
    policy === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    operationId: request['operationId'] as OperationId,
    access,
    title: request['title'],
    content: request['content'],
    contentType: request['contentType'],
    containerRef: location['containerRef'],
    policy,
  });
}

/**
 * Notion stores an appended line as a new block, so it may return its own
 * block separator between the earlier body and the append. Accept only the
 * exact earlier body, then line breaks alone (at most one blank line), then
 * the exact appended text without its leading line breaks.
 */
function landedAsNewBlock(
  held: string,
  earlier: string,
  appended: string,
): boolean {
  const added = appended.replace(/^\n+/u, '');
  if (
    added.length === 0 ||
    !held.startsWith(earlier) ||
    !held.endsWith(added)
  ) {
    return false;
  }
  const separator = held.slice(earlier.length, held.length - added.length);
  return (
    held.length >= earlier.length + added.length && /^\n{0,2}$/u.test(separator)
  );
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function contentWithinBound(content: string): boolean {
  return Buffer.byteLength(content, 'utf8') <= maxContentBytes;
}

function marker(
  operation: ReconciliationRequest['operation'],
  id: OperationId,
) {
  return `${operation}:${String(id)}`;
}

function textProperty(content: string) {
  return [{ type: 'text' as const, text: { content } }];
}

function isFullMutationPage(value: unknown): value is PageObjectResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const parent = record['parent'];
  const properties = record['properties'];
  return (
    record['object'] === 'page' &&
    validNotionObjectId(record['id']) &&
    validText(record['created_time'], 128) &&
    validText(record['last_edited_time'], 128) &&
    typeof record['in_trash'] === 'boolean' &&
    typeof parent === 'object' &&
    parent !== null &&
    !Array.isArray(parent) &&
    (parent as Readonly<Record<string, unknown>>)['type'] ===
      'data_source_id' &&
    validNotionObjectId(
      (parent as Readonly<Record<string, unknown>>)['data_source_id'],
    ) &&
    typeof properties === 'object' &&
    properties !== null &&
    !Array.isArray(properties)
  );
}

function richTextValue(items: unknown): string | undefined {
  if (!Array.isArray(items) || items.length > 100) return undefined;
  let text = '';
  for (const candidate of items) {
    const item: unknown = candidate;
    if (
      typeof item !== 'object' ||
      item === null ||
      Array.isArray(item) ||
      !('plain_text' in item) ||
      typeof item.plain_text !== 'string'
    ) {
      return undefined;
    }
    const plainText: string = item.plain_text;
    text += plainText;
    if (!contentWithinBound(text)) return undefined;
  }
  return text;
}

function propertyText(
  page: PageObjectResponse,
  propertyId: string,
  expectedType: 'title' | 'rich_text',
): string | undefined {
  const properties: unknown = page.properties;
  if (
    typeof properties !== 'object' ||
    properties === null ||
    Array.isArray(properties)
  ) {
    return undefined;
  }
  for (const value of Object.values(properties)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }
    const property = value as Readonly<Record<string, unknown>>;
    if (property['id'] !== propertyId) continue;
    if (expectedType === 'title' && property['type'] === 'title') {
      return richTextValue(property['title']);
    }
    if (expectedType === 'rich_text' && property['type'] === 'rich_text') {
      return richTextValue(property['rich_text']);
    }
  }
  return undefined;
}

function completeQueryPages(
  value: unknown,
): readonly PageObjectResponse[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const status = record['request_status'];
  if (
    record['object'] !== 'list' ||
    record['has_more'] !== false ||
    !Array.isArray(record['results']) ||
    record['results'].length > 2 ||
    (status !== undefined &&
      (typeof status !== 'object' ||
        status === null ||
        Array.isArray(status) ||
        (status as Readonly<Record<string, unknown>>)['type'] !== 'complete'))
  ) {
    return undefined;
  }
  const pages = record['results'].filter(isFullMutationPage);
  return pages.length === record['results'].length
    ? Object.freeze(pages)
    : undefined;
}

function pageMatchesTarget(
  page: PageObjectResponse,
  target: MutationTargetSnapshot,
  expectedMarker: string,
): boolean {
  return (
    !page.in_trash &&
    page.parent.type === 'data_source_id' &&
    page.parent.data_source_id === target.dataSourceId &&
    propertyText(page, target.propertyIds.operationMarker, 'rich_text') ===
      expectedMarker
  );
}

function pageTitle(page: PageObjectResponse, target: MutationTargetSnapshot) {
  return propertyText(page, target.propertyIds.title, 'title');
}

function pageSnapshot(
  page: PageObjectResponse,
  target: MutationTargetSnapshot,
): NotionPageSnapshot | undefined {
  const title = pageTitle(page, target);
  if (title === undefined) return undefined;

  let parent: NotionPageSnapshot['parent'];
  switch (page.parent.type) {
    case 'page_id':
      parent = { kind: 'page', id: page.parent.page_id };
      break;
    case 'data_source_id':
      parent = { kind: 'data_source', id: page.parent.data_source_id };
      break;
    case 'database_id':
      parent = { kind: 'database', id: page.parent.database_id };
      break;
    case 'block_id':
      parent = { kind: 'block', id: page.parent.block_id };
      break;
    case 'agent_id':
    case 'workspace':
      parent = { kind: 'terminal' };
      break;
  }

  return {
    id: page.id,
    title,
    createdTime: page.created_time,
    updatedTime: page.last_edited_time,
    inTrash: page.in_trash,
    parent,
  };
}

function isCompleteMarkdownResponse(
  value: unknown,
  pageId: string,
): value is {
  readonly object: 'page_markdown';
  readonly id: string;
  readonly markdown: string;
  readonly truncated: false;
  readonly unknown_block_ids: readonly [];
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'object' in value &&
    value.object === 'page_markdown' &&
    'id' in value &&
    value.id === pageId &&
    'markdown' in value &&
    typeof value.markdown === 'string' &&
    contentWithinBound(value.markdown) &&
    'truncated' in value &&
    value.truncated === false &&
    'unknown_block_ids' in value &&
    Array.isArray(value.unknown_block_ids) &&
    value.unknown_block_ids.length === 0
  );
}

function canonicalLocation(
  target: MutationTargetSnapshot,
  title: string,
): CanonicalLocation {
  return {
    provider: 'notion',
    containerRef: target.root.rootRef,
    displayPath: `${target.root.displayPath} / ${title}`,
  };
}

function reference(
  page: PageObjectResponse,
  target: MutationTargetSnapshot,
  title: string,
  integrityHash: string,
): ProviderMutationReference {
  return {
    provider: 'notion',
    providerRecordId: providerRecordId(page.id),
    providerVersion: page.last_edited_time,
    canonicalLocation: canonicalLocation(target, title),
    integrityHash,
  };
}

function isKnownRejectedWrite(error: unknown): boolean {
  if (!isNotionClientError(error)) return false;
  switch (error.code) {
    case APIErrorCode.Unauthorized:
    case APIErrorCode.RestrictedResource:
    case APIErrorCode.ObjectNotFound:
    case APIErrorCode.RateLimited:
    case APIErrorCode.InvalidJSON:
    case APIErrorCode.InvalidRequestURL:
    case APIErrorCode.InvalidRequest:
    case APIErrorCode.InvalidBeta:
    case APIErrorCode.ValidationError:
    case APIErrorCode.ConflictError:
      return true;
    case APIErrorCode.InternalServerError:
    case APIErrorCode.ServiceOverload:
    case APIErrorCode.ServiceUnavailable:
    case APIErrorCode.GatewayTimeout:
    default:
      return false;
  }
}

async function callWithCancellation<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw cancellation();

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(cancellation());
      });
    };

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let result: Promise<T>;
    try {
      result = run();
    } catch (error) {
      finish(() => {
        reject(error instanceof Error ? error : unavailable());
      });
      return;
    }
    Promise.resolve(result).then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof Error ? error : unavailable());
        });
      },
    );
  });
}

function snapshotTargets(
  roots: readonly NotionGovernedRoot[],
  candidates: readonly NotionMutationTarget[],
): ReadonlyMap<string, MutationTargetSnapshot> {
  if (candidates.length === 0 || candidates.length > maxConfiguredTargets) {
    throw new TypeError('invalid_notion_mutation_configuration');
  }

  const rootsByRef = new Map(roots.map((root) => [root.rootRef, root]));
  const targets = new Map<string, MutationTargetSnapshot>();
  for (const candidate of candidates) {
    const root = rootsByRef.get(candidate.rootRef);
    const propertyIds = candidate.propertyIds;
    if (
      root === undefined ||
      root.notionObject.kind !== 'data_source' ||
      targets.has(candidate.rootRef) ||
      !validConfigurationId(propertyIds.title) ||
      !validConfigurationId(propertyIds.operationMarker) ||
      !validConfigurationId(propertyIds.contentType) ||
      !validConfigurationId(propertyIds.contentHash) ||
      new Set(Object.values(propertyIds)).size !== 4
    ) {
      throw new TypeError('invalid_notion_mutation_configuration');
    }

    targets.set(
      candidate.rootRef,
      Object.freeze({
        root,
        dataSourceId: canonicalNotionId(root.notionObject.id),
        propertyIds: Object.freeze({ ...propertyIds }),
      }),
    );
  }
  return targets;
}

function createReconciliationKey(input: {
  readonly operation: ReconciliationRequest['operation'];
  readonly operationId: OperationId;
  readonly rootRef: string;
  readonly contentHash: string;
  readonly contentType: string;
  readonly titleHash: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      operation: input.operation,
      operationId: input.operationId,
      rootRef: input.rootRef,
      contentHash: input.contentHash,
      contentTypeHash: hashContent(input.contentType),
      titleHash: input.titleHash,
    }),
    'utf8',
  ).toString('base64url');
}

function parseReconciliationKey(
  value: string | undefined,
): ParsedReconciliationKey | undefined {
  if (value === undefined || !validText(value, 2_048)) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype ||
      Reflect.ownKeys(parsed).length !== 7 ||
      !('v' in parsed) ||
      parsed.v !== 1 ||
      !('operation' in parsed) ||
      (parsed.operation !== 'create' &&
        parsed.operation !== 'update' &&
        parsed.operation !== 'append' &&
        parsed.operation !== 'trash') ||
      !('operationId' in parsed) ||
      !validText(parsed.operationId, maxIdentifierLength) ||
      !('rootRef' in parsed) ||
      !validText(parsed.rootRef, maxIdentifierLength) ||
      !('contentHash' in parsed) ||
      typeof parsed.contentHash !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(parsed.contentHash) ||
      !('contentTypeHash' in parsed) ||
      typeof parsed.contentTypeHash !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(parsed.contentTypeHash) ||
      !('titleHash' in parsed) ||
      typeof parsed.titleHash !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(parsed.titleHash)
    ) {
      return undefined;
    }
    return {
      operation: parsed.operation,
      operationId: parsed.operationId,
      rootRef: parsed.rootRef,
      contentHash: parsed.contentHash,
      contentTypeHash: parsed.contentTypeHash,
      titleHash: parsed.titleHash,
    };
  } catch {
    return undefined;
  }
}

function parseUpdateMutation(value: unknown): ParsedUpdateMutation | undefined {
  const modeCandidate = exactDataObject(
    value,
    ['mode'],
    ['patch', 'replacement'],
  );
  if (modeCandidate === undefined) return undefined;

  if (modeCandidate['mode'] === 'replace') {
    if (Reflect.ownKeys(modeCandidate).length !== 2) return undefined;
    const replacement = exactDataObject(
      modeCandidate['replacement'],
      ['content'],
      ['title'],
    );
    if (
      replacement === undefined ||
      !validContent(replacement['content'], true) ||
      (replacement['title'] !== undefined &&
        !validText(replacement['title'], maxTitleLength))
    ) {
      return undefined;
    }
    return Object.freeze({
      ...(replacement['title'] === undefined
        ? {}
        : { title: replacement['title'] }),
      content: replacement['content'],
    });
  }

  if (modeCandidate['mode'] !== 'patch') return undefined;
  if (Reflect.ownKeys(modeCandidate).length !== 2) return undefined;
  const patch = exactDataObject(
    modeCandidate['patch'],
    [],
    ['title', 'content'],
  );
  if (patch === undefined || Reflect.ownKeys(patch).length === 0) {
    return undefined;
  }
  const title = patch['title'];
  const content = patch['content'];
  if (
    (title !== undefined && !validText(title, maxTitleLength)) ||
    (content !== undefined && !validContent(content, true)) ||
    (title === undefined && content === undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(title === undefined ? {} : { title }),
    ...(content === undefined ? {} : { content }),
  });
}

function parseTargetFields(
  value: unknown,
  requiredKeys: readonly string[],
):
  | Readonly<{
      record: Readonly<Record<string, unknown>>;
      operationId: OperationId;
      access: ProviderAccessScope;
      providerRecordId: ProviderRecordId;
      expectedProviderVersion?: string;
    }>
  | undefined {
  const record = exactDataObject(value, requiredKeys, [
    'expectedProviderVersion',
  ]);
  if (
    record === undefined ||
    !validText(record['operationId'], maxIdentifierLength) ||
    !validNotionObjectId(record['providerRecordId']) ||
    (record['expectedProviderVersion'] !== undefined &&
      !validText(record['expectedProviderVersion'], maxIdentifierLength))
  ) {
    return undefined;
  }
  const access = snapshotAccessCandidate(record['access']);
  if (access === undefined) return undefined;
  return Object.freeze({
    record,
    operationId: record['operationId'] as OperationId,
    access,
    providerRecordId: record['providerRecordId'] as ProviderRecordId,
    ...(record['expectedProviderVersion'] === undefined
      ? {}
      : { expectedProviderVersion: record['expectedProviderVersion'] }),
  });
}

function parseUpdateRequest(value: unknown): ParsedUpdateRequest | undefined {
  const fields = parseTargetFields(value, [
    'operationId',
    'access',
    'providerRecordId',
    'mutation',
  ]);
  if (fields === undefined) return undefined;
  const mutation = parseUpdateMutation(fields.record['mutation']);
  if (mutation === undefined) return undefined;
  return Object.freeze({
    operationId: fields.operationId,
    access: fields.access,
    providerRecordId: fields.providerRecordId,
    ...(fields.expectedProviderVersion === undefined
      ? {}
      : { expectedProviderVersion: fields.expectedProviderVersion }),
    mutation,
  });
}

function parseAppendRequest(value: unknown): ParsedAppendRequest | undefined {
  const fields = parseTargetFields(value, [
    'operationId',
    'access',
    'providerRecordId',
    'content',
  ]);
  if (fields === undefined || !validContent(fields.record['content'], false)) {
    return undefined;
  }
  return Object.freeze({
    operationId: fields.operationId,
    access: fields.access,
    providerRecordId: fields.providerRecordId,
    ...(fields.expectedProviderVersion === undefined
      ? {}
      : { expectedProviderVersion: fields.expectedProviderVersion }),
    content: fields.record['content'],
  });
}

function parseTrashRequest(value: unknown): ParsedTrashRequest | undefined {
  const fields = parseTargetFields(value, [
    'operationId',
    'access',
    'providerRecordId',
  ]);
  if (fields === undefined) return undefined;
  return Object.freeze({
    operationId: fields.operationId,
    access: fields.access,
    providerRecordId: fields.providerRecordId,
    ...(fields.expectedProviderVersion === undefined
      ? {}
      : { expectedProviderVersion: fields.expectedProviderVersion }),
  });
}

function parseReconciliationRequest(
  value: unknown,
): ParsedReconciliationRequest | undefined {
  const record = exactDataObject(
    value,
    ['operationId', 'operation', 'access'],
    ['providerRecordId', 'reconciliationKey'],
  );
  if (
    record === undefined ||
    !validText(record['operationId'], maxIdentifierLength) ||
    (record['operation'] !== 'create' &&
      record['operation'] !== 'update' &&
      record['operation'] !== 'append' &&
      record['operation'] !== 'trash') ||
    (record['providerRecordId'] !== undefined &&
      !validText(record['providerRecordId'], maxIdentifierLength)) ||
    (record['reconciliationKey'] !== undefined &&
      typeof record['reconciliationKey'] !== 'string')
  ) {
    return undefined;
  }
  const access = snapshotAccessCandidate(record['access']);
  if (access === undefined) return undefined;
  return Object.freeze({
    operationId: record['operationId'] as OperationId,
    operation: record['operation'],
    access,
    ...(record['providerRecordId'] === undefined
      ? {}
      : {
          providerRecordId: record['providerRecordId'] as ProviderRecordId,
        }),
    ...(record['reconciliationKey'] === undefined
      ? {}
      : { reconciliationKey: record['reconciliationKey'] }),
  });
}

export class NotionMutableKnowledgeProvider implements MutableKnowledgeProvider {
  readonly provider = 'notion' as const;
  readonly #retrieval: NotionKnowledgeProvider;
  readonly #scopeGuard: NotionScopeGuard;
  readonly #client: NotionMutationSdkClient;
  readonly #targets: ReadonlyMap<string, MutationTargetSnapshot>;

  constructor(
    retrievalClient: NotionRetrievalClient,
    client: NotionMutationSdkClient,
    options: NotionMutableKnowledgeProviderOptions,
  ) {
    const safeOptions = snapshotOptions(options);
    if (
      safeOptions === undefined ||
      typeof client.pages !== 'object' ||
      typeof client.dataSources !== 'object' ||
      client.apiVersion !== NOTION_API_VERSION ||
      typeof client.pages.create !== 'function' ||
      typeof client.pages.retrieve !== 'function' ||
      typeof client.pages.update !== 'function' ||
      typeof client.pages.retrieveMarkdown !== 'function' ||
      typeof client.pages.updateMarkdown !== 'function' ||
      typeof client.dataSources.query !== 'function'
    ) {
      throw new TypeError('invalid_notion_mutation_configuration');
    }
    this.#retrieval = new NotionKnowledgeProvider(retrievalClient, {
      roots: safeOptions.roots,
    });
    this.#scopeGuard = new NotionScopeGuard(retrievalClient, safeOptions.roots);
    this.#client = Object.freeze({
      apiVersion: client.apiVersion,
      pages: Object.freeze({
        create: client.pages.create,
        retrieve: client.pages.retrieve,
        update: client.pages.update,
        retrieveMarkdown: client.pages.retrieveMarkdown,
        updateMarkdown: client.pages.updateMarkdown,
      }),
      dataSources: Object.freeze({ query: client.dataSources.query }),
    });
    this.#targets = snapshotTargets(
      safeOptions.roots,
      safeOptions.mutationTargets,
    );
  }

  search(
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ): Promise<ProviderSearchResponse> {
    return this.#retrieval.search(request, signal);
  }

  fetch(
    request: ProviderFetchRequest,
    signal: AbortSignal,
  ): Promise<BrainRecord> {
    return this.#retrieval.fetch(request, signal);
  }

  async create(
    request: RoutedCreate,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    if (signal.aborted) throw cancellation();
    const safeRequest = parseCreateRequest(request);
    if (safeRequest === undefined)
      throw invalidRequest('invalid_routed_create');
    const access = this.#scopeGuard.snapshotAccess(safeRequest.access);
    const target = this.#targets.get(safeRequest.containerRef);
    if (
      target === undefined ||
      !access.rootRefs.includes(target.root.rootRef) ||
      !access.brainScopes.includes(target.root.policy.scope) ||
      !samePolicy(safeRequest.policy, target.root.policy)
    ) {
      throw invalidRequest('invalid_routed_create');
    }

    const expectedMarker = marker('create', safeRequest.operationId);
    try {
      const existing = await callWithCancellation(signal, () =>
        this.#client.dataSources.query({
          data_source_id: target.dataSourceId,
          page_size: 2,
          result_type: 'page',
          filter: {
            property: target.propertyIds.operationMarker,
            rich_text: { equals: expectedMarker },
          },
        }),
      );
      const existingPages = completeQueryPages(existing);
      if (existingPages === undefined) throw unavailable('create_lookup');
      if (existingPages.length > 0) throw repeatedOperation();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw cancellation();
      }
      throw unavailable('create_lookup', error);
    }

    const contentHash = hashContent(safeRequest.content);
    const reconciliationKey = createReconciliationKey({
      operation: 'create',
      operationId: safeRequest.operationId,
      rootRef: target.root.rootRef,
      contentHash,
      contentType: safeRequest.contentType,
      titleHash: hashContent(safeRequest.title),
    });

    try {
      const response = await callWithCancellation(signal, () =>
        this.#client.pages.create({
          parent: {
            type: 'data_source_id',
            data_source_id: target.dataSourceId,
          },
          properties: {
            [target.propertyIds.title]: {
              title: textProperty(safeRequest.title),
            },
            [target.propertyIds.operationMarker]: {
              rich_text: textProperty(expectedMarker),
            },
            [target.propertyIds.contentType]: {
              rich_text: textProperty(safeRequest.contentType),
            },
            [target.propertyIds.contentHash]: {
              rich_text: textProperty(contentHash),
            },
          },
          markdown: safeRequest.content,
          allow_async: false,
        }),
      );
      if (
        !isFullMutationPage(response) ||
        !pageMatchesTarget(response, target, expectedMarker) ||
        propertyText(response, target.propertyIds.title, 'title') !==
          safeRequest.title ||
        propertyText(response, target.propertyIds.contentType, 'rich_text') !==
          safeRequest.contentType ||
        propertyText(response, target.propertyIds.contentHash, 'rich_text') !==
          contentHash
      ) {
        return { outcome: 'unknown', reconciliationKey };
      }
      const storedContent = await this.retrieveMarkdown(
        providerRecordId(response.id),
        signal,
      );
      if (hashContent(storedContent) !== contentHash) {
        return { outcome: 'unknown', reconciliationKey };
      }
      return {
        outcome: 'completed',
        record: reference(response, target, safeRequest.title, contentHash),
      };
    } catch (error) {
      if (isKnownRejectedWrite(error)) throw unavailable('create', error);
      return { outcome: 'unknown', reconciliationKey };
    }
  }

  async update(
    request: RoutedUpdate,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    const safeRequest = parseUpdateRequest(request);
    if (safeRequest === undefined)
      throw invalidRequest('invalid_routed_update');
    const state = await this.loadTarget(
      safeRequest,
      'update',
      signal,
      safeRequest.expectedProviderVersion,
    );
    const mutation = {
      title: safeRequest.mutation.title ?? state.title,
      ...(safeRequest.mutation.content === undefined
        ? {}
        : { content: safeRequest.mutation.content }),
    };
    const current = await this.verifyCurrentContent(
      state,
      safeRequest.providerRecordId,
      signal,
    );
    const refreshed = await this.refreshTarget(
      state,
      safeRequest,
      'update',
      current.contentHash,
      signal,
    );

    if (mutation.content === undefined) {
      return await this.updateMetadataOnly(
        refreshed,
        safeRequest.operationId,
        'update',
        mutation.title,
        current.contentHash,
        signal,
      );
    }

    return await this.updateContent(
      refreshed,
      safeRequest.operationId,
      'update',
      mutation.title,
      mutation.content,
      signal,
    );
  }

  async append(
    request: RoutedAppend,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    const safeRequest = parseAppendRequest(request);
    if (safeRequest === undefined)
      throw invalidRequest('invalid_routed_append');
    const state = await this.loadTarget(
      safeRequest,
      'append',
      signal,
      safeRequest.expectedProviderVersion,
    );
    const current = await this.verifyCurrentContent(
      state,
      safeRequest.providerRecordId,
      signal,
    );
    const finalContent = `${current.content}${safeRequest.content}`;
    if (!contentWithinBound(finalContent)) {
      throw invalidRequest('invalid_routed_append');
    }
    const refreshed = await this.refreshTarget(
      state,
      safeRequest,
      'append',
      current.contentHash,
      signal,
    );
    return await this.updateContent(
      refreshed,
      safeRequest.operationId,
      'append',
      refreshed.title,
      finalContent,
      signal,
      safeRequest.content,
    );
  }

  async trash(
    request: RoutedTrash,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    const safeRequest = parseTrashRequest(request);
    if (safeRequest === undefined) throw invalidRequest('invalid_routed_trash');
    const state = await this.loadTarget(
      safeRequest,
      'trash',
      signal,
      safeRequest.expectedProviderVersion,
    );
    const current = await this.verifyCurrentContent(
      state,
      safeRequest.providerRecordId,
      signal,
    );
    const refreshed = await this.refreshTarget(
      state,
      safeRequest,
      'trash',
      current.contentHash,
      signal,
    );
    const expectedMarker = marker('trash', safeRequest.operationId);
    const integrityHash = current.contentHash;
    const reconciliationKey = createReconciliationKey({
      operation: 'trash',
      operationId: safeRequest.operationId,
      rootRef: refreshed.target.root.rootRef,
      contentHash: integrityHash,
      contentType: refreshed.contentType,
      titleHash: hashContent(refreshed.title),
    });

    try {
      const response = await callWithCancellation(signal, () =>
        this.#client.pages.update({
          page_id: safeRequest.providerRecordId,
          properties: {
            [refreshed.target.propertyIds.operationMarker]: {
              rich_text: textProperty(expectedMarker),
            },
          },
          in_trash: true,
        }),
      );
      if (
        !isFullMutationPage(response) ||
        response.id !== safeRequest.providerRecordId ||
        !response.in_trash ||
        response.parent.type !== 'data_source_id' ||
        response.parent.data_source_id !== refreshed.target.dataSourceId ||
        propertyText(
          response,
          refreshed.target.propertyIds.operationMarker,
          'rich_text',
        ) !== expectedMarker
      ) {
        return { outcome: 'unknown', reconciliationKey };
      }
      return {
        outcome: 'completed',
        record: reference(
          response,
          refreshed.target,
          refreshed.title,
          integrityHash,
        ),
      };
    } catch (error) {
      if (isKnownRejectedWrite(error)) throw unavailable('trash', error);
      return { outcome: 'unknown', reconciliationKey };
    }
  }

  async reconcile(
    request: ReconciliationRequest,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    if (signal.aborted) throw cancellation();
    const safeRequest = parseReconciliationRequest(request);
    if (safeRequest === undefined) {
      throw invalidRequest('invalid_reconciliation_request');
    }
    const access = this.#scopeGuard.snapshotAccess(safeRequest.access);
    const key = parseReconciliationKey(safeRequest.reconciliationKey);
    if (
      (safeRequest.reconciliationKey !== undefined && key === undefined) ||
      (key !== undefined &&
        (key.operation !== safeRequest.operation ||
          key.operationId !== safeRequest.operationId))
    ) {
      return { outcome: 'inconclusive' };
    }

    if (safeRequest.operation === 'create') {
      if (safeRequest.providerRecordId !== undefined) {
        return { outcome: 'inconclusive' };
      }
      return await this.reconcileCreate(safeRequest, access, key, signal);
    }
    if (
      safeRequest.providerRecordId === undefined ||
      !validNotionObjectId(safeRequest.providerRecordId)
    ) {
      return { outcome: 'inconclusive' };
    }
    return await this.reconcileTarget(
      { ...safeRequest, providerRecordId: safeRequest.providerRecordId },
      access,
      key,
      signal,
    );
  }

  private async reconcileCreate(
    request: ReconciliationRequest,
    access: ReturnType<NotionScopeGuard['snapshotAccess']>,
    key: ParsedReconciliationKey | undefined,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    const expectedMarker = marker('create', request.operationId);
    const targets = [...this.#targets.values()].filter(
      (target) =>
        access.rootRefs.includes(target.root.rootRef) &&
        access.brainScopes.includes(target.root.policy.scope) &&
        (key === undefined || key.rootRef === target.root.rootRef),
    );
    if (targets.length === 0) return { outcome: 'not_found' };

    const matches: Array<{
      readonly page: PageObjectResponse;
      readonly target: MutationTargetSnapshot;
    }> = [];
    for (const target of targets) {
      let response;
      try {
        response = await callWithCancellation(signal, () =>
          this.#client.dataSources.query({
            data_source_id: target.dataSourceId,
            page_size: 2,
            result_type: 'page',
            filter: {
              property: target.propertyIds.operationMarker,
              rich_text: { equals: expectedMarker },
            },
          }),
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw cancellation();
        }
        throw unavailable('reconcile_lookup', error);
      }
      const pages = completeQueryPages(response);
      if (pages === undefined) return { outcome: 'inconclusive' };
      for (const candidate of pages) {
        if (pageMatchesTarget(candidate, target, expectedMarker)) {
          matches.push({ page: candidate, target });
        }
      }
    }
    if (matches.length === 0) return { outcome: 'not_found' };
    if (matches.length !== 1) return { outcome: 'inconclusive' };
    const match = matches[0];
    if (match === undefined) return { outcome: 'inconclusive' };
    return await this.reconciledPage(match.page, match.target, key, signal);
  }

  private async reconcileTarget(
    request: ReconciliationRequest & {
      readonly providerRecordId: ProviderRecordId;
    },
    access: ReturnType<NotionScopeGuard['snapshotAccess']>,
    key: ParsedReconciliationKey | undefined,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    let response: Awaited<
      ReturnType<NotionMutationSdkClient['pages']['retrieve']>
    >;
    try {
      response = await callWithCancellation(signal, () =>
        this.#client.pages.retrieve({ page_id: request.providerRecordId }),
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw cancellation();
      }
      if (
        isNotionClientError(error) &&
        error.code === APIErrorCode.ObjectNotFound
      ) {
        return { outcome: 'not_found' };
      }
      throw unavailable('reconcile', error);
    }
    if (!isFullMutationPage(response)) return { outcome: 'inconclusive' };
    const target = [...this.#targets.values()].find(
      (candidate) =>
        response.parent.type === 'data_source_id' &&
        response.parent.data_source_id === candidate.dataSourceId,
    );
    if (
      target === undefined ||
      !access.rootRefs.includes(target.root.rootRef) ||
      !access.brainScopes.includes(target.root.policy.scope) ||
      (key !== undefined && key.rootRef !== target.root.rootRef)
    ) {
      return { outcome: 'not_found' };
    }
    if (
      propertyText(
        response,
        target.propertyIds.operationMarker,
        'rich_text',
      ) !== marker(request.operation, request.operationId)
    ) {
      return { outcome: 'not_found' };
    }
    if (request.operation === 'trash') {
      if (!response.in_trash) return { outcome: 'inconclusive' };
      return this.reconciledTrash(response, target, key);
    }
    if (response.in_trash) return { outcome: 'inconclusive' };
    return await this.reconciledPage(response, target, key, signal);
  }

  private async reconciledPage(
    page: PageObjectResponse,
    target: MutationTargetSnapshot,
    key: ParsedReconciliationKey | undefined,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    const title = pageTitle(page, target);
    const contentHash = propertyText(
      page,
      target.propertyIds.contentHash,
      'rich_text',
    );
    const contentType = propertyText(
      page,
      target.propertyIds.contentType,
      'rich_text',
    );
    if (
      title === undefined ||
      contentHash === undefined ||
      !/^[0-9a-f]{64}$/u.test(contentHash) ||
      contentType === undefined ||
      !supportedContentTypes.has(contentType) ||
      (key !== undefined &&
        (key.contentHash !== contentHash ||
          key.contentTypeHash !== hashContent(contentType) ||
          key.titleHash !== hashContent(title)))
    ) {
      return { outcome: 'inconclusive' };
    }
    let content: string;
    try {
      content = await this.retrieveMarkdown(providerRecordId(page.id), signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw cancellation();
      }
      throw unavailable('reconcile_content', error);
    }
    if (hashContent(content) !== contentHash) {
      return { outcome: 'inconclusive' };
    }
    return {
      outcome: 'completed',
      record: reference(page, target, title, contentHash),
    };
  }

  private reconciledTrash(
    page: PageObjectResponse,
    target: MutationTargetSnapshot,
    key: ParsedReconciliationKey | undefined,
  ): ReconciliationResult {
    const title = pageTitle(page, target);
    const contentHash = propertyText(
      page,
      target.propertyIds.contentHash,
      'rich_text',
    );
    const contentType = propertyText(
      page,
      target.propertyIds.contentType,
      'rich_text',
    );
    if (
      title === undefined ||
      contentHash === undefined ||
      !/^[0-9a-f]{64}$/u.test(contentHash) ||
      contentType === undefined ||
      !supportedContentTypes.has(contentType) ||
      (key !== undefined &&
        (key.contentHash !== contentHash ||
          key.contentTypeHash !== hashContent(contentType) ||
          key.titleHash !== hashContent(title)))
    ) {
      return { outcome: 'inconclusive' };
    }
    return {
      outcome: 'completed',
      record: reference(page, target, title, contentHash),
    };
  }

  private async loadTarget(
    request: ParsedTargetRequest,
    operation: 'update' | 'append' | 'trash',
    signal: AbortSignal,
    expectedProviderVersion: string | undefined,
  ): Promise<TargetState> {
    if (
      signal.aborted ||
      !validNotionObjectId(request.providerRecordId) ||
      !validText(request.operationId, maxIdentifierLength)
    ) {
      if (signal.aborted) throw cancellation();
      throw invalidRequest(`invalid_routed_${operation}`);
    }
    if (!validText(expectedProviderVersion, maxIdentifierLength)) {
      throw invalidRequest('provider_version_required');
    }
    const access = this.#scopeGuard.snapshotAccess(request.access);

    let response: Awaited<
      ReturnType<NotionMutationSdkClient['pages']['retrieve']>
    >;
    try {
      response = await callWithCancellation(signal, () =>
        this.#client.pages.retrieve({
          page_id: request.providerRecordId,
        }),
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw cancellation();
      }
      if (
        isNotionClientError(error) &&
        error.code === APIErrorCode.ObjectNotFound
      ) {
        throw notFound();
      }
      throw unavailable('load', error);
    }
    if (!isFullMutationPage(response)) throw unavailable('load');
    if (response.in_trash) throw notFound();

    const directTarget = [...this.#targets.values()].find(
      (target) =>
        response.parent.type === 'data_source_id' &&
        response.parent.data_source_id === target.dataSourceId,
    );
    if (directTarget === undefined) throw notFound();
    const snapshot = pageSnapshot(response, directTarget);
    if (snapshot === undefined) throw unavailable('load');
    const root = await this.#scopeGuard.resolveAuthorizedRoot(
      snapshot,
      access,
      signal,
    );
    if (root?.rootRef !== directTarget.root.rootRef) throw notFound();
    if (
      propertyText(
        response,
        directTarget.propertyIds.operationMarker,
        'rich_text',
      ) === marker(operation, request.operationId)
    ) {
      throw repeatedOperation();
    }
    if (response.last_edited_time !== expectedProviderVersion) {
      throw versionConflict();
    }
    const title = pageTitle(response, directTarget);
    const contentType = propertyText(
      response,
      directTarget.propertyIds.contentType,
      'rich_text',
    );
    if (
      title === undefined ||
      !validText(title, maxTitleLength) ||
      contentType === undefined ||
      !supportedContentTypes.has(contentType)
    ) {
      throw invalidRequest('invalid_notion_record_metadata');
    }
    return { page: response, target: directTarget, title, contentType };
  }

  private storedContentHash(state: TargetState): string {
    const contentHash = propertyText(
      state.page,
      state.target.propertyIds.contentHash,
      'rich_text',
    );
    if (contentHash === undefined || !/^[0-9a-f]{64}$/u.test(contentHash)) {
      throw invalidRequest('invalid_notion_record_metadata');
    }
    return contentHash;
  }

  private async verifyCurrentContent(
    state: TargetState,
    pageId: ProviderRecordId,
    signal: AbortSignal,
  ): Promise<{ readonly content: string; readonly contentHash: string }> {
    const contentHash = this.storedContentHash(state);
    const content = await this.retrieveMarkdown(pageId, signal);
    if (hashContent(content) !== contentHash) throw integrityMismatch();
    return { content, contentHash };
  }

  private async refreshTarget(
    initial: TargetState,
    request: ParsedTargetRequest,
    operation: 'update' | 'append' | 'trash',
    verifiedContentHash: string,
    signal: AbortSignal,
  ): Promise<TargetState> {
    const refreshed = await this.loadTarget(
      request,
      operation,
      signal,
      request.expectedProviderVersion,
    );
    if (
      refreshed.target.root.rootRef !== initial.target.root.rootRef ||
      refreshed.target.dataSourceId !== initial.target.dataSourceId
    ) {
      throw notFound();
    }
    if (
      refreshed.title !== initial.title ||
      refreshed.contentType !== initial.contentType ||
      this.storedContentHash(refreshed) !== verifiedContentHash
    ) {
      throw targetChanged();
    }
    return refreshed;
  }

  private async retrieveMarkdown(
    pageId: ProviderRecordId,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const response = await callWithCancellation(signal, () =>
        this.#client.pages.retrieveMarkdown({
          page_id: pageId,
          include_transcript: false,
        }),
      );
      if (!isCompleteMarkdownResponse(response, pageId))
        throw unavailable('read_content');
      return response.markdown;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw cancellation();
      }
      throw unavailable('read_content', error);
    }
  }

  private async updateMetadataOnly(
    state: TargetState,
    operationId: OperationId,
    operation: 'update',
    title: string,
    contentHash: string,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    const expectedMarker = marker(operation, operationId);
    const reconciliationKey = createReconciliationKey({
      operation,
      operationId,
      rootRef: state.target.root.rootRef,
      contentHash,
      contentType: state.contentType,
      titleHash: hashContent(title),
    });
    try {
      const response = await callWithCancellation(signal, () =>
        this.#client.pages.update({
          page_id: state.page.id,
          properties: {
            [state.target.propertyIds.title]: {
              title: textProperty(title),
            },
            [state.target.propertyIds.operationMarker]: {
              rich_text: textProperty(expectedMarker),
            },
            [state.target.propertyIds.contentType]: {
              rich_text: textProperty(state.contentType),
            },
            [state.target.propertyIds.contentHash]: {
              rich_text: textProperty(contentHash),
            },
          },
        }),
      );
      if (
        !isFullMutationPage(response) ||
        response.id !== state.page.id ||
        !pageMatchesTarget(response, state.target, expectedMarker) ||
        pageTitle(response, state.target) !== title ||
        propertyText(
          response,
          state.target.propertyIds.contentType,
          'rich_text',
        ) !== state.contentType ||
        propertyText(
          response,
          state.target.propertyIds.contentHash,
          'rich_text',
        ) !== contentHash
      ) {
        return { outcome: 'unknown', reconciliationKey };
      }
      return {
        outcome: 'completed',
        record: reference(response, state.target, title, contentHash),
      };
    } catch (error) {
      if (isKnownRejectedWrite(error)) throw unavailable('update', error);
      return { outcome: 'unknown', reconciliationKey };
    }
  }

  private async updateContent(
    state: TargetState,
    operationId: OperationId,
    operation: 'update' | 'append',
    title: string,
    finalContent: string,
    signal: AbortSignal,
    appendedContent?: string,
  ): Promise<ProviderMutationResult> {
    let contentHash = hashContent(finalContent);
    const expectedMarker = marker(operation, operationId);
    const keyFor = (hash: string) =>
      createReconciliationKey({
        operation,
        operationId,
        rootRef: state.target.root.rootRef,
        contentHash: hash,
        contentType: state.contentType,
        titleHash: hashContent(title),
      });
    let reconciliationKey = keyFor(contentHash);
    let metadataWritten = false;

    try {
      const metadata = await callWithCancellation(signal, () =>
        this.#client.pages.update({
          page_id: state.page.id,
          properties: {
            ...(title === state.title
              ? {}
              : {
                  [state.target.propertyIds.title]: {
                    title: textProperty(title),
                  },
                }),
            [state.target.propertyIds.operationMarker]: {
              rich_text: textProperty(expectedMarker),
            },
            [state.target.propertyIds.contentType]: {
              rich_text: textProperty(state.contentType),
            },
            [state.target.propertyIds.contentHash]: {
              rich_text: textProperty(contentHash),
            },
          },
        }),
      );
      if (
        !isFullMutationPage(metadata) ||
        metadata.id !== state.page.id ||
        !pageMatchesTarget(metadata, state.target, expectedMarker) ||
        pageTitle(metadata, state.target) !== title ||
        propertyText(
          metadata,
          state.target.propertyIds.contentType,
          'rich_text',
        ) !== state.contentType ||
        propertyText(
          metadata,
          state.target.propertyIds.contentHash,
          'rich_text',
        ) !== contentHash
      ) {
        return { outcome: 'unknown', reconciliationKey };
      }
      metadataWritten = true;

      const contentResponse = await callWithCancellation(signal, () =>
        appendedContent === undefined
          ? this.#client.pages.updateMarkdown({
              page_id: state.page.id,
              type: 'replace_content',
              replace_content: {
                new_str: finalContent,
                allow_deleting_content: true,
              },
              allow_async: false,
            })
          : this.#client.pages.updateMarkdown({
              page_id: state.page.id,
              type: 'insert_content',
              insert_content: {
                content: appendedContent,
                position: { type: 'end' },
              },
              allow_async: false,
            }),
      );
      if (!isCompleteMarkdownResponse(contentResponse, state.page.id)) {
        return { outcome: 'unknown', reconciliationKey };
      }
      if (contentResponse.markdown !== finalContent) {
        if (
          appendedContent === undefined ||
          !landedAsNewBlock(
            contentResponse.markdown,
            finalContent.slice(0, finalContent.length - appendedContent.length),
            appendedContent,
          )
        ) {
          return { outcome: 'unknown', reconciliationKey };
        }
        // Record the body Notion holds, so later integrity checks match it.
        contentHash = hashContent(contentResponse.markdown);
        reconciliationKey = keyFor(contentHash);
        const rehashed = await callWithCancellation(signal, () =>
          this.#client.pages.update({
            page_id: state.page.id,
            properties: {
              [state.target.propertyIds.contentHash]: {
                rich_text: textProperty(contentHash),
              },
            },
          }),
        );
        if (
          !isFullMutationPage(rehashed) ||
          rehashed.id !== state.page.id ||
          !pageMatchesTarget(rehashed, state.target, expectedMarker) ||
          propertyText(
            rehashed,
            state.target.propertyIds.contentHash,
            'rich_text',
          ) !== contentHash
        ) {
          return { outcome: 'unknown', reconciliationKey };
        }
      }

      const finalPage = await callWithCancellation(signal, () =>
        this.#client.pages.retrieve({ page_id: state.page.id }),
      );
      if (
        !isFullMutationPage(finalPage) ||
        finalPage.id !== state.page.id ||
        !pageMatchesTarget(finalPage, state.target, expectedMarker) ||
        pageTitle(finalPage, state.target) !== title ||
        propertyText(
          finalPage,
          state.target.propertyIds.contentType,
          'rich_text',
        ) !== state.contentType ||
        propertyText(
          finalPage,
          state.target.propertyIds.contentHash,
          'rich_text',
        ) !== contentHash
      ) {
        return { outcome: 'unknown', reconciliationKey };
      }
      return {
        outcome: 'completed',
        record: reference(finalPage, state.target, title, contentHash),
      };
    } catch (error) {
      if (!metadataWritten && isKnownRejectedWrite(error))
        throw unavailable('update_content', error);
      return { outcome: 'unknown', reconciliationKey };
    }
  }
}

function samePolicy(
  left: RecordPolicyMetadata,
  right: RecordPolicyMetadata,
): boolean {
  return (
    left.scope === right.scope &&
    left.sensitivity === right.sensitivity &&
    left.protectedClass === right.protectedClass
  );
}
