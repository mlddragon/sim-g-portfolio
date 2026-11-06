import {
  APIErrorCode,
  APIResponseError,
  type CreatePageResponse,
  type PageObjectResponse,
  type QueryDataSourceResponse,
  type RichTextItemResponse,
  type UpdatePageResponse,
} from '@notionhq/client';
import { describe, expect, it } from 'vitest';

import {
  NOTION_API_VERSION,
  createOfficialNotionFamilyInboxSdkClient,
  type NotionFamilyInboxSdkClient,
} from '../../../src/adapters/notion/notion-client.js';
import {
  NotionFamilyInboxProjection,
  type NotionFamilyInboxOptions,
} from '../../../src/adapters/notion/notion-family-inbox.js';
import {
  approvalRequestId,
  operationId,
  providerRecordId,
  requestId,
} from '../../../src/domain/identifiers.js';
import type {
  ApprovalStatus,
  SafeApprovalSummary,
} from '../../../src/domain/approvals.js';
import type {
  CreateApprovalProjectionRequest,
  UpdateApprovalProjectionRequest,
} from '../../../src/ports/approval-projection.js';

const inboxDataSourceId = '40000000-0000-4000-8000-000000000001';
const inboxDatabaseId = '40000000-0000-4000-8000-000000000002';
const inboxPageId = '40000000-0000-4000-8000-000000000003';
const otherDataSourceId = '40000000-0000-4000-8000-000000000004';
const syntheticUserId = '40000000-0000-4000-8000-000000000005';

const statusOptionIds: Record<ApprovalStatus, string> = {
  pending: '50000000-0000-4000-8000-000000000001',
  approved: '50000000-0000-4000-8000-000000000002',
  declined: '50000000-0000-4000-8000-000000000003',
  cancelled: '50000000-0000-4000-8000-000000000004',
  superseded: '50000000-0000-4000-8000-000000000005',
  impossible: '50000000-0000-4000-8000-000000000006',
};

function options(): NotionFamilyInboxOptions {
  return {
    dataSourceId: inboxDataSourceId,
    propertyIds: {
      title: 'title',
      approvalRequestId: 'approval_request_id',
      operationId: 'operation_id',
      requestId: 'request_id',
      requestedBy: 'requested_by',
      action: 'action',
      safeTargetDescription: 'safe_target',
      status: 'status',
      safeResolutionReason: 'resolution_reason',
    },
    statusOptionIds: { ...statusOptionIds },
  };
}

const createRequest: CreateApprovalProjectionRequest = {
  approvalRequestId: approvalRequestId('approval_synthetic_001'),
  operationId: operationId('operation_synthetic_001'),
  requestId: requestId('request_synthetic_001'),
  summary: {
    requestedByDisplayName: 'Participant Example',
    action: 'Delete one Family Shared record',
    safeTargetDescription: 'Synthetic astronomy checklist',
  },
  status: 'pending',
};

const updateRequest: UpdateApprovalProjectionRequest = {
  providerRecordId: providerRecordId(inboxPageId),
  approvalRequestId: createRequest.approvalRequestId,
  status: 'approved',
  safeResolutionReason: 'Approved after reviewing the synthetic target.',
};

const findRequest = {
  approvalRequestId: createRequest.approvalRequestId,
  operationId: createRequest.operationId,
  requestId: createRequest.requestId,
};

function richText(content: string): RichTextItemResponse {
  return {
    type: 'text',
    text: { content, link: null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default',
    },
    plain_text: content,
    href: null,
  };
}

function inboxPage(
  approvalId: string = createRequest.approvalRequestId,
  dataSourceId = inboxDataSourceId,
  operationIdValue: string = createRequest.operationId,
  requestIdValue: string = createRequest.requestId,
): PageObjectResponse {
  const user = { object: 'user' as const, id: syntheticUserId };
  return {
    object: 'page',
    id: inboxPageId,
    created_time: '2042-01-02T03:04:05.000Z',
    last_edited_time: '2042-01-03T04:05:06.000Z',
    in_trash: false,
    archived: false,
    is_archived: false,
    is_locked: false,
    url: `https://www.notion.so/${inboxPageId}`,
    public_url: null,
    parent: {
      type: 'data_source_id',
      data_source_id: dataSourceId,
      database_id: inboxDatabaseId,
    },
    properties: {
      'Approval Request ID': {
        id: options().propertyIds.approvalRequestId,
        type: 'rich_text',
        rich_text: [richText(approvalId)],
      },
      'Operation ID': {
        id: options().propertyIds.operationId,
        type: 'rich_text',
        rich_text: [richText(operationIdValue)],
      },
      'Request ID': {
        id: options().propertyIds.requestId,
        type: 'rich_text',
        rich_text: [richText(requestIdValue)],
      },
    },
    icon: null,
    cover: null,
    created_by: user,
    last_edited_by: user,
  };
}

