import {
  APIErrorCode,
  isFullPage,
  isNotionClientError,
  type CreatePageResponse,
  type PageObjectResponse,
  type RichTextItemResponse,
} from '@notionhq/client';

import type { ApprovalStatus } from '../../domain/approvals.js';
import { DomainError } from '../../domain/errors.js';
import {
  providerRecordId,
  type ApprovalRequestId,
  type OperationId,
  type ProviderRecordId,
  type RequestId,
} from '../../domain/identifiers.js';
import type {
  ApprovalProjectionPort,
  CreateApprovalProjectionRequest,
  FindApprovalProjectionRequest,
  UpdateApprovalProjectionRequest,
} from '../../ports/approval-projection.js';
import {
  canonicalNotionId,
  NOTION_API_VERSION,
  type NotionFamilyInboxSdkClient,
} from './notion-client.js';

const approvalStatuses = [
  'pending',
  'approved',
  'declined',
  'cancelled',
  'superseded',
  'impossible',
] as const satisfies readonly ApprovalStatus[];

const propertyKeys = [
  'title',
  'approvalRequestId',
  'operationId',
  'requestId',
  'requestedBy',
  'action',
  'safeTargetDescription',
  'status',
  'safeResolutionReason',
] as const;

const maxIdentifierLength = 512;
const maxDisplayNameLength = 128;
const maxActionLength = 256;
const maxTargetDescriptionLength = 1_000;
const maxResolutionReasonLength = 1_000;
const unsafeObjectKeys = new Set(['__proto__', 'constructor', 'prototype']);

export interface NotionFamilyInboxPropertyIds {
  readonly title: string;
  readonly approvalRequestId: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly requestedBy: string;
  readonly action: string;
  readonly safeTargetDescription: string;
  readonly status: string;
  readonly safeResolutionReason: string;
}

export interface NotionFamilyInboxOptions {
  readonly dataSourceId: string;
  readonly propertyIds: NotionFamilyInboxPropertyIds;
  readonly statusOptionIds: Readonly<Record<ApprovalStatus, string>>;
}

interface ValidatedCreateRequest {
  readonly approvalRequestId: ApprovalRequestId;
  readonly operationId: OperationId;
  readonly requestId: RequestId;
  readonly requestedByDisplayName: string;
  readonly action: string;
  readonly safeTargetDescription: string;
  readonly status: ApprovalStatus;
}

interface ValidatedUpdateRequest {
  readonly providerRecordId: ProviderRecordId;
  readonly approvalRequestId: ApprovalRequestId;
  readonly status: ApprovalStatus;
  readonly safeResolutionReason?: string;
}

class MutationOutcomeUnknown extends Error {
  constructor() {
    super('notion_family_inbox_mutation_outcome_unknown');
    this.name = 'MutationOutcomeUnknown';
  }
}

function cancellation(): DOMException {
  return new DOMException('Provider operation cancelled', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
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

function validText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !containsControlCharacter(value)
  );
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
    )
  ) {
    return undefined;
  }
  if (requiredKeys.some((key) => !ownKeys.includes(key))) return undefined;

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

function snapshotStringMap<Key extends string>(
  value: unknown,
  keys: readonly Key[],
): Readonly<Record<Key, string>> | undefined {
  const record = exactDataObject(value, keys);
  if (record === undefined) return undefined;

  const snapshot = {} as Record<Key, string>;
  for (const key of keys) {
    const item = record[key];
    if (!validConfigurationId(item)) return undefined;
    snapshot[key] = item;
  }
  return Object.freeze(snapshot);
}

function snapshotOptions(value: unknown): NotionFamilyInboxOptions | undefined {
  const record = exactDataObject(value, [
    'dataSourceId',
    'propertyIds',
    'statusOptionIds',
  ]);
  if (record === undefined || !validNotionObjectId(record['dataSourceId'])) {
    return undefined;
  }

  const propertyIds = snapshotStringMap(record['propertyIds'], propertyKeys);
  const statusOptionIds = snapshotStringMap(
    record['statusOptionIds'],
    approvalStatuses,
  );
  if (propertyIds === undefined || statusOptionIds === undefined) {
    return undefined;
  }
  if (new Set(Object.values(propertyIds)).size !== propertyKeys.length) {
    return undefined;
  }
  if (
    new Set(Object.values(statusOptionIds)).size !== approvalStatuses.length
  ) {
    return undefined;
  }

  return Object.freeze({
    dataSourceId: canonicalNotionId(record['dataSourceId']),
    propertyIds,
    statusOptionIds,
  });
}

