import type {
  BlockObjectResponse,
  ListBlockChildrenResponse,
  PageObjectResponse,
  RichTextItemResponse,
  SearchResponse,
} from '@notionhq/client';
import {
  APIErrorCode,
  APIResponseError,
  ClientErrorCode,
} from '@notionhq/client';
import { describe, expect, it, vi } from 'vitest';

import {
  brainRecordId,
  providerRecordId,
} from '../../../src/domain/identifiers.js';
import type { BrainRecord, BrainScope } from '../../../src/domain/records.js';
import {
  NOTION_CLIENT_TIMEOUT_MS,
  NOTION_API_VERSION,
  OfficialNotionRetrievalClient,
  createOfficialNotionSdkClient,
  type NotionSdkClient,
} from '../../../src/adapters/notion/notion-client.js';
import {
  NotionKnowledgeProvider,
  type NotionGovernedRoot,
} from '../../../src/adapters/notion/notion-knowledge-provider.js';
import { NotionScopeGuard } from '../../../src/adapters/notion/notion-scope-guard.js';
import { fetchableKnowledgeProviderContract } from '../../contract/knowledge-provider.contract.js';

const createdTime = '2042-01-02T03:04:05.000Z';
const updatedTime = '2042-01-03T04:05:06.000Z';
const familyRootId = '10000000-0000-4000-8000-000000000001';
const legalRootId = '10000000-0000-4000-8000-000000000002';
const unregisteredRootId = '10000000-0000-4000-8000-000000000003';
const visiblePageId = '10000000-0000-4000-8000-000000000101';
const legalPageId = '10000000-0000-4000-8000-000000000102';
const unregisteredPageId = '10000000-0000-4000-8000-000000000103';
const familyRootRef = 'notion://development/family-shared';
const legalRootRef = 'notion://development/legal';
const unregisteredRootRef = 'notion://development/unregistered';

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

function page(
  id: string,
  title: string,
  parent: PageObjectResponse['parent'],
): PageObjectResponse {
  return {
    object: 'page',
    id,
    created_time: createdTime,
    last_edited_time: updatedTime,
    in_trash: false,
    archived: false,
    is_archived: false,
    is_locked: false,
    url: `https://www.notion.so/${id}`,
    public_url: null,
    parent,
    properties: {
      title: {
        id: 'title',
        type: 'title',
        title: [richText(title)],
      },
    },
    icon: null,
    cover: null,
    created_by: user,
    last_edited_by: user,
  };
}

function blockBase(id: string, parentId: string, hasChildren = false) {
  return {
    object: 'block' as const,
    id,
    parent: { type: 'page_id' as const, page_id: parentId },
    created_time: createdTime,
    created_by: user,
    last_edited_time: updatedTime,
    last_edited_by: user,
    has_children: hasChildren,
    in_trash: false,
    archived: false,
  };
}

function paragraphBlock(
  id: string,
  parentId: string,
  content: string,
): BlockObjectResponse {
  return {
    ...blockBase(id, parentId),
    type: 'paragraph',
    paragraph: {
      rich_text: [richText(content)],
      color: 'default',
      icon: null,
    },
  };
}

function toggleBlock(
  id: string,
  parentId: string,
  content: string,
): BlockObjectResponse {
  return {
    ...blockBase(id, parentId, true),
    type: 'toggle',
    toggle: { rich_text: [richText(content)], color: 'default' },
  };
}

function headingBlock(
  id: string,
  parentId: string,
  content: string,
): BlockObjectResponse {
  return {
    ...blockBase(id, parentId),
    type: 'heading_2',
    heading_2: {
      rich_text: [richText(content)],
      color: 'default',
      is_toggleable: false,
    },
  };
}

function todoBlock(
  id: string,
  parentId: string,
  content: string,
): BlockObjectResponse {
  return {
    ...blockBase(id, parentId),
    type: 'to_do',
    to_do: {
      rich_text: [richText(content)],
      color: 'default',
      checked: true,
    },
  };
}

