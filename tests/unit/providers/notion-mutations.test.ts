import { createHash } from 'node:crypto';

import type {
  PageObjectResponse,
  QueryDataSourceResponse,
  RichTextItemResponse,
} from '@notionhq/client';
import { APIErrorCode, APIResponseError } from '@notionhq/client';
import { describe, expect, it, vi } from 'vitest';

import {
  NOTION_API_VERSION,
  createOfficialNotionMutationSdkClient,
  type NotionMutationSdkClient,
  type NotionRetrievalClient,
} from '../../../src/adapters/notion/notion-client.js';
import {
  NotionMutableKnowledgeProvider,
  type NotionMutationTarget,
} from '../../../src/adapters/notion/notion-mutations.js';
import type { NotionGovernedRoot } from '../../../src/adapters/notion/notion-scope-guard.js';
import {
  operationId,
  providerRecordId,
} from '../../../src/domain/identifiers.js';

const createdTime = '2042-01-02T03:04:05.000Z';
const updatedTime = '2042-01-03T04:05:06.000Z';
const markerTime = '2042-01-03T04:05:07.000Z';
const finalTime = '2042-01-03T04:05:08.000Z';
const dataSourceId = '10000000-0000-4000-8000-000000000001';
const databaseId = '10000000-0000-4000-8000-000000000002';
const createdPageId = '10000000-0000-4000-8000-000000000101';
const existingPageId = '10000000-0000-4000-8000-000000000102';
const rootRef = 'notion://development/family-shared-records';
const titlePropertyId = 'title';
const operationMarkerPropertyId = 'gateway_operation';
const contentTypePropertyId = 'gateway_content_type';
const contentHashPropertyId = 'gateway_content_hash';

const user = {
  object: 'user',
  id: '20000000-0000-4000-8000-000000000001',
} as const;

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

interface PageFixtureOptions {
  readonly id?: string;
  readonly title?: string;
  readonly marker?: string;
  readonly contentType?: string;
  readonly contentHash?: string;
  readonly version?: string;
  readonly dataSource?: string;
  readonly inTrash?: boolean;
}

function recordPage(options: PageFixtureOptions = {}): PageObjectResponse {
  return {
    object: 'page',
    id: options.id ?? existingPageId,
    created_time: createdTime,
    last_edited_time: options.version ?? updatedTime,
    in_trash: options.inTrash ?? false,
    archived: options.inTrash ?? false,
    is_archived: options.inTrash ?? false,
    is_locked: false,
    url: `https://www.notion.so/${options.id ?? existingPageId}`,
    public_url: null,
    parent: {
      type: 'data_source_id',
      data_source_id: options.dataSource ?? dataSourceId,
      database_id: databaseId,
    },
    properties: {
      title: {
        id: titlePropertyId,
        type: 'title',
        title: [richText(options.title ?? 'Synthetic original title')],
      },
      operationMarker: {
        id: operationMarkerPropertyId,
        type: 'rich_text',
        rich_text: [richText(options.marker ?? 'create:op_notion_previous')],
      },
      contentType: {
        id: contentTypePropertyId,
        type: 'rich_text',
        rich_text: [richText(options.contentType ?? 'text/markdown')],
      },
      contentHash: {
        id: contentHashPropertyId,
        type: 'rich_text',
        rich_text: [
          richText(
            options.contentHash ??
              '9fa9837497002b4b09268975deddf109b4304ccc8a8af774dc9cec531af32b43',
          ),
        ],
      },
    },
    icon: null,
    cover: null,
    created_by: user,
    last_edited_by: user,
  };
}

function pageFromCreate(): PageObjectResponse {
  return recordPage({
    id: createdPageId,
    title: 'Synthetic created knowledge',
    marker: 'create:op_notion_create_001',
    contentType: 'text/plain',
    contentHash:
      '26634d02b614a03105575b66ae57aa331c30b5406342a01c9aa96b6a6808f3ea',
  });
}

function emptyQuery(): QueryDataSourceResponse {
  return {
    type: 'page_or_data_source',
    page_or_data_source: {},
    object: 'list',
    next_cursor: null,
    has_more: false,
    results: [],
    request_status: { type: 'complete' },
  };
}

function queryWith(...pages: PageObjectResponse[]): QueryDataSourceResponse {
  return { ...emptyQuery(), results: pages };
}

function markdownResponse(
  markdown: string,
  id = existingPageId,
): Awaited<ReturnType<NotionMutationSdkClient['pages']['retrieveMarkdown']>> {
  return {
    object: 'page_markdown',
    id,
    markdown,
    truncated: false,
    unknown_block_ids: [],
  };
}

function textProperty(content: string) {
  return [{ type: 'text' as const, text: { content } }];
}

interface SyntheticMutationSdkOptions {
  readonly apiVersion?: string;
  readonly createResult?: ReturnType<
    NotionMutationSdkClient['pages']['create']
  >;
  readonly queryResult?: ReturnType<
    NotionMutationSdkClient['dataSources']['query']
  >;
  readonly queryResults?: readonly ReturnType<
    NotionMutationSdkClient['dataSources']['query']
  >[];
  readonly retrieveResults?: readonly ReturnType<
    NotionMutationSdkClient['pages']['retrieve']
  >[];
  readonly updateResults?: readonly ReturnType<
    NotionMutationSdkClient['pages']['update']
  >[];
  readonly markdownResults?: readonly ReturnType<
    NotionMutationSdkClient['pages']['retrieveMarkdown']
  >[];
  readonly markdownUpdateResults?: readonly ReturnType<
    NotionMutationSdkClient['pages']['updateMarkdown']
  >[];
}

