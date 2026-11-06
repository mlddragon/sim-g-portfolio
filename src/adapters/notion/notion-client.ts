import {
  APIErrorCode,
  Client,
  LogLevel,
  isFullBlock,
  isFullDataSource,
  isFullDatabase,
  isFullPage,
  isNotionClientError,
  type BlockObjectResponse,
  type PageObjectResponse,
  type RichTextItemResponse,
} from '@notionhq/client';

export const NOTION_API_VERSION = '2026-03-11' as const;
export const NOTION_CLIENT_TIMEOUT_MS = 5_000;

type OfficialNotionFetch = NonNullable<
  NonNullable<ConstructorParameters<typeof Client>[0]>['fetch']
>;

export interface CreateOfficialNotionSdkClientOptions {
  readonly auth: string;
  /** Test/composition seam; production normally uses the SDK's global fetch. */
  readonly fetch?: OfficialNotionFetch;
}

export interface NotionSdkClient {
  readonly apiVersion: string;
  readonly search: Client['search'];
  readonly pages: Pick<Client['pages'], 'retrieve'>;
  readonly dataSources: Pick<Client['dataSources'], 'retrieve'>;
  readonly databases: Pick<Client['databases'], 'retrieve'>;
  readonly blocks: Pick<Client['blocks'], 'retrieve'> & {
    readonly children: Pick<Client['blocks']['children'], 'list'>;
  };
}

/** Narrow write surface used only by the Family Inbox projection adapter. */
export interface NotionFamilyInboxSdkClient {
  readonly apiVersion: string;
  readonly pages: Pick<Client['pages'], 'create' | 'retrieve' | 'update'>;
  readonly dataSources: Pick<Client['dataSources'], 'query'>;
}

/** Narrow SDK surface used only by governed record mutations. */
export interface NotionMutationSdkClient {
  readonly apiVersion: string;
  readonly pages: Pick<
    Client['pages'],
    'create' | 'retrieve' | 'update' | 'retrieveMarkdown' | 'updateMarkdown'
  >;
  readonly dataSources: Pick<Client['dataSources'], 'query'>;
}

function validAuth(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 8_192 ||
    value.trim() !== value
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 32 || codePoint === 127)) {
      return false;
    }
  }
  return true;
}

function createOfficialClient(
  options: CreateOfficialNotionSdkClientOptions,
): Client {
  const candidate: unknown = options;
  if (
    !isRecord(candidate) ||
    !validAuth(candidate['auth']) ||
    (candidate['fetch'] !== undefined &&
      typeof candidate['fetch'] !== 'function')
  ) {
    throw new TypeError('invalid_notion_client_configuration');
  }

  return new Client({
    auth: candidate['auth'],
    notionVersion: NOTION_API_VERSION,
    timeoutMs: NOTION_CLIENT_TIMEOUT_MS,
    retry: false,
    logLevel: LogLevel.ERROR,
    logger: () => undefined,
    ...(candidate['fetch'] === undefined
      ? {}
      : { fetch: candidate['fetch'] as OfficialNotionFetch }),
  });
}

/** Constructs the official SDK without exposing provider-specific options upstream. */
export function createOfficialNotionSdkClient(
  options: CreateOfficialNotionSdkClientOptions,
): NotionSdkClient {
  const client = createOfficialClient(options);

  return Object.freeze({
    apiVersion: NOTION_API_VERSION,
    search: client.search,
    pages: Object.freeze({ retrieve: client.pages.retrieve }),
    dataSources: Object.freeze({ retrieve: client.dataSources.retrieve }),
    databases: Object.freeze({ retrieve: client.databases.retrieve }),
    blocks: Object.freeze({
      retrieve: client.blocks.retrieve,
      children: Object.freeze({ list: client.blocks.children.list }),
    }),
  });
}