function blockPage(
  results: readonly BlockObjectResponse[],
  nextCursor: string | null = null,
): ListBlockChildrenResponse {
  return {
    type: 'block',
    block: {},
    object: 'list',
    results: [...results],
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
  };
}

function searchPage(
  results: readonly PageObjectResponse[],
  nextCursor: string | null = null,
): SearchResponse {
  return {
    type: 'page_or_data_source',
    page_or_data_source: {},
    object: 'list',
    results: [...results],
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
    request_status: { type: 'complete' },
  };
}

const visiblePage = Object.assign(
  page(visiblePageId, 'Synthetic shared checklist', {
    type: 'page_id',
    page_id: familyRootId,
  }),
  { providerRawObject: { token: 'SYNTHETIC_PROVIDER_PRIVATE_VALUE' } },
) as PageObjectResponse;
const legalPage = page(legalPageId, 'Synthetic legal checklist', {
  type: 'page_id',
  page_id: legalRootId,
});
const unregisteredPage = page(
  unregisteredPageId,
  'Synthetic unregistered checklist',
  { type: 'page_id', page_id: unregisteredRootId },
);

const familyRoot = page(familyRootId, 'Family Shared', {
  type: 'workspace',
  workspace: true,
});
const legalRoot = page(legalRootId, 'Legal', {
  type: 'workspace',
  workspace: true,
});
const unregisteredRoot = page(unregisteredRootId, 'Unregistered', {
  type: 'workspace',
  workspace: true,
});

const toggleId = '30000000-0000-4000-8000-000000000002';
const childPages = new Map<string, ListBlockChildrenResponse>([
  [
    `${visiblePageId}:`,
    blockPage(
      [
        paragraphBlock(
          '30000000-0000-4000-8000-000000000001',
          visiblePageId,
          'Synthetic shared checklist.',
        ),
        toggleBlock(toggleId, visiblePageId, 'Nested details'),
      ],
      'synthetic-next-cursor',
    ),
  ],
  [
    `${visiblePageId}:synthetic-next-cursor`,
    blockPage([
      headingBlock(
        '30000000-0000-4000-8000-000000000003',
        visiblePageId,
        'After pagination',
      ),
    ]),
  ],
  [
    `${toggleId}:`,
    blockPage([
      todoBlock(
        '30000000-0000-4000-8000-000000000004',
        toggleId,
        'Verify fictional result',
      ),
    ]),
  ],
]);

interface SyntheticSdkOptions {
  readonly apiVersion?: string;
  readonly searchFailure?: unknown;
  readonly searchOverride?: (
    args: Parameters<NotionSdkClient['search']>[0],
  ) => Promise<SearchResponse>;
  readonly childOverride?: (
    args: Parameters<NotionSdkClient['blocks']['children']['list']>[0],
  ) => Promise<ListBlockChildrenResponse>;
  readonly extraPages?: readonly PageObjectResponse[];
  readonly pageFailure?: Error;
}

class SyntheticNotionSdk implements NotionSdkClient {
  readonly apiVersion: string;
  readonly searchCalls: Array<Parameters<NotionSdkClient['search']>[0]> = [];
  readonly pageCalls: Array<
    Parameters<NotionSdkClient['pages']['retrieve']>[0]
  > = [];
  readonly childCalls: Array<
    Parameters<NotionSdkClient['blocks']['children']['list']>[0]
  > = [];
  readonly #pages: ReadonlyMap<string, PageObjectResponse>;
  readonly #options: SyntheticSdkOptions;

