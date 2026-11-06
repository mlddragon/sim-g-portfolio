import type {
  AuthorizationEngine,
  RegisteredKnowledgeSurface,
} from '../domain/authorization/authorization-engine.js';
import type {
  FetchRecordRequest,
  FetchRecordResponse,
  SearchBrainRequest,
  SearchBrainResponse,
} from '../domain/operations.js';
import type { AuthenticatedPrincipal } from '../domain/principal.js';
import type { RequestContext } from '../domain/request-context.js';
import type { FetchableKnowledgeProvider } from '../ports/knowledge-provider.js';
import type { OperationalStateStore } from '../ports/operational-state-store.js';
import {
  FetchRecordService,
  type FetchRecordServiceOptions,
} from './fetch-record-service.js';
import {
  SearchBrainService,
  type SearchBrainServiceOptions,
} from './search-brain-service.js';

export type BrainRecordAliasStore = Pick<
  OperationalStateStore,
  'ensureBrainRecordAlias' | 'findBrainRecordAlias' | 'enqueueAuditEvent'
>;

export type BrainQueryServiceOptions = SearchBrainServiceOptions &
  FetchRecordServiceOptions;

/** Explicit two-operation facade; it does not expose provider-native methods. */
export class BrainQueryService {
  private readonly searchService: SearchBrainService;
  private readonly fetchService: FetchRecordService;

  constructor(
    authorization: AuthorizationEngine,
    aliases: BrainRecordAliasStore,
    providers: readonly FetchableKnowledgeProvider[],
    surfaces: readonly RegisteredKnowledgeSurface[],
    options: Partial<BrainQueryServiceOptions> = {},
  ) {
    this.searchService = new SearchBrainService(
      authorization,
      aliases,
      providers,
      surfaces,
      options,
    );
    this.fetchService = new FetchRecordService(
      authorization,
      aliases,
      providers,
      surfaces,
      options,
    );
  }

  searchBrain(
    authenticated: AuthenticatedPrincipal,
    requestContext: RequestContext,
    request: SearchBrainRequest,
    signal: AbortSignal,
  ): Promise<SearchBrainResponse> {
    return this.searchService.searchBrain(
      authenticated,
      requestContext,
      request,
      signal,
    );
  }

  fetchRecord(
    authenticated: AuthenticatedPrincipal,
    requestContext: RequestContext,
    request: FetchRecordRequest,
    signal: AbortSignal,
  ): Promise<FetchRecordResponse> {
    return this.fetchService.fetchRecord(
      authenticated,
      requestContext,
      request,
      signal,
    );
  }
}