/** Constructs only the official methods needed to project safe approval state. */
export function createOfficialNotionFamilyInboxSdkClient(
  options: CreateOfficialNotionSdkClientOptions,
): NotionFamilyInboxSdkClient {
  const client = createOfficialClient(options);

  return Object.freeze({
    apiVersion: NOTION_API_VERSION,
    pages: Object.freeze({
      create: client.pages.create,
      retrieve: client.pages.retrieve,
      update: client.pages.update,
    }),
    dataSources: Object.freeze({ query: client.dataSources.query }),
  });
}

/** Constructs only the official methods required for governed record writes. */
export function createOfficialNotionMutationSdkClient(
  options: CreateOfficialNotionSdkClientOptions,
): NotionMutationSdkClient {
  const client = createOfficialClient(options);

  return Object.freeze({
    apiVersion: NOTION_API_VERSION,
    pages: Object.freeze({
      create: client.pages.create,
      retrieve: client.pages.retrieve,
      update: client.pages.update,
      retrieveMarkdown: client.pages.retrieveMarkdown,
      updateMarkdown: client.pages.updateMarkdown,
    }),
    dataSources: Object.freeze({ query: client.dataSources.query }),
  });
}

export type NotionObjectReference = {
  readonly kind: 'page' | 'data_source' | 'database' | 'block';
  readonly id: string;
};

export type NotionParentReference =
  NotionObjectReference | { readonly kind: 'terminal' };

export interface NotionPageSnapshot {
  readonly id: string;
  readonly title: string;
  readonly createdTime: string;
  readonly updatedTime: string;
  readonly inTrash: boolean;
  readonly parent: NotionParentReference;
}