class SyntheticMutationSdk
  implements NotionMutationSdkClient, NotionRetrievalClient
{
  readonly apiVersion: string;
  readonly createCalls: Array<
    Parameters<NotionMutationSdkClient['pages']['create']>[0]
  > = [];
  readonly queryCalls: Array<
    Parameters<NotionMutationSdkClient['dataSources']['query']>[0]
  > = [];
  readonly retrieveCalls: Array<
    Parameters<NotionMutationSdkClient['pages']['retrieve']>[0]
  > = [];
  readonly updateCalls: Array<
    Parameters<NotionMutationSdkClient['pages']['update']>[0]
  > = [];
  readonly markdownRetrieveCalls: Array<
    Parameters<NotionMutationSdkClient['pages']['retrieveMarkdown']>[0]
  > = [];
  readonly markdownUpdateCalls: Array<
    Parameters<NotionMutationSdkClient['pages']['updateMarkdown']>[0]
  > = [];
  readonly #options: SyntheticMutationSdkOptions;
  #retrieveIndex = 0;
  #updateIndex = 0;
  #markdownIndex = 0;
  #markdownUpdateIndex = 0;
  #queryIndex = 0;

  constructor(options: SyntheticMutationSdkOptions = {}) {
    this.apiVersion = options.apiVersion ?? NOTION_API_VERSION;
    this.#options = options;
  }

  readonly pages: NotionMutationSdkClient['pages'] = {
    create: async (args) => {
      this.createCalls.push(args);
      return await (this.#options.createResult ??
        Promise.resolve(pageFromCreate()));
    },
    retrieve: async (args) => {
      this.retrieveCalls.push(args);
      const result = this.#options.retrieveResults?.[this.#retrieveIndex];
      this.#retrieveIndex += 1;
      return await (result ?? Promise.resolve(recordPage()));
    },
    update: async (args) => {
      this.updateCalls.push(args);
      const result = this.#options.updateResults?.[this.#updateIndex];
      this.#updateIndex += 1;
      return await (result ?? Promise.resolve(recordPage()));
    },
    retrieveMarkdown: async (args) => {
      this.markdownRetrieveCalls.push(args);
      const result = this.#options.markdownResults?.[this.#markdownIndex];
      this.#markdownIndex += 1;
      return await (result ??
        Promise.resolve(
          args.page_id === createdPageId
            ? markdownResponse('Synthetic created body.', createdPageId)
            : markdownResponse('Synthetic original body.'),
        ));
    },
    updateMarkdown: async (args) => {
      this.markdownUpdateCalls.push(args);
      const result =
        this.#options.markdownUpdateResults?.[this.#markdownUpdateIndex];
      this.#markdownUpdateIndex += 1;
      return await (result ??
        Promise.resolve(markdownResponse('Synthetic replacement body.')));
    },
  };

  readonly dataSources: NotionMutationSdkClient['dataSources'] = {
    query: async (args) => {
      this.queryCalls.push(args);
      // Notion 2026-03-11 rejects in_trash in a data source query body.
      if ('in_trash' in args)
        throw new TypeError('synthetic_in_trash_rejected');
      const result = this.#options.queryResults?.[this.#queryIndex];
      this.#queryIndex += 1;
      return await (result ??
        this.#options.queryResult ??
        Promise.resolve(emptyQuery()));
    },
  };

  searchPages(): ReturnType<NotionRetrievalClient['searchPages']> {
    return Promise.resolve({ pages: [], hasMore: false, sourceComplete: true });
  }

  async retrievePage(
    pageId: string,
  ): ReturnType<NotionRetrievalClient['retrievePage']> {
    const page = await this.pages.retrieve({ page_id: pageId });
    if (!('created_time' in page)) throw new Error('synthetic partial page');
    return {
      id: page.id,
      title: 'Synthetic original title',
      createdTime: page.created_time,
      updatedTime: page.last_edited_time,
      inTrash: page.in_trash,
      parent:
        page.parent.type === 'data_source_id'
          ? { kind: 'data_source', id: page.parent.data_source_id }
          : { kind: 'terminal' },
    };
  }

  retrieveParent(): ReturnType<NotionRetrievalClient['retrieveParent']> {
    return Promise.resolve({ kind: 'terminal' });
  }

  listBlockChildren(): ReturnType<NotionRetrievalClient['listBlockChildren']> {
    return Promise.resolve({ blocks: [], hasMore: false });
  }
}

const governedRoot: NotionGovernedRoot = {
  rootRef,
  notionObject: { kind: 'data_source', id: dataSourceId },
  displayPath: 'Family Shared / Structured Records',
  policy: {
    scope: 'family_shared',
    sensitivity: 'family_shared',
    protectedClass: 'none',
  },
};

const mutationTarget: NotionMutationTarget = {
  rootRef,
  propertyIds: {
    title: titlePropertyId,
    operationMarker: operationMarkerPropertyId,
    contentType: contentTypePropertyId,
    contentHash: contentHashPropertyId,
  },
};

const authorizedAccess = {
  brainScopes: ['family_shared'] as const,
  rootRefs: [rootRef],
};

function provider(sdk = new SyntheticMutationSdk()) {
  return new NotionMutableKnowledgeProvider(sdk, sdk, {
    roots: [governedRoot],
    mutationTargets: [mutationTarget],
  });
}