  constructor(options: SyntheticSdkOptions = {}) {
    this.apiVersion = options.apiVersion ?? NOTION_API_VERSION;
    this.#options = options;
    this.#pages = new Map(
      [
        visiblePage,
        legalPage,
        unregisteredPage,
        familyRoot,
        legalRoot,
        unregisteredRoot,
        ...(options.extraPages ?? []),
      ].map((value) => [value.id, value]),
    );
  }

  readonly search: NotionSdkClient['search'] = (args) => {
    this.searchCalls.push(args);
    if (this.#options.searchFailure !== undefined) {
      return Promise.reject(
        this.#options.searchFailure instanceof Error
          ? this.#options.searchFailure
          : new Error('synthetic_notion_failure'),
      );
    }
    if (this.#options.searchOverride !== undefined) {
      return this.#options.searchOverride(args);
    }
    if (args.query?.toLocaleLowerCase().includes('no matching fixture')) {
      return Promise.resolve(searchPage([]));
    }
    return Promise.resolve(
      args.start_cursor === 'synthetic-search-cursor'
        ? searchPage([visiblePage])
        : searchPage([legalPage, unregisteredPage], 'synthetic-search-cursor'),
    );
  };

  readonly pages: NotionSdkClient['pages'] = {
    retrieve: (args) => {
      this.pageCalls.push(args);
      const result = this.#pages.get(args.page_id);
      return result === undefined
        ? Promise.reject(
            this.#options.pageFailure ??
              new Error('SYNTHETIC_PRIVATE_NOTION_FAILURE'),
          )
        : Promise.resolve(result);
    },
  };

  readonly dataSources: NotionSdkClient['dataSources'] = {
    retrieve: () =>
      Promise.reject(new Error('SYNTHETIC_PRIVATE_NOTION_FAILURE')),
  };

  readonly databases: NotionSdkClient['databases'] = {
    retrieve: () =>
      Promise.reject(new Error('SYNTHETIC_PRIVATE_NOTION_FAILURE')),
  };

  readonly blocks: NotionSdkClient['blocks'] = {
    retrieve: () =>
      Promise.reject(new Error('SYNTHETIC_PRIVATE_NOTION_FAILURE')),
    children: {
      list: (args) => {
        this.childCalls.push(args);
        if (this.#options.childOverride !== undefined) {
          return this.#options.childOverride(args);
        }
        const result = childPages.get(
          `${args.block_id}:${args.start_cursor ?? ''}`,
        );
        return result === undefined
          ? Promise.resolve(blockPage([]))
          : Promise.resolve(result);
      },
    },
  };
}

const familyGovernedRoot: NotionGovernedRoot = {
  rootRef: familyRootRef,
  notionObject: { kind: 'page', id: familyRootId },
  displayPath: 'Family Shared',
  policy: {
    scope: 'family_shared',
    sensitivity: 'family_shared',
    protectedClass: 'none',
  },
};
const legalGovernedRoot: NotionGovernedRoot = {
  rootRef: legalRootRef,
  notionObject: { kind: 'page', id: legalRootId },
  displayPath: 'Legal',
  policy: {
    scope: 'legal',
    sensitivity: 'protected',
    protectedClass: 'legal_hold',
  },
};
const roots: readonly NotionGovernedRoot[] = [
  familyGovernedRoot,
  legalGovernedRoot,
];

const authorizedAccess = {
  brainScopes: ['family_shared'] as const,
  rootRefs: [familyRootRef],
};

const visibleRecord: BrainRecord = {
  brainRecordId: brainRecordId(
    `brn_notion_${visiblePageId.replaceAll('-', '')}`,
  ),
  title: 'Synthetic shared checklist',
  excerpt: 'Synthetic shared checklist',
  content:
    'Synthetic shared checklist.\nNested details\n- [x] Verify fictional result\n## After pagination',
  contentType: 'text/markdown',
  canonicalLocation: {
    provider: 'notion',
    containerRef: familyRootRef,
    displayPath: 'Family Shared / Synthetic shared checklist',
  },
  provenance: {
    provider: 'notion',
    providerRecordId: providerRecordId(visiblePageId),
    providerVersion: updatedTime,
    createdAt: new Date(createdTime),
    updatedAt: new Date(updatedTime),
  },
  policy: familyGovernedRoot.policy,
};

function provider(sdk = new SyntheticNotionSdk()): NotionKnowledgeProvider {
  return new NotionKnowledgeProvider(new OfficialNotionRetrievalClient(sdk), {
    roots,
  });
}