export interface NotionSearchPage {
  readonly pages: readonly NotionPageSnapshot[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  readonly sourceComplete: boolean;
}

export interface NotionBlockSnapshot {
  readonly id: string;
  readonly text: string;
  readonly hasChildren: boolean;
}

export interface NotionBlockPage {
  readonly blocks: readonly NotionBlockSnapshot[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export interface NotionRetrievalClient {
  searchPages(
    request: {
      readonly query: string;
      readonly pageSize: number;
      readonly startCursor?: string;
    },
    signal: AbortSignal,
  ): Promise<NotionSearchPage>;
  retrievePage(
    pageId: string,
    signal: AbortSignal,
  ): Promise<NotionPageSnapshot>;
  retrieveParent(
    object: NotionObjectReference,
    signal: AbortSignal,
  ): Promise<NotionParentReference>;
  listBlockChildren(
    request: {
      readonly blockId: string;
      readonly pageSize: number;
      readonly startCursor?: string;
    },
    signal: AbortSignal,
  ): Promise<NotionBlockPage>;
}

/**
 * Notion reports object IDs dashed and lower case; configuration may use
 * other forms. Every comparison uses this canonical form, so a root written
 * differently can never silently fail to match.
 */
export function canonicalNotionId(id: string): string {
  const hex = id.replaceAll('-', '').toLowerCase();
  return /^[0-9a-f]{32}$/u.test(hex)
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : id;
}

export class NotionClientFailure extends Error {
  readonly kind: 'not_found' | 'unavailable';

  constructor(kind: 'not_found' | 'unavailable') {
    super('notion_client_failure');
    this.name = 'NotionClientFailure';
    this.kind = kind;
  }
}

function cancellation(): DOMException {
  return new DOMException('Provider operation cancelled', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function withCancellation<T>(
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
    Promise.resolve()
      .then(run)
      .then(
        (value) => {
          finish(() => {
            resolve(value);
          });
        },
        (error: unknown) => {
          finish(() => {
            reject(
              error instanceof Error
                ? error
                : new NotionClientFailure('unavailable'),
            );
          });
        },
      );
  });
}

function mapParent(
  parent: PageObjectResponse['parent'],
): NotionParentReference {
  switch (parent.type) {
    case 'page_id':
      return { kind: 'page', id: parent.page_id };
    case 'data_source_id':
      return { kind: 'data_source', id: parent.data_source_id };
    case 'database_id':
      return { kind: 'database', id: parent.database_id };
    case 'block_id':
      return { kind: 'block', id: parent.block_id };
    case 'agent_id':
    case 'workspace':
      return { kind: 'terminal' };
  }
}

function richTextContent(items: readonly RichTextItemResponse[]): string {
  return items.map((item) => item.plain_text).join('');
}

function pageTitle(page: PageObjectResponse): string {
  for (const property of Object.values(page.properties)) {
    if (property.type === 'title') {
      const title = richTextContent(property.title).trim();
      if (title.length > 0) return title;
    }
  }
  return 'Untitled Notion page';
}

function projectPage(page: PageObjectResponse): NotionPageSnapshot {
  return {
    id: page.id,
    title: pageTitle(page),
    createdTime: page.created_time,
    updatedTime: page.last_edited_time,
    inTrash: page.in_trash,
    parent: mapParent(page.parent),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function plainText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((item: unknown) =>
      isRecord(item) && typeof item['plain_text'] === 'string'
        ? item['plain_text']
        : '',
    )
    .join('');
}

function payloadFor(
  block: BlockObjectResponse,
): Readonly<Record<string, unknown>> {
  const raw = block as unknown as Readonly<Record<string, unknown>>;
  const payload = raw[block.type];
  return isRecord(payload) ? payload : {};
}

function blockText(block: BlockObjectResponse): string {
  const payload = payloadFor(block);
  const text = plainText(payload['rich_text']).trim();

  switch (block.type) {
    case 'heading_1':
      return text.length === 0 ? '' : `# ${text}`;
    case 'heading_2':
      return text.length === 0 ? '' : `## ${text}`;
    case 'heading_3':
      return text.length === 0 ? '' : `### ${text}`;
    case 'heading_4':
      return text.length === 0 ? '' : `#### ${text}`;
    case 'bulleted_list_item':
      return text.length === 0 ? '' : `- ${text}`;
    case 'numbered_list_item':
      return text.length === 0 ? '' : `1. ${text}`;
    case 'to_do':
      return text.length === 0
        ? ''
        : `- [${payload['checked'] === true ? 'x' : ' '}] ${text}`;
    case 'quote':
      return text.length === 0 ? '' : `> ${text}`;
    case 'code': {
      if (text.length === 0) return '';
      const language =
        typeof payload['language'] === 'string' &&
        /^[a-z0-9_+-]{1,32}$/iu.test(payload['language'])
          ? payload['language']
          : '';
      return `\`\`\`${language}\n${text}\n\`\`\``;
    }
    case 'equation':
      return typeof payload['expression'] === 'string'
        ? payload['expression']
        : '';
    case 'divider':
      return '---';
    case 'child_page':
    case 'child_database':
      return typeof payload['title'] === 'string' ? payload['title'] : '';
    case 'table_row': {
      const cells = payload['cells'];
      return Array.isArray(cells)
        ? cells.map((cell: unknown) => plainText(cell)).join(' | ')
        : '';
    }
    case 'bookmark':
    case 'embed':
    case 'image':
    case 'video':
    case 'pdf':
    case 'file':
    case 'audio':
      return plainText(payload['caption']).trim();
    case 'meeting_notes':
    case 'transcription':
      return plainText(payload['title']).trim();
    case 'callout':
    case 'paragraph':
    case 'template':
    case 'toggle':
      return text;
    case 'breadcrumb':
    case 'column':
    case 'column_list':
    case 'link_preview':
    case 'link_to_page':
    case 'synced_block':
    case 'tab':
    case 'table':
    case 'table_of_contents':
    case 'unsupported':
      return '';
  }
}

function projectBlock(block: BlockObjectResponse): NotionBlockSnapshot {
  return {
    id: block.id,
    text: blockText(block),
    hasChildren: block.has_children,
  };
}

export class OfficialNotionRetrievalClient implements NotionRetrievalClient {
  readonly #client: NotionSdkClient;

  constructor(client: NotionSdkClient) {
    if (client.apiVersion !== NOTION_API_VERSION) {
      throw new TypeError('invalid_notion_client_configuration');
    }
    this.#client = client;
  }

  async searchPages(
    request: {
      readonly query: string;
      readonly pageSize: number;
      readonly startCursor?: string;
    },
    signal: AbortSignal,
  ): Promise<NotionSearchPage> {
    const response = await this.call(signal, () =>
      this.#client.search({
        query: request.query,
        page_size: request.pageSize,
        filter: { property: 'object', value: 'page', in_trash: false },
        sort: { property: 'relevance' },
        ...(request.startCursor === undefined
          ? {}
          : { start_cursor: request.startCursor }),
      }),
    );
    const fullPages = response.results.filter(isFullPage);

    return {
      pages: fullPages.filter((page) => !page.in_trash).map(projectPage),
      hasMore: response.has_more,
      ...(response.next_cursor === null
        ? {}
        : { nextCursor: response.next_cursor }),
      sourceComplete:
        fullPages.length === response.results.length &&
        response.request_status?.type !== 'incomplete',
    };
  }

  async retrievePage(
    pageId: string,
    signal: AbortSignal,
  ): Promise<NotionPageSnapshot> {
    const response = await this.call(signal, () =>
      this.#client.pages.retrieve({ page_id: pageId }),
    );
    if (!isFullPage(response)) throw new NotionClientFailure('unavailable');
    return projectPage(response);
  }

  async retrieveParent(
    object: NotionObjectReference,
    signal: AbortSignal,
  ): Promise<NotionParentReference> {
    if (object.kind === 'page') {
      return (await this.retrievePage(object.id, signal)).parent;
    }

    if (object.kind === 'data_source') {
      const response = await this.call(signal, () =>
        this.#client.dataSources.retrieve({ data_source_id: object.id }),
      );
      if (!isFullDataSource(response)) {
        throw new NotionClientFailure('unavailable');
      }
      return mapParent(response.parent);
    }

    if (object.kind === 'database') {
      const response = await this.call(signal, () =>
        this.#client.databases.retrieve({ database_id: object.id }),
      );
      if (!isFullDatabase(response)) {
        throw new NotionClientFailure('unavailable');
      }
      return mapParent(response.parent);
    }

    const response = await this.call(signal, () =>
      this.#client.blocks.retrieve({ block_id: object.id }),
    );
    if (!isFullBlock(response)) throw new NotionClientFailure('unavailable');
    return mapParent(response.parent);
  }

  async listBlockChildren(
    request: {
      readonly blockId: string;
      readonly pageSize: number;
      readonly startCursor?: string;
    },
    signal: AbortSignal,
  ): Promise<NotionBlockPage> {
    const response = await this.call(signal, () =>
      this.#client.blocks.children.list({
        block_id: request.blockId,
        page_size: request.pageSize,
        ...(request.startCursor === undefined
          ? {}
          : { start_cursor: request.startCursor }),
      }),
    );
    const blocks = response.results.filter(isFullBlock);
    if (blocks.length !== response.results.length) {
      throw new NotionClientFailure('unavailable');
    }

    return {
      blocks: blocks.filter((block) => !block.in_trash).map(projectBlock),
      hasMore: response.has_more,
      ...(response.next_cursor === null
        ? {}
        : { nextCursor: response.next_cursor }),
    };
  }

  private async call<T>(
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await withCancellation(signal, run);
    } catch (error) {
      if (isAbortError(error)) throw cancellation();
      if (error instanceof NotionClientFailure) throw error;
      if (
        isNotionClientError(error) &&
        error.code === APIErrorCode.ObjectNotFound
      ) {
        throw new NotionClientFailure('not_found');
      }
      throw new NotionClientFailure('unavailable');
    }
  }
}