function routedCreateRequest() {
  return {
    operationId: operationId('op_notion_create_001'),
    access: authorizedAccess,
    title: 'Synthetic created knowledge',
    content: 'Synthetic created body.',
    contentType: 'text/plain',
    canonicalLocation: {
      provider: 'notion' as const,
      containerRef: rootRef,
    },
    policy: governedRoot.policy,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function routedUpdateRequest() {
  return {
    operationId: operationId('op_notion_update_001'),
    access: authorizedAccess,
    providerRecordId: providerRecordId(existingPageId),
    expectedProviderVersion: updatedTime,
    mutation: {
      mode: 'replace' as const,
      replacement: { content: 'Synthetic replacement body.' },
    },
  };
}

function routedAppendRequest(content = '\nSynthetic appended body.') {
  return {
    operationId: operationId('op_notion_append_001'),
    access: authorizedAccess,
    providerRecordId: providerRecordId(existingPageId),
    expectedProviderVersion: updatedTime,
    content,
  };
}

function routedTrashRequest() {
  return {
    operationId: operationId('op_notion_trash_001'),
    access: authorizedAccess,
    providerRecordId: providerRecordId(existingPageId),
    expectedProviderVersion: updatedTime,
  };
}

describe('governed Notion record mutations', () => {
  it('creates one synchronous markdown page in the exact routed data source with a stable operation marker', async () => {
    const sdk = new SyntheticMutationSdk();
    const result = await provider(sdk).create(
      routedCreateRequest(),
      new AbortController().signal,
    );

    expect(sdk.queryCalls).toEqual([
      {
        data_source_id: dataSourceId,
        page_size: 2,
        result_type: 'page',
        filter: {
          property: operationMarkerPropertyId,
          rich_text: { equals: 'create:op_notion_create_001' },
        },
      },
    ]);
    expect(sdk.createCalls).toEqual([
      {
        parent: {
          type: 'data_source_id',
          data_source_id: dataSourceId,
        },
        properties: {
          [titlePropertyId]: {
            title: textProperty('Synthetic created knowledge'),
          },
          [operationMarkerPropertyId]: {
            rich_text: textProperty('create:op_notion_create_001'),
          },
          [contentTypePropertyId]: {
            rich_text: textProperty('text/plain'),
          },
          [contentHashPropertyId]: {
            rich_text: textProperty(
              '26634d02b614a03105575b66ae57aa331c30b5406342a01c9aa96b6a6808f3ea',
            ),
          },
        },
        markdown: 'Synthetic created body.',
        allow_async: false,
      },
    ]);
    expect(result).toEqual({
      outcome: 'completed',
      record: {
        provider: 'notion',
        providerRecordId: createdPageId,
        providerVersion: updatedTime,
        canonicalLocation: {
          provider: 'notion',
          containerRef: rootRef,
          displayPath:
            'Family Shared / Structured Records / Synthetic created knowledge',
        },
        integrityHash:
          '26634d02b614a03105575b66ae57aa331c30b5406342a01c9aa96b6a6808f3ea',
      },
    });
    expect(JSON.stringify(result)).not.toContain('providerRawObject');
  });

  it('does not report create completed until the stored complete markdown matches its hash', async () => {
    const sdk = new SyntheticMutationSdk({
      markdownResults: [
        Promise.resolve(
          markdownResponse('Synthetic normalized differently.', createdPageId),
        ),
      ],
    });

    const result = await provider(sdk).create(
      routedCreateRequest(),
      new AbortController().signal,
    );

    expect(result).toMatchObject({ outcome: 'unknown' });
    expect(sdk.markdownRetrieveCalls).toEqual([
      { page_id: createdPageId, include_transcript: false },
    ]);
  });

  it('re-checks version and scope before replacing title and markdown content', async () => {
    const marker = 'update:op_notion_update_001';
    const finalHash =
      '04ace105c9530634181f698bcd72b00940132c8ddd0dcc94a7d1a347e84c55d8';
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage()),
        Promise.resolve(recordPage()),
        Promise.resolve(
          recordPage({
            title: 'Synthetic updated title',
            marker,
            contentHash: finalHash,
            version: finalTime,
          }),
        ),
      ],
      updateResults: [
        Promise.resolve(
          recordPage({
            title: 'Synthetic updated title',
            marker,
            contentHash: finalHash,
            version: markerTime,
          }),
        ),
      ],
      markdownResults: [
        Promise.resolve(markdownResponse('Synthetic original body.')),
      ],
      markdownUpdateResults: [
        Promise.resolve(markdownResponse('Synthetic replacement body.')),
      ],
    });

    const result = await provider(sdk).update(
      {
        operationId: operationId('op_notion_update_001'),
        access: authorizedAccess,
        providerRecordId: providerRecordId(existingPageId),
        expectedProviderVersion: updatedTime,
        mutation: {
          mode: 'patch',
          patch: {
            title: 'Synthetic updated title',
            content: 'Synthetic replacement body.',
          },
        },
      },
      new AbortController().signal,
    );

    expect(sdk.retrieveCalls).toEqual([
      { page_id: existingPageId },
      { page_id: existingPageId },
      { page_id: existingPageId },
    ]);
    expect(sdk.markdownRetrieveCalls).toEqual([
      { page_id: existingPageId, include_transcript: false },
    ]);
    expect(sdk.updateCalls).toEqual([
      {
        page_id: existingPageId,
        properties: {
          [titlePropertyId]: {
            title: textProperty('Synthetic updated title'),
          },
          [operationMarkerPropertyId]: {
            rich_text: textProperty(marker),
          },
          [contentTypePropertyId]: {
            rich_text: textProperty('text/markdown'),
          },
          [contentHashPropertyId]: {
            rich_text: textProperty(finalHash),
          },
        },
      },
    ]);
    expect(sdk.markdownUpdateCalls).toEqual([
      {
        page_id: existingPageId,
        type: 'replace_content',
        replace_content: {
          new_str: 'Synthetic replacement body.',
          allow_deleting_content: true,
        },
        allow_async: false,
      },
    ]);
    expect(result).toMatchObject({
      outcome: 'completed',
      record: {
        provider: 'notion',
        providerRecordId: existingPageId,
        providerVersion: finalTime,
        integrityHash: finalHash,
        canonicalLocation: {
          provider: 'notion',
          containerRef: rootRef,
          displayPath:
            'Family Shared / Structured Records / Synthetic updated title',
        },
      },
    });
  });

  it('re-checks the provider version after reading markdown and before update dispatch', async () => {
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage()),
        Promise.resolve(recordPage({ version: finalTime })),
      ],
      markdownResults: [
        Promise.resolve(markdownResponse('Synthetic original body.')),
      ],
    });

    await expect(
      provider(sdk).update(routedUpdateRequest(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
      details: { reason: 'provider_version_mismatch' },
    });
    expect(sdk.updateCalls).toHaveLength(0);
    expect(sdk.markdownUpdateCalls).toHaveLength(0);
  });

  it('re-checks the governed root after reading markdown and before append dispatch', async () => {
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage()),
        Promise.resolve(recordPage({ dataSource: databaseId })),
      ],
      markdownResults: [
        Promise.resolve(markdownResponse('Synthetic original body.')),
      ],
    });

    await expect(
      provider(sdk).append(routedAppendRequest(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'not_found', retryable: false });
    expect(sdk.updateCalls).toHaveLength(0);
    expect(sdk.markdownUpdateCalls).toHaveLength(0);
  });

  it('verifies live body integrity before a title-only update', async () => {
    const staleHash = '0'.repeat(64);
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage({ contentHash: staleHash })),
      ],
      markdownResults: [
        Promise.resolve(markdownResponse('Synthetic original body.')),
      ],
    });
    const request = {
      ...routedUpdateRequest(),
      mutation: {
        mode: 'patch' as const,
        patch: { title: 'Synthetic renamed title' },
      },
    };

    await expect(
      provider(sdk).update(request, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(sdk.updateCalls).toHaveLength(0);
  });

  it('renames a record only after verifying its live body and refreshed state', async () => {
    const marker = 'update:op_notion_update_001';
    const contentHash =
      '9fa9837497002b4b09268975deddf109b4304ccc8a8af774dc9cec531af32b43';
    const title = 'Synthetic renamed title';
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage()),
        Promise.resolve(recordPage()),
      ],
      updateResults: [
        Promise.resolve(
          recordPage({ title, marker, contentHash, version: finalTime }),
        ),
      ],
      markdownResults: [
        Promise.resolve(markdownResponse('Synthetic original body.')),
      ],
    });

    const result = await provider(sdk).update(
      {
        ...routedUpdateRequest(),
        mutation: { mode: 'patch', patch: { title } },
      },
      new AbortController().signal,
    );

    expect(sdk.updateCalls).toEqual([
      {
        page_id: existingPageId,
        properties: {
          [titlePropertyId]: { title: textProperty(title) },
          [operationMarkerPropertyId]: {
            rich_text: textProperty(marker),
          },
          [contentTypePropertyId]: {
            rich_text: textProperty('text/markdown'),
          },
          [contentHashPropertyId]: {
            rich_text: textProperty(contentHash),
          },
        },
      },
    ]);
    expect(sdk.markdownUpdateCalls).toHaveLength(0);
    expect(result).toMatchObject({
      outcome: 'completed',
      record: {
        providerRecordId: existingPageId,
        providerVersion: finalTime,
        integrityHash: contentHash,
      },
    });
  });

  it('verifies live body integrity and refreshes scope before recoverable trash', async () => {
    const marker = 'trash:op_notion_trash_001';
    const staleHashSdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage({ contentHash: '0'.repeat(64) })),
      ],
      markdownResults: [
        Promise.resolve(markdownResponse('Synthetic original body.')),
      ],
      updateResults: [
        Promise.resolve(
          recordPage({ marker, inTrash: true, version: finalTime }),
        ),
      ],
    });
    await expect(
      provider(staleHashSdk).trash(
        routedTrashRequest(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(staleHashSdk.updateCalls).toHaveLength(0);

    const movedSdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage()),
        Promise.resolve(recordPage({ dataSource: databaseId })),
      ],
      markdownResults: [
        Promise.resolve(markdownResponse('Synthetic original body.')),
      ],
    });
    await expect(
      provider(movedSdk).trash(
        routedTrashRequest(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'not_found', retryable: false });
    expect(movedSdk.updateCalls).toHaveLength(0);
  });

  it('snapshots routed create content before the asynchronous duplicate check', async () => {
    const query = deferred<QueryDataSourceResponse>();
    const sdk = new SyntheticMutationSdk({ queryResult: query.promise });
    const request = routedCreateRequest();
    const pending = provider(sdk).create(request, new AbortController().signal);

    await vi.waitFor(() => {
      expect(sdk.queryCalls).toHaveLength(1);
    });
    (request as { title: string }).title = 'SYNTHETIC_MUTATED_TITLE';
    (request as { content: string }).content = 'SYNTHETIC_MUTATED_BODY';
    query.resolve(emptyQuery());

    await expect(pending).resolves.toMatchObject({ outcome: 'completed' });
    expect(JSON.stringify(sdk.createCalls)).not.toContain('SYNTHETIC_MUTATED');
  });

  it('snapshots configured roots and mutation property IDs at construction', async () => {
    const sdk = new SyntheticMutationSdk();
    const mutableRoot = structuredClone(governedRoot);
    const mutableTarget = structuredClone(mutationTarget);
    const mutable = new NotionMutableKnowledgeProvider(sdk, sdk, {
      roots: [mutableRoot],
      mutationTargets: [mutableTarget],
    });

    (mutableRoot as { displayPath: string }).displayPath =
      'SYNTHETIC_MUTATED_PATH';
    (mutableRoot.policy as { scope: string }).scope = 'security';
    (mutableTarget.propertyIds as { title: string }).title =
      'SYNTHETIC_MUTATED_PROPERTY';

    const result = await mutable.create(
      routedCreateRequest(),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      outcome: 'completed',
      record: {
        canonicalLocation: {
          displayPath:
            'Family Shared / Structured Records / Synthetic created knowledge',
        },
      },
    });
    expect(JSON.stringify(sdk.createCalls)).not.toContain('SYNTHETIC_MUTATED');
  });

  it('rejects extra routed fields before provider I/O', async () => {
    const sdk = new SyntheticMutationSdk();
    const request = {
      ...routedCreateRequest(),
      providerPayload: 'SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD',
    } as never;

    const error = await provider(sdk)
      .create(request, new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'invalid_request',
      retryable: false,
      details: { reason: 'invalid_routed_create' },
    });
    expect(JSON.stringify(error)).not.toContain('SYNTHETIC_PRIVATE');
    expect(sdk.queryCalls).toHaveLength(0);
    expect(sdk.createCalls).toHaveLength(0);
  });

  it('rejects malformed mutation configuration with one safe error', () => {
    expect(
      () =>
        new NotionMutableKnowledgeProvider(
          new SyntheticMutationSdk(),
          new SyntheticMutationSdk(),
          {
            roots: [governedRoot],
            mutationTargets: [null],
          } as never,
        ),
    ).toThrow('invalid_notion_mutation_configuration');

    expect(
      () =>
        new NotionMutableKnowledgeProvider(
          new SyntheticMutationSdk(),
          new SyntheticMutationSdk(),
          {
            roots: [governedRoot],
            mutationTargets: [
              {
                ...mutationTarget,
                propertyIds: {
                  ...mutationTarget.propertyIds,
                  contentHash: operationMarkerPropertyId,
                },
              },
            ],
          },
        ),
    ).toThrow('invalid_notion_mutation_configuration');
  });

  it('snapshots append content and operation identity before target retrieval completes', async () => {
    const initialPage = deferred<PageObjectResponse>();
    const appendContent = '\nSynthetic immutable append.';
    const finalContent = `Synthetic original body.${appendContent}`;
    const finalHash = sha256(finalContent);
    const marker = 'append:op_notion_append_001';
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        initialPage.promise,
        Promise.resolve(recordPage()),
        Promise.resolve(
          recordPage({ marker, contentHash: finalHash, version: finalTime }),
        ),
      ],
      updateResults: [
        Promise.resolve(
          recordPage({ marker, contentHash: finalHash, version: markerTime }),
        ),
      ],
      markdownResults: [
        Promise.resolve(markdownResponse('Synthetic original body.')),
      ],
      markdownUpdateResults: [Promise.resolve(markdownResponse(finalContent))],
    });
    const request = routedAppendRequest(appendContent);
    const pending = provider(sdk).append(request, new AbortController().signal);

    await vi.waitFor(() => {
      expect(sdk.retrieveCalls).toHaveLength(1);
    });
    (request as { operationId: string }).operationId =
      'SYNTHETIC_MUTATED_OPERATION';
    (request as { content: string }).content = 'SYNTHETIC_MUTATED_CONTENT';
    initialPage.resolve(recordPage());

    await expect(pending).resolves.toMatchObject({ outcome: 'completed' });
    expect(JSON.stringify(sdk.updateCalls)).not.toContain('SYNTHETIC_MUTATED');
    expect(JSON.stringify(sdk.markdownUpdateCalls)).not.toContain(
      'SYNTHETIC_MUTATED',
    );
  });

  it.each([
    {
      operation: 'update',
      run: (mutable: NotionMutableKnowledgeProvider) =>
        mutable.update(
          {
            ...routedUpdateRequest(),
            providerPayload: 'SYNTHETIC_PRIVATE',
          } as never,
          new AbortController().signal,
        ),
    },
    {
      operation: 'append',
      run: (mutable: NotionMutableKnowledgeProvider) =>
        mutable.append(
          {
            ...routedAppendRequest(),
            providerPayload: 'SYNTHETIC_PRIVATE',
          } as never,
          new AbortController().signal,
        ),
    },
    {
      operation: 'trash',
      run: (mutable: NotionMutableKnowledgeProvider) =>
        mutable.trash(
          {
            ...routedTrashRequest(),
            providerPayload: 'SYNTHETIC_PRIVATE',
          } as never,
          new AbortController().signal,
        ),
    },
    {
      operation: 'reconcile',
      run: (mutable: NotionMutableKnowledgeProvider) =>
        mutable.reconcile(
          {
            operationId: operationId('op_notion_reconcile_extra'),
            operation: 'update',
            access: authorizedAccess,
            providerRecordId: providerRecordId(existingPageId),
            providerPayload: 'SYNTHETIC_PRIVATE',
          } as never,
          new AbortController().signal,
        ),
    },
  ])('rejects extra $operation fields before provider I/O', async ({ run }) => {
    const sdk = new SyntheticMutationSdk();
    const error = await run(provider(sdk)).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'invalid_request', retryable: false });
    expect(JSON.stringify(error)).not.toContain('SYNTHETIC_PRIVATE');
    expect(sdk.retrieveCalls).toHaveLength(0);
    expect(sdk.updateCalls).toHaveLength(0);
    expect(sdk.markdownRetrieveCalls).toHaveLength(0);
    expect(sdk.markdownUpdateCalls).toHaveLength(0);
    expect(sdk.queryCalls).toHaveLength(0);
  });

  it('rejects an unknown nested update patch field before provider I/O', async () => {
    const sdk = new SyntheticMutationSdk();
    const request = routedUpdateRequest();
    const invalid = {
      ...request,
      mutation: {
        mode: 'patch',
        patch: {
          title: 'Synthetic safe title',
          providerPayload: 'SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD',
        },
      },
    } as never;

    await expect(
      provider(sdk).update(invalid, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
    expect(sdk.retrieveCalls).toHaveLength(0);
    expect(sdk.updateCalls).toHaveLength(0);
  });

  it('rejects a stale provider version before every update-side write', async () => {
    const sdk = new SyntheticMutationSdk();
    await expect(
      provider(sdk).update(
        {
          ...routedUpdateRequest(),
          expectedProviderVersion: '2042-01-01T00:00:00.000Z',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
      details: { reason: 'provider_version_mismatch' },
    });
    expect(sdk.updateCalls).toHaveLength(0);
    expect(sdk.markdownRetrieveCalls).toHaveLength(0);
    expect(sdk.markdownUpdateCalls).toHaveLength(0);
  });

  it('refuses trash when current gateway integrity metadata is missing', async () => {
    const page = recordPage();
    delete (page.properties as Record<string, unknown>)['contentHash'];
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [Promise.resolve(page)],
    });

    await expect(
      provider(sdk).trash(routedTrashRequest(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      retryable: false,
      details: { reason: 'invalid_notion_record_metadata' },
    });
    expect(sdk.updateCalls).toHaveLength(0);
  });

  it('reconciles an uncertain create by exact marker, title, and content hash before any repeat', async () => {
    const created = pageFromCreate();
    const sdk = new SyntheticMutationSdk({
      createResult: Promise.reject(
        new Error('SYNTHETIC_PRIVATE_CREATE_NETWORK_FAILURE'),
      ),
      queryResults: [
        Promise.resolve(emptyQuery()),
        Promise.resolve(queryWith(created)),
        Promise.resolve(queryWith(created)),
      ],
      markdownResults: [
        Promise.resolve(
          markdownResponse('Synthetic created body.', createdPageId),
        ),
      ],
    });
    const mutable = provider(sdk);
    const request = routedCreateRequest();

    const result = await mutable.create(request, new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('Synthetic created body.');
    expect(JSON.stringify(result)).not.toContain(
      'SYNTHETIC_PRIVATE_CREATE_NETWORK_FAILURE',
    );

    await expect(
      mutable.create(request, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
      details: { reason: 'provider_operation_repeated' },
    });
    if (result.outcome !== 'unknown') {
      expect.unreachable('expected unknown create');
    }
    await expect(
      mutable.reconcile(
        {
          operationId: request.operationId,
          operation: 'create',
          access: authorizedAccess,
          ...(result.reconciliationKey === undefined
            ? {}
            : { reconciliationKey: result.reconciliationKey }),
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      outcome: 'completed',
      record: {
        providerRecordId: createdPageId,
        integrityHash:
          '26634d02b614a03105575b66ae57aa331c30b5406342a01c9aa96b6a6808f3ea',
      },
    });
    expect(sdk.createCalls).toHaveLength(1);
  });

  it('does not reconcile a create whose stored content type differs from the intended write', async () => {
    const mismatched = recordPage({
      id: createdPageId,
      title: 'Synthetic created knowledge',
      marker: 'create:op_notion_create_001',
      contentType: 'text/markdown',
      contentHash:
        '26634d02b614a03105575b66ae57aa331c30b5406342a01c9aa96b6a6808f3ea',
    });
    const sdk = new SyntheticMutationSdk({
      createResult: Promise.reject(new Error('SYNTHETIC_AMBIGUOUS_CREATE')),
      queryResults: [
        Promise.resolve(emptyQuery()),
        Promise.resolve(queryWith(mismatched)),
      ],
      markdownResults: [
        Promise.resolve(
          markdownResponse('Synthetic created body.', createdPageId),
        ),
      ],
    });
    const mutable = provider(sdk);
    const request = routedCreateRequest();
    const result = await mutable.create(request, new AbortController().signal);
    if (
      result.outcome !== 'unknown' ||
      result.reconciliationKey === undefined
    ) {
      expect.unreachable('expected keyed unknown create');
    }

    await expect(
      mutable.reconcile(
        {
          operationId: request.operationId,
          operation: 'create',
          access: authorizedAccess,
          reconciliationKey: result.reconciliationKey,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ outcome: 'inconclusive' });
  });

  it('names the failed create step and only the safe Notion error code', async () => {
    const privateFailure = 'SYNTHETIC_PRIVATE_VALIDATION_BODY';
    const rejection = (code: APIErrorCode, status: number) =>
      new APIResponseError({
        code,
        status,
        message: privateFailure,
        headers: {},
        rawBodyText: privateFailure,
        additional_data: undefined,
        request_id: 'synthetic-private-provider-request-id',
      });

    const lookupError = await provider(
      new SyntheticMutationSdk({
        queryResults: [
          Promise.reject(rejection(APIErrorCode.ValidationError, 400)),
        ],
      }),
    )
      .create(routedCreateRequest(), new AbortController().signal)
      .catch((caught: unknown) => caught);
    const createError = await provider(
      new SyntheticMutationSdk({
        createResult: Promise.reject(
          rejection(APIErrorCode.ValidationError, 400),
        ),
      }),
    )
      .create(routedCreateRequest(), new AbortController().signal)
      .catch((caught: unknown) => caught);
    const opaqueLookupError = await provider(
      new SyntheticMutationSdk({
        queryResults: [Promise.reject(new Error(privateFailure))],
      }),
    )
      .create(routedCreateRequest(), new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(lookupError).toMatchObject({
      code: 'provider_unavailable',
      details: {
        reason: 'notion_mutation_request_failed_create_lookup_validation_error',
      },
    });
    expect(createError).toMatchObject({
      code: 'provider_unavailable',
      details: {
        reason: 'notion_mutation_request_failed_create_validation_error',
      },
    });
    expect(opaqueLookupError).toMatchObject({
      code: 'provider_unavailable',
      details: {
        reason: 'notion_mutation_request_failed_create_lookup_unclassified',
      },
    });
    expect(
      JSON.stringify([lookupError, createError, opaqueLookupError]),
    ).not.toContain(privateFailure);
  });

  it('sanitizes a known Notion rejection without creating reconciliation evidence', async () => {
    const privateFailure = 'SYNTHETIC_PRIVATE_RATE_LIMIT_BODY';
    const sdk = new SyntheticMutationSdk({
      createResult: Promise.reject(
        new APIResponseError({
          code: APIErrorCode.RateLimited,
          status: 429,
          message: privateFailure,
          headers: { 'retry-after': '1' },
          rawBodyText: privateFailure,
          additional_data: undefined,
          request_id: 'synthetic-private-provider-request-id',
        }),
      ),
    });

    const error = await provider(sdk)
      .create(routedCreateRequest(), new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: {
        reason: 'notion_mutation_request_failed_create_rate_limited',
      },
    });
    expect(JSON.stringify(error)).not.toContain(privateFailure);
    expect(JSON.stringify(error)).not.toContain('reconciliationKey');
    expect(sdk.createCalls).toHaveLength(1);
  });

  it.each<
    readonly [
      string,
      Awaited<ReturnType<NotionMutationSdkClient['pages']['create']>>,
    ]
  >([
    ['partial page', { object: 'page' as const, id: createdPageId }],
    [
      'wrong direct parent',
      recordPage({ id: createdPageId, dataSource: databaseId }),
    ],
    [
      'wrong operation marker',
      recordPage({ id: createdPageId, marker: 'create:op_notion_other' }),
    ],
  ])(
    'does not report create success from a %s response',
    async (_label, response) => {
      const sdk = new SyntheticMutationSdk({
        createResult: Promise.resolve(response),
      });

      const result = await provider(sdk).create(
        routedCreateRequest(),
        new AbortController().signal,
      );
      expect(result).toMatchObject({ outcome: 'unknown' });
      if (result.outcome !== 'unknown') {
        expect.unreachable('expected unknown create');
      }
      expect(typeof result.reconciliationKey).toBe('string');
    },
  );

  it('returns a safe cancellation before I/O and an unknown outcome after create dispatch', async () => {
    const beforeSdk = new SyntheticMutationSdk();
    const beforeController = new AbortController();
    beforeController.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));
    const beforeError = await provider(beforeSdk)
      .create(routedCreateRequest(), beforeController.signal)
      .catch((caught: unknown) => caught);

    expect(beforeError).toMatchObject({ name: 'AbortError' });
    expect(String(beforeError)).not.toContain('SYNTHETIC_PRIVATE');
    expect(beforeSdk.queryCalls).toHaveLength(0);
    expect(beforeSdk.createCalls).toHaveLength(0);

    const pendingCreate = deferred<PageObjectResponse>();
    const afterSdk = new SyntheticMutationSdk({
      createResult: pendingCreate.promise,
    });
    const afterController = new AbortController();
    const result = provider(afterSdk).create(
      routedCreateRequest(),
      afterController.signal,
    );
    await vi.waitFor(() => {
      expect(afterSdk.createCalls).toHaveLength(1);
    });
    afterController.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));

    await expect(result).resolves.toMatchObject({ outcome: 'unknown' });
    pendingCreate.resolve(pageFromCreate());
  });

  it('cancels a target preflight without issuing any mutation', async () => {
    const pendingRetrieve = deferred<PageObjectResponse>();
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [pendingRetrieve.promise],
    });
    const controller = new AbortController();
    const result = provider(sdk).update(
      routedUpdateRequest(),
      controller.signal,
    );
    await vi.waitFor(() => {
      expect(sdk.retrieveCalls).toHaveLength(1);
    });
    controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(sdk.updateCalls).toHaveLength(0);
    expect(sdk.markdownUpdateCalls).toHaveLength(0);
    pendingRetrieve.resolve(recordPage());
  });

  it('returns inconclusive for duplicate create markers and a tampered reconciliation key', async () => {
    const created = pageFromCreate();
    const sdk = new SyntheticMutationSdk({
      queryResults: [Promise.resolve(queryWith(created, created))],
    });
    const mutable = provider(sdk);

    await expect(
      mutable.reconcile(
        {
          operationId: operationId('op_notion_create_001'),
          operation: 'create',
          access: authorizedAccess,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ outcome: 'inconclusive' });

    const callsBeforeTamper = sdk.queryCalls.length;
    await expect(
      mutable.reconcile(
        {
          operationId: operationId('op_notion_create_001'),
          operation: 'create',
          access: authorizedAccess,
          reconciliationKey: 'synthetic-tampered-key',
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ outcome: 'inconclusive' });
    expect(sdk.queryCalls).toHaveLength(callsBeforeTamper);
  });

  it('copies only the narrow mutation methods from its SDK client', () => {
    const sdk = new SyntheticMutationSdk();
    Object.defineProperty(sdk.pages, 'privateWorkspaceExport', {
      enumerable: true,
      get: () => {
        throw new Error('SYNTHETIC_FORBIDDEN_METHOD_ACCESSED');
      },
    });

    expect(() => provider(sdk)).not.toThrow();
  });

  it.each([
    {
      operation: 'append',
      run: (mutable: NotionMutableKnowledgeProvider) =>
        mutable.append(
          {
            ...routedAppendRequest(),
            expectedProviderVersion: '2042-01-01T00:00:00.000Z',
          },
          new AbortController().signal,
        ),
    },
    {
      operation: 'trash',
      run: (mutable: NotionMutableKnowledgeProvider) =>
        mutable.trash(
          {
            ...routedTrashRequest(),
            expectedProviderVersion: '2042-01-01T00:00:00.000Z',
          },
          new AbortController().signal,
        ),
    },
  ])('rejects stale $operation without a provider write', async ({ run }) => {
    const sdk = new SyntheticMutationSdk();
    await expect(run(provider(sdk))).rejects.toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
      details: { reason: 'provider_version_mismatch' },
    });
    expect(sdk.updateCalls).toHaveLength(0);
    expect(sdk.markdownRetrieveCalls).toHaveLength(0);
    expect(sdk.markdownUpdateCalls).toHaveLength(0);
  });

  it('fails closed before mutation when the target is outside the configured governed data source', async () => {
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage({ dataSource: databaseId })),
      ],
    });

    await expect(
      provider(sdk).update(routedUpdateRequest(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'not_found', retryable: false });
    expect(sdk.updateCalls).toHaveLength(0);
    expect(sdk.markdownUpdateCalls).toHaveLength(0);
  });

  it.each([
    {
      label: 'a multibyte create body over the byte limit',
      run: (mutable: NotionMutableKnowledgeProvider) =>
        mutable.create(
          { ...routedCreateRequest(), content: '🪐'.repeat(100_001) },
          new AbortController().signal,
        ),
    },
    {
      label: 'an append body over the byte limit',
      run: (mutable: NotionMutableKnowledgeProvider) =>
        mutable.append(
          routedAppendRequest('x'.repeat(400_001)),
          new AbortController().signal,
        ),
    },
    {
      label: 'an unsupported create content type',
      run: (mutable: NotionMutableKnowledgeProvider) =>
        mutable.create(
          { ...routedCreateRequest(), contentType: 'application/octet-stream' },
          new AbortController().signal,
        ),
    },
  ])('rejects $label before provider I/O', async ({ run }) => {
    const sdk = new SyntheticMutationSdk();
    await expect(run(provider(sdk))).rejects.toMatchObject({
      code: 'invalid_request',
      retryable: false,
    });
    expect(sdk.queryCalls).toHaveLength(0);
    expect(sdk.retrieveCalls).toHaveLength(0);
    expect(sdk.createCalls).toHaveLength(0);
    expect(sdk.updateCalls).toHaveLength(0);
  });

  it('refuses an append whose existing plus new content exceeds the full-body bound', async () => {
    const currentContent = 'x'.repeat(399_999);
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage({ contentHash: sha256(currentContent) })),
      ],
      markdownResults: [Promise.resolve(markdownResponse(currentContent))],
    });

    await expect(
      provider(sdk).append(
        routedAppendRequest('xx'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
    expect(sdk.updateCalls).toHaveLength(0);
    expect(sdk.markdownUpdateCalls).toHaveLength(0);
  });

  it('does not mutate from an incomplete duplicate query or truncated source markdown', async () => {
    const incomplete = {
      ...emptyQuery(),
      request_status: { type: 'incomplete' as const },
    };
    const createSdk = new SyntheticMutationSdk({
      queryResult: Promise.resolve(incomplete),
    });
    await expect(
      provider(createSdk).create(
        routedCreateRequest(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(createSdk.createCalls).toHaveLength(0);

    const truncated = {
      ...markdownResponse('Synthetic original body.'),
      truncated: true as const,
      unknown_block_ids: ['30000000-0000-4000-8000-000000000001'],
    };
    const updateSdk = new SyntheticMutationSdk({
      markdownResults: [Promise.resolve(truncated as never)],
    });
    await expect(
      provider(updateSdk).update(
        routedUpdateRequest(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(updateSdk.updateCalls).toHaveLength(0);
    expect(updateSdk.markdownUpdateCalls).toHaveLength(0);
  });

  it('returns unknown when a post-write markdown response is incomplete', async () => {
    const finalHash = sha256('Synthetic replacement body.');
    const marker = 'update:op_notion_update_001';
    const sdk = new SyntheticMutationSdk({
      updateResults: [
        Promise.resolve(
          recordPage({ marker, contentHash: finalHash, version: markerTime }),
        ),
      ],
      markdownUpdateResults: [
        Promise.resolve({
          ...markdownResponse('Synthetic replacement body.'),
          truncated: true,
          unknown_block_ids: ['30000000-0000-4000-8000-000000000001'],
        } as never),
      ],
    });

    const result = await provider(sdk).update(
      routedUpdateRequest(),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ outcome: 'unknown' });
    if (result.outcome !== 'unknown') {
      expect.unreachable('expected unknown update');
    }
    expect(typeof result.reconciliationKey).toBe('string');
    expect(sdk.markdownUpdateCalls).toHaveLength(1);
  });

  it('sanitizes malformed provider read responses instead of throwing raw runtime errors', async () => {
    const targetSdk = new SyntheticMutationSdk({
      retrieveResults: [Promise.resolve(null as never)],
    });
    await expect(
      provider(targetSdk).update(
        routedUpdateRequest(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'notion_mutation_request_failed_load_unclassified' },
    });
    expect(targetSdk.updateCalls).toHaveLength(0);

    const createReconcileSdk = new SyntheticMutationSdk({
      queryResult: Promise.resolve(null as never),
    });
    await expect(
      provider(createReconcileSdk).reconcile(
        {
          operationId: operationId('op_notion_reconcile_malformed'),
          operation: 'create',
          access: authorizedAccess,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ outcome: 'inconclusive' });
  });

  it('fails safely when a nominal full page has malformed properties', async () => {
    const malformed = {
      ...recordPage(),
      properties: null,
    } as never;
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [Promise.resolve(malformed)],
    });

    await expect(
      provider(sdk).trash(routedTrashRequest(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(sdk.updateCalls).toHaveLength(0);
  });

  it('appends synchronously at the end and verifies the complete returned markdown', async () => {
    const marker = 'append:op_notion_append_001';
    const finalHash =
      'e953d4a01c1f6523c2394923bad379d428d80fa1549ba12e3732466a17e505ca';
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage()),
        Promise.resolve(recordPage()),
        Promise.resolve(
          recordPage({ marker, contentHash: finalHash, version: finalTime }),
        ),
      ],
      updateResults: [
        Promise.resolve(
          recordPage({ marker, contentHash: finalHash, version: markerTime }),
        ),
      ],
      markdownResults: [
        Promise.resolve(markdownResponse('Synthetic original body.')),
      ],
      markdownUpdateResults: [
        Promise.resolve(
          markdownResponse(
            'Synthetic original body.\nSynthetic appended body.',
          ),
        ),
      ],
    });

    const result = await provider(sdk).append(
      {
        operationId: operationId('op_notion_append_001'),
        access: authorizedAccess,
        providerRecordId: providerRecordId(existingPageId),
        expectedProviderVersion: updatedTime,
        content: '\nSynthetic appended body.',
      },
      new AbortController().signal,
    );

    expect(sdk.markdownUpdateCalls).toEqual([
      {
        page_id: existingPageId,
        type: 'insert_content',
        insert_content: {
          content: '\nSynthetic appended body.',
          position: { type: 'end' },
        },
        allow_async: false,
      },
    ]);
    expect(result).toMatchObject({
      outcome: 'completed',
      record: {
        providerRecordId: existingPageId,
        providerVersion: finalTime,
        integrityHash: finalHash,
      },
    });
  });

  // Notion stores an appended line as a new block, so it returns its own
  // separator rather than the exact concatenation the gateway sent.
  it('records the markdown Notion holds after an append that landed as a new block', async () => {
    const marker = 'append:op_notion_append_001';
    const sent = 'Synthetic original body.Synthetic appended body.';
    const held = 'Synthetic original body.\n\nSynthetic appended body.';
    const sentHash = sha256(sent);
    const heldHash = sha256(held);
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage()),
        Promise.resolve(recordPage()),
        Promise.resolve(
          recordPage({ marker, contentHash: heldHash, version: finalTime }),
        ),
      ],
      updateResults: [
        Promise.resolve(
          recordPage({ marker, contentHash: sentHash, version: markerTime }),
        ),
        Promise.resolve(
          recordPage({ marker, contentHash: heldHash, version: finalTime }),
        ),
      ],
      markdownResults: [
        Promise.resolve(markdownResponse('Synthetic original body.')),
      ],
      markdownUpdateResults: [Promise.resolve(markdownResponse(held))],
    });

    const result = await provider(sdk).append(
      routedAppendRequest('Synthetic appended body.'),
      new AbortController().signal,
    );

    expect(sdk.updateCalls).toHaveLength(2);
    expect(sdk.updateCalls[1]).toEqual({
      page_id: existingPageId,
      properties: {
        [contentHashPropertyId]: { rich_text: textProperty(heldHash) },
      },
    });
    expect(result).toMatchObject({
      outcome: 'completed',
      record: { providerVersion: finalTime, integrityHash: heldHash },
    });
  });

  it.each([
    [
      'changed earlier content',
      'Synthetic changed body.\n\nSynthetic appended body.',
    ],
    [
      'other text before the append',
      'Synthetic original body.\n\nExtra.\n\nSynthetic appended body.',
    ],
    ['a missing append', 'Synthetic original body.'],
    [
      'more than one blank line',
      'Synthetic original body.\n\n\nSynthetic appended body.',
    ],
  ])(
    'reports outcome unknown when Notion holds %s after an append',
    async (_label, held) => {
      const marker = 'append:op_notion_append_001';
      const sentHash = sha256(
        'Synthetic original body.Synthetic appended body.',
      );
      const sdk = new SyntheticMutationSdk({
        retrieveResults: [
          Promise.resolve(recordPage()),
          Promise.resolve(recordPage()),
        ],
        updateResults: [
          Promise.resolve(
            recordPage({ marker, contentHash: sentHash, version: markerTime }),
          ),
        ],
        markdownResults: [
          Promise.resolve(markdownResponse('Synthetic original body.')),
        ],
        markdownUpdateResults: [Promise.resolve(markdownResponse(held))],
      });

      await expect(
        provider(sdk).append(
          routedAppendRequest('Synthetic appended body.'),
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ outcome: 'unknown' });
      expect(sdk.updateCalls).toHaveLength(1);
    },
  );

  it('never accepts a different held body after a content replacement', async () => {
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage()),
        Promise.resolve(recordPage()),
      ],
      updateResults: [
        Promise.resolve(
          recordPage({
            marker: 'update:op_notion_update_001',
            contentHash: sha256('Synthetic replacement body.'),
            version: markerTime,
          }),
        ),
      ],
      markdownResults: [
        Promise.resolve(markdownResponse('Synthetic original body.')),
      ],
      markdownUpdateResults: [
        Promise.resolve(markdownResponse('Synthetic replacement body.\n')),
      ],
    });

    await expect(
      provider(sdk).update(routedUpdateRequest(), new AbortController().signal),
    ).resolves.toMatchObject({ outcome: 'unknown' });
    expect(sdk.updateCalls).toHaveLength(1);
  });

  it('names a body that no longer matches its stored hash, without writing', async () => {
    const sdk = new SyntheticMutationSdk({
      markdownResults: [
        Promise.resolve(markdownResponse('Synthetic body edited elsewhere.')),
      ],
    });

    await expect(
      provider(sdk).trash(routedTrashRequest(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'notion_content_integrity_mismatch' },
    });
    expect(sdk.updateCalls).toHaveLength(0);
  });

  it('names a rejected trash step with only the safe Notion error code', async () => {
    const privateFailure = 'SYNTHETIC_PRIVATE_TRASH_BODY';
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage()),
        Promise.resolve(recordPage()),
      ],
      updateResults: [
        Promise.reject(
          new APIResponseError({
            code: APIErrorCode.ValidationError,
            status: 400,
            message: privateFailure,
            headers: {},
            rawBodyText: privateFailure,
            additional_data: undefined,
            request_id: 'synthetic-private-provider-request-id',
          }),
        ),
      ],
    });

    const error = await provider(sdk)
      .trash(
        {
          operationId: operationId('op_notion_trash_001'),
          access: authorizedAccess,
          providerRecordId: providerRecordId(existingPageId),
          expectedProviderVersion: updatedTime,
        },
        new AbortController().signal,
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'provider_unavailable',
      details: {
        reason: 'notion_mutation_request_failed_trash_validation_error',
      },
    });
    expect(JSON.stringify(error)).not.toContain(privateFailure);
  });

  it('moves an exact current record to recoverable trash with its marker in one page update', async () => {
    const marker = 'trash:op_notion_trash_001';
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage()),
        Promise.resolve(recordPage()),
      ],
      updateResults: [
        Promise.resolve(
          recordPage({ marker, inTrash: true, version: finalTime }),
        ),
      ],
    });

    const result = await provider(sdk).trash(
      {
        operationId: operationId('op_notion_trash_001'),
        access: authorizedAccess,
        providerRecordId: providerRecordId(existingPageId),
        expectedProviderVersion: updatedTime,
      },
      new AbortController().signal,
    );

    expect(sdk.markdownRetrieveCalls).toEqual([
      { page_id: existingPageId, include_transcript: false },
    ]);
    expect(sdk.updateCalls).toEqual([
      {
        page_id: existingPageId,
        properties: {
          [operationMarkerPropertyId]: {
            rich_text: textProperty(marker),
          },
        },
        in_trash: true,
      },
    ]);
    expect(result).toMatchObject({
      outcome: 'completed',
      record: {
        provider: 'notion',
        providerRecordId: existingPageId,
        providerVersion: finalTime,
      },
    });
  });

  it('returns an opaque unknown result, rejects repeat execution, and reconciles an ambiguous update by marker and content hash', async () => {
    const marker = 'update:op_notion_update_unknown';
    const finalHash =
      '04ace105c9530634181f698bcd72b00940132c8ddd0dcc94a7d1a347e84c55d8';
    const sdk = new SyntheticMutationSdk({
      retrieveResults: [
        Promise.resolve(recordPage()),
        Promise.resolve(recordPage()),
        Promise.resolve(
          recordPage({ marker, contentHash: finalHash, version: markerTime }),
        ),
        Promise.resolve(
          recordPage({ marker, contentHash: finalHash, version: finalTime }),
        ),
      ],
      updateResults: [
        Promise.resolve(
          recordPage({ marker, contentHash: finalHash, version: markerTime }),
        ),
      ],
      markdownResults: [
        Promise.resolve(markdownResponse('Synthetic original body.')),
        Promise.resolve(markdownResponse('Synthetic replacement body.')),
      ],
      markdownUpdateResults: [
        Promise.reject(new Error('SYNTHETIC_PRIVATE_NETWORK_FAILURE')),
      ],
    });
    const mutable = provider(sdk);
    const request = {
      operationId: operationId('op_notion_update_unknown'),
      access: authorizedAccess,
      providerRecordId: providerRecordId(existingPageId),
      expectedProviderVersion: updatedTime,
      mutation: {
        mode: 'replace' as const,
        replacement: { content: 'Synthetic replacement body.' },
      },
    };

    const result = await mutable.update(request, new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'unknown' });
    if (result.outcome !== 'unknown') {
      expect.unreachable('expected unknown update');
    }
    expect(typeof result.reconciliationKey).toBe('string');
    expect(JSON.stringify(result)).not.toContain('Synthetic replacement body.');
    expect(JSON.stringify(result)).not.toContain(
      'SYNTHETIC_PRIVATE_NETWORK_FAILURE',
    );

    await expect(
      mutable.update(request, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
      details: { reason: 'provider_operation_repeated' },
    });
    await expect(
      mutable.reconcile(
        {
          operationId: request.operationId,
          operation: 'update',
          access: authorizedAccess,
          providerRecordId: request.providerRecordId,
          ...(result.reconciliationKey === undefined
            ? {}
            : { reconciliationKey: result.reconciliationKey }),
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      outcome: 'completed',
      record: {
        providerRecordId: existingPageId,
        providerVersion: finalTime,
        integrityHash: finalHash,
      },
    });
    expect(sdk.markdownUpdateCalls).toHaveLength(1);
  });

  it('exposes only the exact official SDK methods required by governed mutations', async () => {
    let requestUrl = '';
    let requestMethod: string | undefined;
    let requestHeaders: Readonly<Record<string, string>> | undefined;
    const sdk = createOfficialNotionMutationSdkClient({
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
              JSON.stringify(markdownResponse('Synthetic body.')),
            ),
        });
      },
    });

    await sdk.pages.updateMarkdown({
      page_id: existingPageId,
      type: 'replace_content',
      replace_content: {
        new_str: 'Synthetic body.',
        allow_deleting_content: true,
      },
      allow_async: false,
    });

    expect(Object.keys(sdk)).toEqual(['apiVersion', 'pages', 'dataSources']);
    expect(Object.keys(sdk.pages)).toEqual([
      'create',
      'retrieve',
      'update',
      'retrieveMarkdown',
      'updateMarkdown',
    ]);
    expect(Object.keys(sdk.dataSources)).toEqual(['query']);
    expect(Object.isFrozen(sdk)).toBe(true);
    expect(Object.isFrozen(sdk.pages)).toBe(true);
    expect(Object.isFrozen(sdk.dataSources)).toBe(true);
    expect(requestUrl).toMatch(
      new RegExp(`/v1/pages/${existingPageId}/markdown$`, 'u'),
    );
    expect(requestMethod).toBe('PATCH');
    expect(requestHeaders?.['Notion-Version']).toBe(NOTION_API_VERSION);
  });

  it('does not automatically retry an official mutation request', async () => {
    let fetchCalls = 0;
    const sdk = createOfficialNotionMutationSdkClient({
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
      sdk.pages.updateMarkdown({
        page_id: existingPageId,
        type: 'replace_content',
        replace_content: {
          new_str: 'Synthetic body.',
          allow_deleting_content: true,
        },
        allow_async: false,
      }),
    ).rejects.toMatchObject({ code: APIErrorCode.ServiceUnavailable });
    expect(fetchCalls).toBe(1);
  });
});