interface SyntheticSdkOptions {
  readonly apiVersion?: string;
  readonly createResult?: CreatePageResponse;
  readonly createOverride?: NotionFamilyInboxSdkClient['pages']['create'];
  readonly retrieveResult?: PageObjectResponse;
  readonly retrieveOverride?: NotionFamilyInboxSdkClient['pages']['retrieve'];
  readonly updateResult?: UpdatePageResponse;
  readonly updateOverride?: NotionFamilyInboxSdkClient['pages']['update'];
  readonly createFailure?: Error;
  readonly retrieveFailure?: Error;
  readonly updateFailure?: Error;
  readonly queryResult?: QueryDataSourceResponse;
  readonly queryFailure?: Error;
}

class SyntheticInboxSdk implements NotionFamilyInboxSdkClient {
  readonly apiVersion: string;
  readonly createCalls: Array<
    Parameters<NotionFamilyInboxSdkClient['pages']['create']>[0]
  > = [];
  readonly retrieveCalls: Array<
    Parameters<NotionFamilyInboxSdkClient['pages']['retrieve']>[0]
  > = [];
  readonly updateCalls: Array<
    Parameters<NotionFamilyInboxSdkClient['pages']['update']>[0]
  > = [];
  readonly queryCalls: Array<
    Parameters<NotionFamilyInboxSdkClient['dataSources']['query']>[0]
  > = [];
  readonly #options: SyntheticSdkOptions;

  constructor(sdkOptions: SyntheticSdkOptions = {}) {
    this.apiVersion = sdkOptions.apiVersion ?? NOTION_API_VERSION;
    this.#options = sdkOptions;
  }