fetchableKnowledgeProviderContract({
  name: 'governed Notion retrieval adapter',
  provider: 'notion',
  getProvider: provider,
  visibleRecord,
  hiddenProviderRecordIds: [
    providerRecordId(legalPageId),
    providerRecordId(unregisteredPageId),
  ],
  authorizedAccess,
  unconfiguredRootRef: unregisteredRootRef,
  unconfiguredBrainScope: 'governance',
  matchingQuery: 'checklist',
  expectedCompleteness: {
    provider: 'notion',
    state: 'partial',
    errorCode: 'partial_results',
  },
});

describe('Notion governed retrieval behavior', () => {
  it('constructs the official SDK with the pinned API header and a bounded timeout', async () => {
    let headers: Readonly<Record<string, string>> | undefined;
    const sdk = createOfficialNotionSdkClient({
      auth: 'synthetic-notion-token',
      fetch: (_url, init) => {
        headers = init?.headers;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: () => Promise.resolve(JSON.stringify(searchPage([]))),
        });
      },
    });

    await sdk.search({ query: 'synthetic', page_size: 1 });

    expect(NOTION_CLIENT_TIMEOUT_MS).toBe(5_000);
    expect(headers?.['Notion-Version']).toBe(NOTION_API_VERSION);
  });

  it('times out one official SDK request without an automatic retry', async () => {
    vi.useFakeTimers();
    try {
      let fetchCalls = 0;
      const never = new Promise<never>(() => undefined);
      const sdk = createOfficialNotionSdkClient({
        auth: 'synthetic-notion-token',
        fetch: () => {
          fetchCalls += 1;
          return never;
        },
      });
      const rejection = expect(
        sdk.search({ query: 'synthetic', page_size: 1 }),
      ).rejects.toMatchObject({ code: ClientErrorCode.RequestTimeout });

      await vi.advanceTimersByTimeAsync(NOTION_CLIENT_TIMEOUT_MS + 1);

      await rejection;
      expect(fetchCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the latest explicit API version and page-only title search', async () => {
    const sdk = new SyntheticNotionSdk();
    await provider(sdk).search(
      { query: 'checklist', limit: 10, access: authorizedAccess },
      new AbortController().signal,
    );

    expect(NOTION_API_VERSION).toBe('2026-03-11');
    expect(sdk.searchCalls).toHaveLength(2);
    expect(sdk.searchCalls[0]).toMatchObject({
      query: 'checklist',
      filter: { property: 'object', value: 'page', in_trash: false },
      sort: { property: 'relevance' },
    });
  });

  it('rejects an SDK client that is not tagged for the pinned API version', () => {
    const sdk = new SyntheticNotionSdk({ apiVersion: '2025-09-03' });

    expect(() => new OfficialNotionRetrievalClient(sdk)).toThrow(
      'invalid_notion_client_configuration',
    );
  });

  it('paginates page blocks and recursively retrieves nested children', async () => {
    const sdk = new SyntheticNotionSdk();
    const fetched = await provider(sdk).fetch(
      {
        providerRecordId: providerRecordId(visiblePageId),
        access: authorizedAccess,
      },
      new AbortController().signal,
    );

    expect(fetched).toEqual(visibleRecord);
    expect(
      sdk.childCalls.map((call) => [call.block_id, call.start_cursor]),
    ).toEqual([
      [visiblePageId, undefined],
      [toggleId, undefined],
      [visiblePageId, 'synthetic-next-cursor'],
    ]);
  });

  it('fails safely when search or block pagination omits a required cursor', async () => {
    const searchSdk = new SyntheticNotionSdk({
      searchOverride: () =>
        Promise.resolve({
          ...searchPage([]),
          has_more: true,
          next_cursor: null,
        }),
    });
    await expect(
      provider(searchSdk).search(
        { query: 'synthetic', limit: 10, access: authorizedAccess },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(searchSdk.searchCalls).toHaveLength(1);

    const blockSdk = new SyntheticNotionSdk({
      childOverride: () =>
        Promise.resolve({
          ...blockPage([]),
          has_more: true,
          next_cursor: null,
        }),
    });
    await expect(
      provider(blockSdk).fetch(
        {
          providerRecordId: providerRecordId(visiblePageId),
          access: authorizedAccess,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(blockSdk.childCalls).toHaveLength(1);
  });

  it('fails safely when search or block pagination repeats a cursor', async () => {
    const searchSdk = new SyntheticNotionSdk({
      searchOverride: () => Promise.resolve(searchPage([], 'repeated-cursor')),
    });
    await expect(
      provider(searchSdk).search(
        { query: 'synthetic', limit: 10, access: authorizedAccess },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(searchSdk.searchCalls).toHaveLength(2);

    const blockSdk = new SyntheticNotionSdk({
      childOverride: () => Promise.resolve(blockPage([], 'repeated-cursor')),
    });
    await expect(
      provider(blockSdk).fetch(
        {
          providerRecordId: providerRecordId(visiblePageId),
          access: authorizedAccess,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(blockSdk.childCalls).toHaveLength(2);
  });

  it('caps title-search pagination while retaining an honest partial result', async () => {
    let pageNumber = 0;
    const sdk = new SyntheticNotionSdk({
      searchOverride: () => {
        pageNumber += 1;
        return Promise.resolve(searchPage([], `cursor-${String(pageNumber)}`));
      },
    });

    await expect(
      provider(sdk).search(
        { query: 'synthetic', limit: 10, access: authorizedAccess },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      records: [],
      completeness: {
        provider: 'notion',
        state: 'partial',
        errorCode: 'partial_results',
      },
    });
    expect(sdk.searchCalls).toHaveLength(100);
  });

  it('caps recursive block depth before issuing another SDK request', async () => {
    let childNumber = 0;
    const sdk = new SyntheticNotionSdk({
      childOverride: (args) => {
        childNumber += 1;
        return Promise.resolve(
          blockPage([
            toggleBlock(
              `synthetic-nested-block-${String(childNumber)}`,
              args.block_id,
              `Synthetic level ${String(childNumber)}`,
            ),
          ]),
        );
      },
    });

    await expect(
      provider(sdk).fetch(
        {
          providerRecordId: providerRecordId(visiblePageId),
          access: authorizedAccess,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(sdk.childCalls).toHaveLength(65);
  });

  it('caps paginated block requests before another SDK call', async () => {
    let pageNumber = 0;
    const sdk = new SyntheticNotionSdk({
      childOverride: () => {
        pageNumber += 1;
        return Promise.resolve(blockPage([], `cursor-${String(pageNumber)}`));
      },
    });

    await expect(
      provider(sdk).fetch(
        {
          providerRecordId: providerRecordId(visiblePageId),
          access: authorizedAccess,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(sdk.childCalls).toHaveLength(1_024);
  });

  it('caps total block count before consuming another provider page', async () => {
    let pageNumber = 0;
    let blockNumber = 0;
    const sdk = new SyntheticNotionSdk({
      childOverride: (args) => {
        pageNumber += 1;
        const blocks = Array.from({ length: 100 }, () => {
          blockNumber += 1;
          return paragraphBlock(
            `synthetic-counted-block-${String(blockNumber)}`,
            args.block_id,
            `Synthetic counted line ${String(blockNumber)}`,
          );
        });
        return Promise.resolve(
          blockPage(blocks, `cursor-${String(pageNumber)}`),
        );
      },
    });

    await expect(
      provider(sdk).fetch(
        {
          providerRecordId: providerRecordId(visiblePageId),
          access: authorizedAccess,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(sdk.childCalls).toHaveLength(100);
  });

  it('fails safely on a cyclic provider ancestry graph', async () => {
    const firstPageId = '10000000-0000-4000-8000-000000000201';
    const secondPageId = '10000000-0000-4000-8000-000000000202';
    const sdk = new SyntheticNotionSdk({
      extraPages: [
        page(firstPageId, 'Synthetic cycle one', {
          type: 'page_id',
          page_id: secondPageId,
        }),
        page(secondPageId, 'Synthetic cycle two', {
          type: 'page_id',
          page_id: firstPageId,
        }),
      ],
    });

    await expect(
      provider(sdk).fetch(
        {
          providerRecordId: providerRecordId(firstPageId),
          access: authorizedAccess,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
  });

  it('caps provider ancestry traversal before another SDK request', async () => {
    const firstPageId = '10000000-0000-4000-8000-000000000300';
    const chain = Array.from({ length: 66 }, (_, index) => {
      const id = `10000000-0000-4000-8000-${String(300 + index).padStart(12, '0')}`;
      const nextId = `10000000-0000-4000-8000-${String(301 + index).padStart(12, '0')}`;
      return page(
        id,
        `Synthetic ancestry ${String(index)}`,
        index === 65
          ? { type: 'workspace', workspace: true }
          : { type: 'page_id', page_id: nextId },
      );
    });
    const sdk = new SyntheticNotionSdk({ extraPages: chain });

    await expect(
      provider(sdk).fetch(
        {
          providerRecordId: providerRecordId(firstPageId),
          access: authorizedAccess,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(sdk.pageCalls).toHaveLength(64);
  });

  it('stops at the nearest configured root instead of falling through to an authorized ancestor', async () => {
    const nestedLegalRootId = '10000000-0000-4000-8000-000000000004';
    const nestedLegalPageId = '10000000-0000-4000-8000-000000000104';
    const nestedLegalRoot = page(nestedLegalRootId, 'Nested Legal', {
      type: 'page_id',
      page_id: familyRootId,
    });
    const nestedLegalPage = page(nestedLegalPageId, 'Nested restricted page', {
      type: 'page_id',
      page_id: nestedLegalRootId,
    });
    const sdk = new SyntheticNotionSdk({
      extraPages: [nestedLegalRoot, nestedLegalPage],
    });
    const nestedProvider = new NotionKnowledgeProvider(
      new OfficialNotionRetrievalClient(sdk),
      {
        roots: [
          familyGovernedRoot,
          {
            ...legalGovernedRoot,
            notionObject: { kind: 'page', id: nestedLegalRootId },
          },
        ],
      },
    );

    await expect(
      nestedProvider.fetch(
        {
          providerRecordId: providerRecordId(nestedLegalPageId),
          access: authorizedAccess,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'not_found', retryable: false });
  });

  it('snapshots server-derived access before awaiting the provider', async () => {
    let releaseSearch: ((response: SearchResponse) => void) | undefined;
    const pendingSearch = new Promise<SearchResponse>((resolve) => {
      releaseSearch = resolve;
    });
    const mutableAccess: {
      brainScopes: BrainScope[];
      rootRefs: string[];
    } = {
      brainScopes: ['family_shared'],
      rootRefs: [familyRootRef],
    };
    const search = provider(
      new SyntheticNotionSdk({ searchOverride: () => pendingSearch }),
    ).search(
      { query: 'legal', limit: 10, access: mutableAccess },
      new AbortController().signal,
    );

    mutableAccess.brainScopes.push('legal');
    mutableAccess.rootRefs.push(legalRootRef);
    releaseSearch?.(searchPage([legalPage]));

    await expect(search).resolves.toEqual({
      records: [],
      completeness: {
        provider: 'notion',
        state: 'partial',
        errorCode: 'partial_results',
      },
    });
  });

  it('authorizes a page directly parented by a configured data source root', async () => {
    const dataSourceId = '10000000-0000-4000-8000-000000000005';
    const dataSourcePageId = '10000000-0000-4000-8000-000000000105';
    const dataSourcePage = page(dataSourcePageId, 'Synthetic data row', {
      type: 'data_source_id',
      data_source_id: dataSourceId,
      database_id: '10000000-0000-4000-8000-000000000006',
    });
    const rootRef = 'notion://development/structured-family-shared';
    const dataSourceRoot: NotionGovernedRoot = {
      rootRef,
      notionObject: { kind: 'data_source', id: dataSourceId },
      displayPath: 'Family Shared / Structured',
      policy: familyGovernedRoot.policy,
    };
    const retrievalClient = new OfficialNotionRetrievalClient(
      new SyntheticNotionSdk({ extraPages: [dataSourcePage] }),
    );
    const snapshot = await retrievalClient.retrievePage(
      dataSourcePageId,
      new AbortController().signal,
    );
    expect(snapshot).toMatchObject({
      id: dataSourcePageId,
      parent: { kind: 'data_source', id: dataSourceId },
    });
    await expect(
      new NotionScopeGuard(retrievalClient, [
        dataSourceRoot,
      ]).resolveAuthorizedRoot(
        snapshot,
        { brainScopes: ['family_shared'], rootRefs: [rootRef] },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ rootRef });
    await expect(
      retrievalClient.listBlockChildren(
        { blockId: dataSourcePageId, pageSize: 100 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ blocks: [], hasMore: false });
    const dataSourceProvider = new NotionKnowledgeProvider(retrievalClient, {
      roots: [dataSourceRoot],
    });

    await expect(
      dataSourceProvider.fetch(
        {
          providerRecordId: providerRecordId(dataSourcePageId),
          access: { brainScopes: ['family_shared'], rootRefs: [rootRef] },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      title: 'Synthetic data row',
      canonicalLocation: { containerRef: rootRef },
      policy: familyGovernedRoot.policy,
    });
  });

  it('rejects a workspace-wide root even when runtime input bypasses TypeScript', () => {
    const broadRoot = {
      ...familyGovernedRoot,
      notionObject: { kind: 'workspace', id: 'workspace' },
    };

    expect(
      () =>
        new NotionKnowledgeProvider(
          new OfficialNotionRetrievalClient(new SyntheticNotionSdk()),
          { roots: [broadRoot as never] },
        ),
    ).toThrow('invalid_notion_provider_configuration');
  });

  it('sanitizes arbitrary SDK failures without exposing provider details', async () => {
    const privateFailure = 'SYNTHETIC_PRIVATE_NOTION_TOKEN';
    const error = await provider(
      new SyntheticNotionSdk({ searchFailure: new Error(privateFailure) }),
    )
      .search(
        { query: 'checklist', limit: 10, access: authorizedAccess },
        new AbortController().signal,
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'notion_request_failed' },
    });
    expect(String(error)).not.toContain(privateFailure);
    expect(JSON.stringify(error)).not.toContain(privateFailure);
  });

  it('maps an SDK object-not-found response to the same safe fetch boundary', async () => {
    const privateFailure = 'SYNTHETIC_PRIVATE_NOTION_NOT_FOUND';
    const pageFailure = new APIResponseError({
      code: APIErrorCode.ObjectNotFound,
      status: 404,
      message: privateFailure,
      headers: {},
      rawBodyText: privateFailure,
      additional_data: undefined,
      request_id: 'synthetic-request-id',
    });
    const error = await provider(new SyntheticNotionSdk({ pageFailure }))
      .fetch(
        {
          providerRecordId: providerRecordId(
            '10000000-0000-4000-8000-000000000999',
          ),
          access: authorizedAccess,
        },
        new AbortController().signal,
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'not_found',
      retryable: false,
      details: { reason: 'record_not_found' },
    });
    expect(String(error)).not.toContain(privateFailure);
    expect(JSON.stringify(error)).not.toContain(privateFailure);
  });

  it('returns a safe cancellation while an SDK request is still pending', async () => {
    let settle: ((value: SearchResponse) => void) | undefined;
    const pending = new Promise<SearchResponse>((resolve) => {
      settle = resolve;
    });
    const sdk = new SyntheticNotionSdk({ searchOverride: () => pending });
    const controller = new AbortController();
    const result = provider(sdk).search(
      { query: 'checklist', limit: 10, access: authorizedAccess },
      controller.signal,
    );

    controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await result.catch((error: unknown) => {
      expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_ABORT_REASON');
      expect(JSON.stringify(error)).not.toContain(
        'SYNTHETIC_PRIVATE_ABORT_REASON',
      );
    });
    settle?.(searchPage([]));
  });
});