function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return approvalStatuses.some((status) => status === value);
}

function invalidRequest(): DomainError {
  return new DomainError('invalid_request', false, {
    reason: 'invalid_family_inbox_projection_request',
  });
}

function notFound(): DomainError {
  return new DomainError('not_found', false, {
    reason: 'approval_projection_not_found',
  });
}

function unavailable(): DomainError {
  return new DomainError('provider_unavailable', true, {
    reason: 'notion_family_inbox_request_failed',
  });
}

function outcomeUnknown(
  operation: 'create' | 'update',
  approvalRequestId: ApprovalRequestId,
): DomainError {
  return new DomainError('outcome_unknown', false, {
    reason: `notion_family_inbox_${operation}_outcome_unknown`,
    approvalRequestId,
  });
}

function parseCreateRequest(
  value: unknown,
): ValidatedCreateRequest | undefined {
  const request = exactDataObject(value, [
    'approvalRequestId',
    'operationId',
    'requestId',
    'summary',
    'status',
  ]);
  if (
    request === undefined ||
    !validText(request['approvalRequestId'], maxIdentifierLength) ||
    !validText(request['operationId'], maxIdentifierLength) ||
    !validText(request['requestId'], maxIdentifierLength) ||
    !isApprovalStatus(request['status'])
  ) {
    return undefined;
  }

  const summary = exactDataObject(request['summary'], [
    'requestedByDisplayName',
    'action',
    'safeTargetDescription',
  ]);
  if (
    summary === undefined ||
    !validText(summary['requestedByDisplayName'], maxDisplayNameLength) ||
    !validText(summary['action'], maxActionLength) ||
    !validText(summary['safeTargetDescription'], maxTargetDescriptionLength)
  ) {
    return undefined;
  }

  return Object.freeze({
    approvalRequestId: request['approvalRequestId'] as ApprovalRequestId,
    operationId: request['operationId'] as OperationId,
    requestId: request['requestId'] as RequestId,
    requestedByDisplayName: summary['requestedByDisplayName'],
    action: summary['action'],
    safeTargetDescription: summary['safeTargetDescription'],
    status: request['status'],
  });
}

function parseFindRequest(
  value: unknown,
): FindApprovalProjectionRequest | undefined {
  const request = exactDataObject(value, [
    'approvalRequestId',
    'operationId',
    'requestId',
  ]);
  if (
    request === undefined ||
    !validText(request['approvalRequestId'], maxIdentifierLength) ||
    !validText(request['operationId'], maxIdentifierLength) ||
    !validText(request['requestId'], maxIdentifierLength)
  ) {
    return undefined;
  }
  return Object.freeze({
    approvalRequestId: request['approvalRequestId'] as ApprovalRequestId,
    operationId: request['operationId'] as OperationId,
    requestId: request['requestId'] as RequestId,
  });
}

function parseUpdateRequest(
  value: unknown,
): ValidatedUpdateRequest | undefined {
  const request = exactDataObject(
    value,
    ['providerRecordId', 'approvalRequestId', 'status'],
    ['safeResolutionReason'],
  );
  if (
    request === undefined ||
    !validNotionObjectId(request['providerRecordId']) ||
    !validText(request['approvalRequestId'], maxIdentifierLength) ||
    !isApprovalStatus(request['status'])
  ) {
    return undefined;
  }
  const reason = request['safeResolutionReason'];
  if (reason !== undefined && !validText(reason, maxResolutionReasonLength)) {
    return undefined;
  }

  return Object.freeze({
    providerRecordId: request['providerRecordId'] as ProviderRecordId,
    approvalRequestId: request['approvalRequestId'] as ApprovalRequestId,
    status: request['status'],
    ...(reason === undefined ? {} : { safeResolutionReason: reason }),
  });
}

function textProperty(content: string) {
  return [{ type: 'text' as const, text: { content } }];
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
  mutation: boolean,
): Promise<T> {
  if (signal.aborted) throw cancellation();

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let dispatched = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(
          mutation && dispatched
            ? new MutationOutcomeUnknown()
            : cancellation(),
        );
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
      dispatched = true;
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

function pageMatchesDataSource(
  page: PageObjectResponse,
  dataSourceId: string,
): boolean {
  return (
    !page.in_trash &&
    page.parent.type === 'data_source_id' &&
    page.parent.data_source_id === dataSourceId
  );
}

function richTextValue(items: readonly RichTextItemResponse[]): string {
  return items.map((item) => item.plain_text).join('');
}

function isPageResponse(value: unknown): value is CreatePageResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'object' in value &&
    value.object === 'page' &&
    'id' in value &&
    validNotionObjectId(value.id)
  );
}

