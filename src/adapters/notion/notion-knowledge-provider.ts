import { DomainError } from '../../domain/errors.js';
import type { BrainRecord, BrainRecordSummary } from '../../domain/records.js';
import type {
  FetchableKnowledgeProvider,
  ProviderFetchRequest,
  ProviderSearchRequest,
  ProviderSearchResponse,
} from '../../ports/knowledge-provider.js';
import {
  NotionClientFailure,
  type NotionRetrievalClient,
} from './notion-client.js';
import { mapNotionRecord, mapNotionSummary } from './notion-record-mapper.js';
import {
  NotionScopeGuard,
  type NotionGovernedRoot,
} from './notion-scope-guard.js';

export type { NotionGovernedRoot } from './notion-scope-guard.js';

export interface NotionKnowledgeProviderOptions {
  readonly roots: readonly NotionGovernedRoot[];
}

const maxSearchLimit = 100;
const maxSearchPages = 100;
const blockPageSize = 100;
const maxBlockRequests = 1_024;
const maxBlockCount = 10_000;
const maxBlockDepth = 64;

interface BlockTraversalState {
  requests: number;
  blocks: number;
}

function invalidRequest(): DomainError {
  return new DomainError('invalid_request', false, {
    reason: 'invalid_provider_search_request',
  });
}

function notFound(): DomainError {
  return new DomainError('not_found', false, {
    reason: 'record_not_found',
  });
}

function unavailable(): DomainError {
  return new DomainError('provider_unavailable', true, {
    reason: 'notion_request_failed',
  });
}

function cancellation(): DOMException {
  return new DOMException('Provider operation cancelled', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export class NotionKnowledgeProvider implements FetchableKnowledgeProvider {
  readonly provider = 'notion' as const;
  readonly #client: NotionRetrievalClient;
  readonly #scopeGuard: NotionScopeGuard;

  constructor(
    client: NotionRetrievalClient,
    options: NotionKnowledgeProviderOptions,
  ) {
    this.#client = client;
    this.#scopeGuard = new NotionScopeGuard(client, options.roots);
  }

  async search(
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ): Promise<ProviderSearchResponse> {
    try {
      if (
        typeof request.query !== 'string' ||
        request.query.trim().length === 0 ||
        !Number.isInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > maxSearchLimit
      ) {
        throw invalidRequest();
      }
      const access = this.#scopeGuard.snapshotAccess(request.access);

      const records: BrainRecordSummary[] = [];
      const recordIds = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;

      for (let pageNumber = 0; pageNumber < maxSearchPages; pageNumber += 1) {
        const page = await this.#client.searchPages(
          {
            query: request.query,
            pageSize: Math.min(request.limit, maxSearchLimit),
            ...(cursor === undefined ? {} : { startCursor: cursor }),
          },
          signal,
        );

        for (const candidate of page.pages) {
          const root = await this.#scopeGuard.resolveAuthorizedRoot(
            candidate,
            access,
            signal,
          );
          if (root === undefined || recordIds.has(candidate.id)) continue;
          records.push(mapNotionSummary(candidate, root));
          recordIds.add(candidate.id);
          if (records.length === request.limit) break;
        }

        if (records.length === request.limit || !page.hasMore) break;
        if (page.nextCursor === undefined || cursors.has(page.nextCursor)) {
          throw new NotionClientFailure('unavailable');
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }

      return {
        records,
        completeness: {
          provider: 'notion',
          state: 'partial',
          errorCode: 'partial_results',
        },
      };
    } catch (error) {
      throw this.safeError(error, false);
    }
  }

  async fetch(
    request: ProviderFetchRequest,
    signal: AbortSignal,
  ): Promise<BrainRecord> {
    try {
      const access = this.#scopeGuard.snapshotAccess(request.access);
      const page = await this.#client.retrievePage(
        request.providerRecordId,
        signal,
      );
      const root = await this.#scopeGuard.resolveAuthorizedRoot(
        page,
        access,
        signal,
      );
      if (root === undefined) throw notFound();

      const lines = await this.readChildren(
        page.id,
        signal,
        { requests: 0, blocks: 0 },
        0,
      );
      return mapNotionRecord(page, root, lines.join('\n').trim());
    } catch (error) {
      throw this.safeError(error, true);
    }
  }

  private async readChildren(
    blockId: string,
    signal: AbortSignal,
    state: BlockTraversalState,
    depth: number,
  ): Promise<string[]> {
    if (depth > maxBlockDepth) {
      throw new NotionClientFailure('unavailable');
    }

    const lines: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let hasMore: boolean;

    do {
      state.requests += 1;
      if (state.requests > maxBlockRequests) {
        throw new NotionClientFailure('unavailable');
      }
      const page = await this.#client.listBlockChildren(
        {
          blockId,
          pageSize: blockPageSize,
          ...(cursor === undefined ? {} : { startCursor: cursor }),
        },
        signal,
      );

      for (const block of page.blocks) {
        state.blocks += 1;
        if (state.blocks > maxBlockCount) {
          throw new NotionClientFailure('unavailable');
        }
        if (block.text.length > 0) lines.push(block.text);
        if (block.hasChildren) {
          lines.push(
            ...(await this.readChildren(block.id, signal, state, depth + 1)),
          );
        }
      }

      hasMore = page.hasMore;
      if (hasMore && state.blocks === maxBlockCount) {
        throw new NotionClientFailure('unavailable');
      }
      if (hasMore) {
        if (page.nextCursor === undefined || cursors.has(page.nextCursor)) {
          throw new NotionClientFailure('unavailable');
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    } while (hasMore);

    return lines;
  }

  private safeError(error: unknown, notFoundAllowed: boolean): unknown {
    if (error instanceof DomainError) return error;
    if (isAbortError(error)) return cancellation();
    if (
      error instanceof NotionClientFailure &&
      error.kind === 'not_found' &&
      notFoundAllowed
    ) {
      return notFound();
    }
    return unavailable();
  }
}