  readonly pages: NotionFamilyInboxSdkClient['pages'] = {
    create: (args) => {
      this.createCalls.push(args);
      if (this.#options.createOverride !== undefined) {
        return this.#options.createOverride(args);
      }
      if (this.#options.createFailure !== undefined) {
        return Promise.reject(this.#options.createFailure);
      }
      return Promise.resolve(this.#options.createResult ?? inboxPage());
    },
    retrieve: (args) => {
      this.retrieveCalls.push(args);
      if (this.#options.retrieveOverride !== undefined) {
        return this.#options.retrieveOverride(args);
      }
      if (this.#options.retrieveFailure !== undefined) {
        return Promise.reject(this.#options.retrieveFailure);
      }
      return Promise.resolve(this.#options.retrieveResult ?? inboxPage());
    },
    update: (args) => {
      this.updateCalls.push(args);
      if (this.#options.updateOverride !== undefined) {
        return this.#options.updateOverride(args);
      }
      if (this.#options.updateFailure !== undefined) {
        return Promise.reject(this.#options.updateFailure);
      }
      return Promise.resolve(this.#options.updateResult ?? inboxPage());
    },
  };

  readonly dataSources: NotionFamilyInboxSdkClient['dataSources'] = {
    query: (args) => {
      this.queryCalls.push(args);
      // Notion 2026-03-11 rejects in_trash in a data source query body.
      if ('in_trash' in args) {
        return Promise.reject(new TypeError('synthetic_in_trash_rejected'));
      }
      if (this.#options.queryFailure !== undefined) {
        return Promise.reject(this.#options.queryFailure);
      }
      return Promise.resolve(
        this.#options.queryResult ?? {
          object: 'list',
          type: 'page_or_data_source',
          page_or_data_source: {},
          next_cursor: null,
          has_more: false,
          results: [],
        },
      );
    },
  };
}

function projection(
  sdk = new SyntheticInboxSdk(),
): NotionFamilyInboxProjection {
  return new NotionFamilyInboxProjection(sdk, options());
}

function textValue(content: string) {
  return [{ type: 'text', text: { content } }];
}

describe('Notion Family Inbox projection', () => {
  it('finds an existing stable approval projection before retrying create', async () => {
    const sdk = new SyntheticInboxSdk({
      queryResult: {
        object: 'list',
        type: 'page_or_data_source',
        page_or_data_source: {},
        next_cursor: null,
        has_more: false,
        results: [inboxPage()],
      },
    });

    await expect(
      projection(sdk).findByApprovalRequestId(
        findRequest,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ providerRecordId: inboxPageId });
    expect(sdk.queryCalls).toEqual([
      {
        data_source_id: inboxDataSourceId,
        page_size: 2,
        result_type: 'page',
        filter: {
          property: options().propertyIds.approvalRequestId,
          rich_text: { equals: createRequest.approvalRequestId },
        },
      },
    ]);
  });

  it('fails closed when the stable approval id has duplicate projections', async () => {
    const sdk = new SyntheticInboxSdk({
      queryResult: {
        object: 'list',
        type: 'page_or_data_source',
        page_or_data_source: {},
        next_cursor: null,
        has_more: false,
        results: [
          inboxPage(),
          { ...inboxPage(), id: '40000000-0000-4000-8000-000000000006' },
        ],
      },
    });

    await expect(
      projection(sdk).findByApprovalRequestId(
        findRequest,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      details: { reason: 'approval_projection_duplicate' },
    });
  });

  it('rejects a projection whose stable approval id has mismatched operation correlation', async () => {
    const sdk = new SyntheticInboxSdk({
      queryResult: {
        object: 'list',
        type: 'page_or_data_source',
        page_or_data_source: {},
        next_cursor: null,
        has_more: false,
        results: [
          inboxPage(
            createRequest.approvalRequestId,
            inboxDataSourceId,
            'operation_other_request',
          ),
        ],
      },
    });

    await expect(
      projection(sdk).findByApprovalRequestId(
        findRequest,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      details: { reason: 'notion_family_inbox_request_failed' },
    });
  });

  it('creates one safe page under the exact configured data source', async () => {
    const sdk = new SyntheticInboxSdk();

    await expect(
      projection(sdk).create(createRequest, new AbortController().signal),
    ).resolves.toEqual({ providerRecordId: inboxPageId });

    expect(sdk.createCalls).toEqual([
      {
        parent: {
          type: 'data_source_id',
          data_source_id: inboxDataSourceId,
        },
        properties: {
          title: {
            title: textValue('Approval: Delete one Family Shared record'),
          },
          approval_request_id: {
            rich_text: textValue('approval_synthetic_001'),
          },
          operation_id: {
            rich_text: textValue('operation_synthetic_001'),
          },
          request_id: {
            rich_text: textValue('request_synthetic_001'),
          },
          requested_by: { rich_text: textValue('Participant Example') },
          action: {
            rich_text: textValue('Delete one Family Shared record'),
          },
          safe_target: {
            rich_text: textValue('Synthetic astronomy checklist'),
          },
          status: { status: { id: statusOptionIds.pending } },
        },
      },
    ]);
  });

  it.each(Object.keys(statusOptionIds) as ApprovalStatus[])(
    'maps the %s domain status to its configured option ID',
    async (status) => {
      const sdk = new SyntheticInboxSdk();
      await projection(sdk).create(
        { ...createRequest, status },
        new AbortController().signal,
      );

      expect(sdk.createCalls[0]?.properties?.['status']).toEqual({
        status: { id: statusOptionIds[status] },
      });
    },
  );

  it('rejects extra runtime fields before provider I/O', async () => {
    const sdk = new SyntheticInboxSdk();
    const privatePayload = 'SYNTHETIC_PARENT_ONLY_PAYLOAD';
    const invalid = {
      ...createRequest,
      providerPayload: privatePayload,
    } as never;

    const error = await projection(sdk)
      .create(invalid, new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'invalid_request',
      retryable: false,
      details: { reason: 'invalid_family_inbox_projection_request' },
    });
    expect(JSON.stringify(error)).not.toContain(privatePayload);
    expect(sdk.createCalls).toHaveLength(0);
  });

  it.each<readonly [keyof SafeApprovalSummary, string]>([
    ['requestedByDisplayName', 'x'.repeat(129)],
    ['action', 'x'.repeat(257)],
    ['safeTargetDescription', 'x'.repeat(1_001)],
  ])('rejects an oversized %s before provider I/O', async (field, value) => {
    const sdk = new SyntheticInboxSdk();

    await expect(
      projection(sdk).create(
        {
          ...createRequest,
          summary: { ...createRequest.summary, [field]: value },
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
    expect(sdk.createCalls).toHaveLength(0);
  });

  it('snapshots the exact data source, property IDs, and status IDs', async () => {
    const sdk = new SyntheticInboxSdk();
    const mutableOptions = options();
    const originalActionPropertyId = mutableOptions.propertyIds.action;
    const originalApprovedStatusId = mutableOptions.statusOptionIds.approved;
    const inbox = new NotionFamilyInboxProjection(sdk, mutableOptions);

    (mutableOptions as { dataSourceId: string }).dataSourceId =
      otherDataSourceId;
    (mutableOptions.propertyIds as { action: string }).action =
      'mutated_action';
    (mutableOptions.statusOptionIds as { approved: string }).approved =
      'mutated_status';

    await inbox.create(
      { ...createRequest, status: 'approved' },
      new AbortController().signal,
    );

    expect(sdk.createCalls[0]?.parent).toEqual({
      type: 'data_source_id',
      data_source_id: inboxDataSourceId,
    });
    expect(sdk.createCalls[0]?.properties).toHaveProperty(
      originalActionPropertyId,
    );
    expect(sdk.createCalls[0]?.properties?.['status']).toEqual({
      status: { id: originalApprovedStatusId },
    });
  });

  it('rejects duplicate property IDs and incomplete status configuration', () => {
    const duplicateProperties = options();
    (
      duplicateProperties.propertyIds as {
        operationId: string;
      }
    ).operationId = duplicateProperties.propertyIds.requestId;

    expect(
      () =>
        new NotionFamilyInboxProjection(
          new SyntheticInboxSdk(),
          duplicateProperties,
        ),
    ).toThrow('invalid_notion_family_inbox_configuration');

    const missingStatus = options();
    delete (missingStatus.statusOptionIds as { impossible?: string })
      .impossible;
    expect(
      () =>
        new NotionFamilyInboxProjection(new SyntheticInboxSdk(), missingStatus),
    ).toThrow('invalid_notion_family_inbox_configuration');
  });

  it('rejects an SDK client not tagged for the pinned API version', () => {
    expect(
      () =>
        new NotionFamilyInboxProjection(
          new SyntheticInboxSdk({ apiVersion: '2025-09-03' }),
          options(),
        ),
    ).toThrow('invalid_notion_family_inbox_configuration');
  });

  it('verifies the exact Inbox parent and approval ID before updating', async () => {
    const sdk = new SyntheticInboxSdk();

    await expect(
      projection(sdk).update(updateRequest, new AbortController().signal),
    ).resolves.toBeUndefined();

    expect(sdk.retrieveCalls).toEqual([{ page_id: inboxPageId }]);
    expect(sdk.updateCalls).toEqual([
      {
        page_id: inboxPageId,
        properties: {
          approval_request_id: {
            rich_text: textValue('approval_synthetic_001'),
          },
          status: { status: { id: statusOptionIds.approved } },
          resolution_reason: {
            rich_text: textValue(
              'Approved after reviewing the synthetic target.',
            ),
          },
        },
      },
    ]);
  });

  it.each([
    [
      'a different data source',
      inboxPage('approval_synthetic_001', otherDataSourceId),
    ],
    ['a different approval', inboxPage('approval_synthetic_999')],
    ['a trashed projection', { ...inboxPage(), in_trash: true }],
  ])('does not update %s', async (_description, retrieved) => {
    const sdk = new SyntheticInboxSdk({ retrieveResult: retrieved });

    await expect(
      projection(sdk).update(updateRequest, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'not_found',
      retryable: false,
      details: { reason: 'approval_projection_not_found' },
    });
    expect(sdk.updateCalls).toHaveLength(0);
  });

  it('omits an absent optional resolution reason instead of clearing it', async () => {
    const sdk = new SyntheticInboxSdk();
    await projection(sdk).update(
      { ...updateRequest, safeResolutionReason: undefined } as never,
      new AbortController().signal,
    );

    expect(sdk.updateCalls[0]?.properties).toEqual({
      approval_request_id: {
        rich_text: textValue('approval_synthetic_001'),
      },
      status: { status: { id: statusOptionIds.approved } },
    });
  });

  it('rejects an oversized resolution reason before reading or updating Notion', async () => {
    const sdk = new SyntheticInboxSdk();

    await expect(
      projection(sdk).update(
        { ...updateRequest, safeResolutionReason: 'x'.repeat(1_001) },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
    expect(sdk.retrieveCalls).toHaveLength(0);
    expect(sdk.updateCalls).toHaveLength(0);
  });

  it('maps a known provider rejection without exposing its response', async () => {
    const privateFailure = 'SYNTHETIC_PRIVATE_RATE_LIMIT_BODY';
    const sdk = new SyntheticInboxSdk({
      createFailure: new APIResponseError({
        code: APIErrorCode.RateLimited,
        status: 429,
        message: privateFailure,
        headers: { 'retry-after': '1' },
        rawBodyText: privateFailure,
        additional_data: undefined,
        request_id: 'synthetic-private-provider-request-id',
      }),
    });

    const error = await projection(sdk)
      .create(createRequest, new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'notion_family_inbox_request_failed' },
    });
    expect(String(error)).not.toContain(privateFailure);
    expect(JSON.stringify(error)).not.toContain(privateFailure);
    expect(sdk.createCalls).toHaveLength(1);
  });

  it('marks an ambiguous create failure outcome unknown and never retries it', async () => {
    const privateFailure = 'SYNTHETIC_PRIVATE_CREATE_FAILURE';
    const sdk = new SyntheticInboxSdk({
      createFailure: new Error(privateFailure),
    });

    const error = await projection(sdk)
      .create(createRequest, new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'outcome_unknown',
      retryable: false,
      details: {
        reason: 'notion_family_inbox_create_outcome_unknown',
        approvalRequestId: 'approval_synthetic_001',
      },
    });
    expect(String(error)).not.toContain(privateFailure);
    expect(JSON.stringify(error)).not.toContain(privateFailure);
    expect(sdk.createCalls).toHaveLength(1);
  });

  it.each([
    ['a partial response', { object: 'page' as const, id: inboxPageId }],
    [
      'a mismatched parent',
      inboxPage(createRequest.approvalRequestId, otherDataSourceId),
    ],
    ['a mismatched approval ID', inboxPage('approval_synthetic_999')],
  ])(
    'does not report create success from %s',
    async (_description, createResult) => {
      const sdk = new SyntheticInboxSdk({ createResult });

      await expect(
        projection(sdk).create(createRequest, new AbortController().signal),
      ).rejects.toMatchObject({
        code: 'outcome_unknown',
        retryable: false,
      });
      expect(sdk.createCalls).toHaveLength(1);
    },
  );

  it('marks an ambiguous update failure outcome unknown and never retries it', async () => {
    const sdk = new SyntheticInboxSdk({
      updateFailure: new Error('SYNTHETIC_PRIVATE_UPDATE_FAILURE'),
    });

    await expect(
      projection(sdk).update(updateRequest, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'outcome_unknown',
      retryable: false,
      details: {
        reason: 'notion_family_inbox_update_outcome_unknown',
        approvalRequestId: 'approval_synthetic_001',
      },
    });
    expect(sdk.updateCalls).toHaveLength(1);
  });

  it.each([
    ['a partial response', { object: 'page' as const, id: inboxPageId }],
    [
      'a mismatched parent',
      inboxPage(createRequest.approvalRequestId, otherDataSourceId),
    ],
    ['a mismatched approval ID', inboxPage('approval_synthetic_999')],
  ])(
    'does not report update success from %s',
    async (_description, updateResult) => {
      const sdk = new SyntheticInboxSdk({ updateResult });

      await expect(
        projection(sdk).update(updateRequest, new AbortController().signal),
      ).rejects.toMatchObject({
        code: 'outcome_unknown',
        retryable: false,
      });
      expect(sdk.updateCalls).toHaveLength(1);
    },
  );

  it('maps safe read failures before update without issuing a mutation', async () => {
    const privateFailure = 'SYNTHETIC_PRIVATE_RETRIEVE_FAILURE';
    const sdk = new SyntheticInboxSdk({
      retrieveFailure: new Error(privateFailure),
    });

    const error = await projection(sdk)
      .update(updateRequest, new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'notion_family_inbox_request_failed' },
    });
    expect(JSON.stringify(error)).not.toContain(privateFailure);
    expect(sdk.updateCalls).toHaveLength(0);
  });

  it('does no provider I/O when cancelled before create', async () => {
    const sdk = new SyntheticInboxSdk();
    const controller = new AbortController();
    controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));

    await expect(
      projection(sdk).create(createRequest, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(sdk.createCalls).toHaveLength(0);
  });

  it('returns outcome_unknown when cancellation races an in-flight create', async () => {
    let settle: ((response: CreatePageResponse) => void) | undefined;
    const pending = new Promise<CreatePageResponse>((resolve) => {
      settle = resolve;
    });
    const sdk = new SyntheticInboxSdk({ createOverride: () => pending });
    const controller = new AbortController();
    const result = projection(sdk).create(createRequest, controller.signal);

    await Promise.resolve();
    controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));

    await expect(result).rejects.toMatchObject({
      code: 'outcome_unknown',
      retryable: false,
    });
    expect(sdk.createCalls).toHaveLength(1);
    settle?.({ object: 'page', id: inboxPageId });
  });

  it('returns AbortError when cancellation races the read guard before update', async () => {
    let settle: ((response: PageObjectResponse) => void) | undefined;
    const pending = new Promise<PageObjectResponse>((resolve) => {
      settle = resolve;
    });
    const sdk = new SyntheticInboxSdk({ retrieveOverride: () => pending });
    const controller = new AbortController();
    const result = projection(sdk).update(updateRequest, controller.signal);

    await Promise.resolve();
    controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(sdk.updateCalls).toHaveLength(0);
    settle?.(inboxPage());
  });

  it('returns outcome_unknown when cancellation races an in-flight update', async () => {
    let settle: ((response: UpdatePageResponse) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<UpdatePageResponse>((resolve) => {
      settle = resolve;
    });
    const sdk = new SyntheticInboxSdk({
      updateOverride: () => {
        markStarted?.();
        return pending;
      },
    });
    const controller = new AbortController();
    const result = projection(sdk).update(updateRequest, controller.signal);

    await started;
    controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));

    await expect(result).rejects.toMatchObject({
      code: 'outcome_unknown',
      retryable: false,
    });
    expect(sdk.updateCalls).toHaveLength(1);
    settle?.(inboxPage());
  });

  it('exposes only the exact official SDK methods required by the Inbox adapter', async () => {
    let requestUrl = '';
    let requestMethod: string | undefined;
    let requestHeaders: Readonly<Record<string, string>> | undefined;
    const sdk = createOfficialNotionFamilyInboxSdkClient({
      auth: 'synthetic-notion-token',
      fetch: (url, init) => {
        requestUrl = url;
        requestMethod = init?.method;
        requestHeaders = init?.headers;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: () =>
            Promise.resolve(
              JSON.stringify({ object: 'page', id: inboxPageId }),
            ),
        });
      },
    });

    await sdk.pages.create({
      parent: { type: 'data_source_id', data_source_id: inboxDataSourceId },
      properties: {},
    });

    expect(Object.keys(sdk)).toEqual(['apiVersion', 'pages', 'dataSources']);
    expect(Object.keys(sdk.pages)).toEqual(['create', 'retrieve', 'update']);
    expect(Object.keys(sdk.dataSources)).toEqual(['query']);
    expect(Object.isFrozen(sdk)).toBe(true);
    expect(Object.isFrozen(sdk.dataSources)).toBe(true);
    expect(Object.isFrozen(sdk.pages)).toBe(true);
    expect(requestUrl).toMatch(/\/v1\/pages$/u);
    expect(requestMethod).toBe('POST');
    expect(requestHeaders?.['Notion-Version']).toBe(NOTION_API_VERSION);
  });

  it('does not automatically retry an official create request', async () => {
    let fetchCalls = 0;
    const sdk = createOfficialNotionFamilyInboxSdkClient({
      auth: 'synthetic-notion-token',
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: {},
          text: () =>
            Promise.resolve(
              JSON.stringify({
                object: 'error',
                status: 503,
                code: 'service_unavailable',
                message: 'SYNTHETIC_PRIVATE_PROVIDER_FAILURE',
              }),
            ),
        });
      },
    });

    await expect(
      sdk.pages.create({
        parent: { type: 'data_source_id', data_source_id: inboxDataSourceId },
        properties: {},
      }),
    ).rejects.toMatchObject({ code: APIErrorCode.ServiceUnavailable });
    expect(fetchCalls).toBe(1);
  });
});