function richTextPropertyMatches(
  page: PageObjectResponse,
  propertyId: string,
  expected: string,
): boolean {
  for (const property of Object.values(page.properties)) {
    if (property.id !== propertyId) continue;
    return (
      property.type === 'rich_text' &&
      richTextValue(property.rich_text) === expected
    );
  }
  return false;
}

function approvalIdMatches(
  page: PageObjectResponse,
  propertyId: string,
  approvalRequestId: ApprovalRequestId,
): boolean {
  return richTextPropertyMatches(page, propertyId, approvalRequestId);
}

function correlationMatches(
  page: PageObjectResponse,
  propertyIds: NotionFamilyInboxOptions['propertyIds'],
  request: FindApprovalProjectionRequest,
): boolean {
  return (
    richTextPropertyMatches(
      page,
      propertyIds.approvalRequestId,
      request.approvalRequestId,
    ) &&
    richTextPropertyMatches(
      page,
      propertyIds.operationId,
      request.operationId,
    ) &&
    richTextPropertyMatches(page, propertyIds.requestId, request.requestId)
  );
}

export class NotionFamilyInboxProjection implements ApprovalProjectionPort {
  readonly #client: NotionFamilyInboxSdkClient;
  readonly #options: NotionFamilyInboxOptions;

  constructor(
    client: NotionFamilyInboxSdkClient,
    options: NotionFamilyInboxOptions,
  ) {
    const snapshot = snapshotOptions(options);
    if (
      snapshot === undefined ||
      client.apiVersion !== NOTION_API_VERSION ||
      typeof client.pages.create !== 'function' ||
      typeof client.pages.retrieve !== 'function' ||
      typeof client.pages.update !== 'function' ||
      typeof client.dataSources.query !== 'function'
    ) {
      throw new TypeError('invalid_notion_family_inbox_configuration');
    }

    this.#client = Object.freeze({
      apiVersion: client.apiVersion,
      pages: Object.freeze({
        create: client.pages.create,
        retrieve: client.pages.retrieve,
        update: client.pages.update,
      }),
      dataSources: Object.freeze({ query: client.dataSources.query }),
    });
    this.#options = snapshot;
  }

  async findByApprovalRequestId(
    requestValue: FindApprovalProjectionRequest,
    signal: AbortSignal,
  ): Promise<{ readonly providerRecordId: ProviderRecordId } | null> {
    const request = parseFindRequest(requestValue);
    if (request === undefined) throw invalidRequest();
    if (signal.aborted) throw cancellation();
    try {
      const response = await callWithCancellation(
        signal,
        () =>
          this.#client.dataSources.query({
            data_source_id: this.#options.dataSourceId,
            page_size: 2,
            result_type: 'page',
            filter: {
              property: this.#options.propertyIds.approvalRequestId,
              rich_text: { equals: request.approvalRequestId },
            },
          }),
        false,
      );
      const matches = response.results.filter(
        (candidate): candidate is PageObjectResponse =>
          isPageResponse(candidate) &&
          isFullPage(candidate) &&
          pageMatchesDataSource(candidate, this.#options.dataSourceId) &&
          correlationMatches(candidate, this.#options.propertyIds, request),
      );
      if (response.has_more || matches.length > 1) {
        throw new DomainError('idempotency_conflict', false, {
          reason: 'approval_projection_duplicate',
        });
      }
      if (
        response.request_status?.type === 'incomplete' ||
        response.results.length !== matches.length
      ) {
        throw unavailable();
      }
      const match = matches[0];
      return match === undefined
        ? null
        : { providerRecordId: providerRecordId(match.id) };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (isAbortError(error)) throw cancellation();
      throw unavailable();
    }
  }

  async create(
    request: CreateApprovalProjectionRequest,
    signal: AbortSignal,
  ): Promise<{ readonly providerRecordId: ProviderRecordId }> {
    const safeRequest = parseCreateRequest(request);
    if (safeRequest === undefined) throw invalidRequest();
    if (signal.aborted) throw cancellation();

    const propertyIds = this.#options.propertyIds;
    const properties: NonNullable<
      Parameters<NotionFamilyInboxSdkClient['pages']['create']>[0]['properties']
    > = {
      [propertyIds.title]: {
        title: textProperty(`Approval: ${safeRequest.action}`),
      },
      [propertyIds.approvalRequestId]: {
        rich_text: textProperty(safeRequest.approvalRequestId),
      },
      [propertyIds.operationId]: {
        rich_text: textProperty(safeRequest.operationId),
      },
      [propertyIds.requestId]: {
        rich_text: textProperty(safeRequest.requestId),
      },
      [propertyIds.requestedBy]: {
        rich_text: textProperty(safeRequest.requestedByDisplayName),
      },
      [propertyIds.action]: {
        rich_text: textProperty(safeRequest.action),
      },
      [propertyIds.safeTargetDescription]: {
        rich_text: textProperty(safeRequest.safeTargetDescription),
      },
      [propertyIds.status]: {
        status: { id: this.#options.statusOptionIds[safeRequest.status] },
      },
    };

    try {
      const response = await callWithCancellation(
        signal,
        () =>
          this.#client.pages.create({
            parent: {
              type: 'data_source_id',
              data_source_id: this.#options.dataSourceId,
            },
            properties,
          }),
        true,
      );
      const responseValue: unknown = response;
      if (
        !isPageResponse(responseValue) ||
        !isFullPage(responseValue) ||
        !pageMatchesDataSource(responseValue, this.#options.dataSourceId) ||
        !approvalIdMatches(
          responseValue,
          propertyIds.approvalRequestId,
          safeRequest.approvalRequestId,
        )
      ) {
        throw new MutationOutcomeUnknown();
      }
      return { providerRecordId: providerRecordId(responseValue.id) };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (isKnownRejectedWrite(error)) throw unavailable();
      throw outcomeUnknown('create', safeRequest.approvalRequestId);
    }
  }

  async update(
    request: UpdateApprovalProjectionRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const safeRequest = parseUpdateRequest(request);
    if (safeRequest === undefined) throw invalidRequest();
    if (signal.aborted) throw cancellation();

    const page = await this.retrieveForUpdate(safeRequest, signal);
    if (
      !pageMatchesDataSource(page, this.#options.dataSourceId) ||
      !approvalIdMatches(
        page,
        this.#options.propertyIds.approvalRequestId,
        safeRequest.approvalRequestId,
      )
    ) {
      throw notFound();
    }

    const propertyIds = this.#options.propertyIds;
    const properties: NonNullable<
      Parameters<NotionFamilyInboxSdkClient['pages']['update']>[0]['properties']
    > = {
      [propertyIds.approvalRequestId]: {
        rich_text: textProperty(safeRequest.approvalRequestId),
      },
      [propertyIds.status]: {
        status: { id: this.#options.statusOptionIds[safeRequest.status] },
      },
      ...(safeRequest.safeResolutionReason === undefined
        ? {}
        : {
            [propertyIds.safeResolutionReason]: {
              rich_text: textProperty(safeRequest.safeResolutionReason),
            },
          }),
    };

    try {
      const response = await callWithCancellation(
        signal,
        () =>
          this.#client.pages.update({
            page_id: safeRequest.providerRecordId,
            properties,
          }),
        true,
      );
      const responseValue: unknown = response;
      if (
        !isPageResponse(responseValue) ||
        !isFullPage(responseValue) ||
        responseValue.id !== safeRequest.providerRecordId ||
        !pageMatchesDataSource(responseValue, this.#options.dataSourceId) ||
        !approvalIdMatches(
          responseValue,
          propertyIds.approvalRequestId,
          safeRequest.approvalRequestId,
        )
      ) {
        throw new MutationOutcomeUnknown();
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (isKnownRejectedWrite(error)) throw unavailable();
      throw outcomeUnknown('update', safeRequest.approvalRequestId);
    }
  }

  private async retrieveForUpdate(
    request: ValidatedUpdateRequest,
    signal: AbortSignal,
  ): Promise<PageObjectResponse> {
    try {
      const response = await callWithCancellation(
        signal,
        () =>
          this.#client.pages.retrieve({
            page_id: request.providerRecordId,
          }),
        false,
      );
      if (!isFullPage(response)) throw unavailable();
      return response;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (isAbortError(error)) throw cancellation();
      if (
        isNotionClientError(error) &&
        error.code === APIErrorCode.ObjectNotFound
      ) {
        throw notFound();
      }
      throw unavailable();
    }
  }
}
