import type {
  AuthorizationEngine,
  RegisteredKnowledgeSurface,
} from '../domain/authorization/authorization-engine.js';
import { DomainError } from '../domain/errors.js';
import type { BrainRecordId } from '../domain/identifiers.js';
import type {
  SearchBrainRequest,
  SearchBrainResponse,
} from '../domain/operations.js';
import type { AuthenticatedPrincipal } from '../domain/principal.js';
import {
  knowledgeProviderNames,
  type BrainRecordSummary,
  type KnowledgeProviderName,
  type ProviderCompleteness,
} from '../domain/records.js';
import type { RequestContext } from '../domain/request-context.js';
import { rankAndDeduplicate } from '../domain/search/rank-and-deduplicate.js';
import type { Clock } from '../ports/clock.js';
import type {
  ProviderAccessScope,
  ProviderSearchResponse,
  SearchableKnowledgeProvider,
} from '../ports/knowledge-provider.js';
import type {
  BrainRecordAlias,
  OperationalStateStore,
} from '../ports/operational-state-store.js';
import type { TelemetrySink } from '../ports/telemetry-sink.js';
import {
  assertActive,
  assertAuthenticated,
  enqueueReadAudit,
  observeDuration,
  observeTelemetry,
  readTimerStart,
  runWithDeadline,
  validateProviderTimeout,
} from './brain-read-support.js';

export type BrainSearchAliasStore = Pick<
  OperationalStateStore,
  'ensureBrainRecordAlias' | 'enqueueAuditEvent'
>;

export interface SearchBrainServiceOptions {
  readonly providerTimeoutMs: number;
  readonly telemetry?: TelemetrySink;
  readonly clock?: Clock;
}

interface ProviderSearchOutcome {
  readonly records: readonly BrainRecordSummary[];
  readonly completeness: ProviderCompleteness;
}

interface PersistedProviderRecords {
  readonly records: readonly BrainRecordSummary[];
  readonly filtered: boolean;
}

const defaultOptions: SearchBrainServiceOptions = {
  providerTimeoutMs: 3_000,
};

function invalidRequest(): DomainError {
  return new DomainError('invalid_request', false, {
    reason: 'invalid_search_request',
  });
}

function readUnavailable(reason: string): DomainError {
  return new DomainError('provider_unavailable', true, { reason });
}

function unavailable(provider: KnowledgeProviderName): ProviderSearchOutcome {
  return {
    records: [],
    completeness: {
      provider,
      state: 'unavailable',
      errorCode: 'provider_unavailable',
    },
  };
}

function timedOut(provider: KnowledgeProviderName): ProviderSearchOutcome {
  return {
    records: [],
    completeness: {
      provider,
      state: 'timed_out',
      errorCode: 'provider_unavailable',
    },
  };
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 31 || point === 127)) return true;
  }
  return false;
}

function validateCompleteness(
  value: unknown,
  provider: KnowledgeProviderName,
): ProviderCompleteness | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate['provider'] !== provider) return null;
  const state = candidate['state'];
  const errorCode = candidate['errorCode'];
  if (state === 'complete' && errorCode === undefined) {
    return { provider, state };
  }
  if (
    state === 'partial' &&
    (errorCode === undefined || errorCode === 'partial_results')
  ) {
    return { provider, state, errorCode: 'partial_results' };
  }
  if (
    (state === 'unavailable' || state === 'timed_out') &&
    (errorCode === undefined || errorCode === 'provider_unavailable')
  ) {
    return { provider, state, errorCode: 'provider_unavailable' };
  }
  return null;
}

function projectSummary(
  record: BrainRecordSummary,
  stableId: BrainRecordId,
): BrainRecordSummary {
  return {
    brainRecordId: stableId,
    title: record.title,
    excerpt: record.excerpt.slice(0, 160),
    canonicalLocation: {
      provider: record.canonicalLocation.provider,
      containerRef: record.canonicalLocation.containerRef,
      ...(record.canonicalLocation.displayPath === undefined
        ? {}
        : { displayPath: record.canonicalLocation.displayPath }),
    },
    provenance: {
      provider: record.provenance.provider,
      providerRecordId: record.provenance.providerRecordId,
      ...(record.provenance.providerVersion === undefined
        ? {}
        : { providerVersion: record.provenance.providerVersion }),
      ...(record.provenance.creatorPrincipalId === undefined
        ? {}
        : { creatorPrincipalId: record.provenance.creatorPrincipalId }),
      createdAt: new Date(record.provenance.createdAt.getTime()),
      updatedAt: new Date(record.provenance.updatedAt.getTime()),
      ...(record.provenance.integrityHash === undefined
        ? {}
        : { integrityHash: record.provenance.integrityHash }),
    },
    policy: {
      scope: record.policy.scope,
      sensitivity: record.policy.sensitivity,
      protectedClass: record.policy.protectedClass,
    },
    ...(record.relevanceScore === undefined
      ? {}
      : { relevanceScore: record.relevanceScore }),
  };
}

/** Provider-neutral parallel search after authoritative authentication. */
export class SearchBrainService {
  private readonly providers: ReadonlyMap<
    KnowledgeProviderName,
    SearchableKnowledgeProvider
  >;
  private readonly providerTimeoutMs: number;
  private readonly telemetry: TelemetrySink | undefined;
  private readonly clock: Clock | undefined;

  constructor(
    private readonly authorization: AuthorizationEngine,
    private readonly aliases: BrainSearchAliasStore,
    providers: readonly SearchableKnowledgeProvider[],
    private readonly surfaces: readonly RegisteredKnowledgeSurface[],
    options: Partial<SearchBrainServiceOptions> = {},
  ) {
    const byName = new Map(
      providers.map((provider) => [provider.provider, provider]),
    );
    if (
      providers.length !== knowledgeProviderNames.length ||
      byName.size !== knowledgeProviderNames.length ||
      knowledgeProviderNames.some((provider) => !byName.has(provider))
    ) {
      throw new TypeError('invalid_brain_query_provider_configuration');
    }
    this.providers = byName;
    this.providerTimeoutMs =
      options.providerTimeoutMs ?? defaultOptions.providerTimeoutMs;
    this.telemetry = options.telemetry;
    this.clock = options.clock;
    validateProviderTimeout(this.providerTimeoutMs);
    if (this.telemetry !== undefined && this.clock === undefined) {
      throw new TypeError('invalid_brain_query_options');
    }
  }

  async searchBrain(
    authenticated: AuthenticatedPrincipal,
    requestContext: RequestContext,
    request: SearchBrainRequest,
    signal: AbortSignal,
  ): Promise<SearchBrainResponse> {
    assertAuthenticated(authenticated);
    const startedAt = readTimerStart(this.clock);
    let response: SearchBrainResponse;
    try {
      response = await this.executeSearch(
        authenticated,
        requestContext,
        request,
        signal,
      );
    } catch (error) {
      const cancelledRead =
        error instanceof DOMException && error.name === 'AbortError';
      const denied =
        error instanceof DomainError && error.code === 'unauthorized';
      await enqueueReadAudit(this.aliases, {
        eventType: denied
          ? 'brain.read.denied'
          : cancelledRead
            ? 'brain.read.cancelled'
            : 'brain.read.failed',
        requestId: requestContext.requestId,
        principalId: authenticated.principal.id,
        ...(requestContext.clientId === undefined
          ? {}
          : { clientId: requestContext.clientId }),
        operation: 'search_brain',
        outcome: denied ? 'DENIED' : cancelledRead ? 'CANCELLED' : 'FAILED',
        reasonCode:
          error instanceof DomainError
            ? `read_${error.code}`
            : cancelledRead
              ? 'read_cancelled'
              : 'read_failed',
        timestamp: requestContext.receivedAt,
      });
      observeTelemetry(this.telemetry, {
        kind: 'counter',
        name: 'request.total',
        value: 1,
        tags: {
          operation: 'search_brain',
          outcome: denied ? 'denied' : cancelledRead ? 'cancelled' : 'failed',
        },
      });
      observeTelemetry(this.telemetry, {
        kind: 'counter',
        name: 'error.total',
        value: 1,
        tags: {
          operation: 'search_brain',
          code: error instanceof DomainError ? error.code : 'read_failed',
        },
      });
      observeDuration(
        this.telemetry,
        this.clock,
        'request.duration',
        startedAt,
        {
          operation: 'search_brain',
          outcome: denied ? 'denied' : cancelledRead ? 'cancelled' : 'failed',
        },
      );
      throw error;
    }

    const partial = !response.completeness.complete;
    await enqueueReadAudit(this.aliases, {
      eventType: partial ? 'brain.read.partial' : 'brain.read.completed',
      requestId: requestContext.requestId,
      principalId: authenticated.principal.id,
      ...(requestContext.clientId === undefined
        ? {}
        : { clientId: requestContext.clientId }),
      operation: 'search_brain',
      outcome: 'COMPLETED',
      reasonCode: partial ? 'partial_results' : 'search_complete',
      timestamp: requestContext.receivedAt,
    });
    observeTelemetry(this.telemetry, {
      kind: 'counter',
      name: 'request.total',
      value: 1,
      tags: {
        operation: 'search_brain',
        outcome: partial ? 'partial' : 'complete',
      },
    });
    observeDuration(this.telemetry, this.clock, 'request.duration', startedAt, {
      operation: 'search_brain',
      outcome: partial ? 'partial' : 'complete',
    });
    if (partial) {
      observeTelemetry(this.telemetry, {
        kind: 'counter',
        name: 'search.partial',
        value: 1,
      });
    }
    for (const provider of response.completeness.providers) {
      if (provider.state === 'timed_out') {
        observeTelemetry(this.telemetry, {
          kind: 'counter',
          name: 'provider.timeout',
          value: 1,
          tags: { provider: provider.provider },
        });
      }
    }
    return response;
  }

  private async executeSearch(
    authenticated: AuthenticatedPrincipal,
    requestContext: RequestContext,
    request: SearchBrainRequest,
    signal: AbortSignal,
  ): Promise<SearchBrainResponse> {
    assertActive(signal);
    if (
      typeof request.query !== 'string' ||
      request.query.length === 0 ||
      request.query.length > 200 ||
      request.query.trim() !== request.query ||
      containsControlCharacter(request.query) ||
      !/[\p{L}\p{N}]/u.test(request.query) ||
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100
    ) {
      throw invalidRequest();
    }

    const authorized = this.authorization.authorizedSearchSurfaces(
      authenticated.principal,
      this.surfaces,
    );
    const outcomes = await Promise.all(
      knowledgeProviderNames.map(async (providerName) => {
        const providerSurfaces = authorized.filter(
          (surface) => surface.provider === providerName,
        );
        const access: ProviderAccessScope = {
          brainScopes: providerSurfaces.map((surface) => surface.scope),
          rootRefs: providerSurfaces.map((surface) => surface.containerKey),
        };
        // A provider that cannot serve at all is visibly unavailable, not
        // complete for lack of surfaces.
        if (this.providers.get(providerName)?.availability === 'unavailable') {
          return {
            records: [],
            completeness: {
              provider: providerName,
              state: 'unavailable',
              errorCode: 'provider_unavailable',
            },
          } satisfies ProviderSearchOutcome;
        }
        if (access.rootRefs.length === 0) {
          return {
            records: [],
            completeness: { provider: providerName, state: 'complete' },
          } satisfies ProviderSearchOutcome;
        }
        return this.searchProvider(
          providerName,
          request,
          access,
          authenticated,
          requestContext,
          signal,
        );
      }),
    );

    const results = rankAndDeduplicate(
      request.query,
      outcomes.flatMap((outcome) => outcome.records),
      request.limit,
    );
    const completeness = outcomes.map((outcome) => outcome.completeness);
    assertActive(signal);
    return {
      requestId: requestContext.requestId,
      results,
      completeness: {
        complete: completeness.every((entry) => entry.state === 'complete'),
        providers: completeness,
      },
    };
  }

  private async searchProvider(
    providerName: KnowledgeProviderName,
    request: SearchBrainRequest,
    access: ProviderAccessScope,
    authenticated: AuthenticatedPrincipal,
    requestContext: RequestContext,
    signal: AbortSignal,
  ): Promise<ProviderSearchOutcome> {
    const startedAt = readTimerStart(this.clock);
    try {
      const provider = this.providers.get(providerName);
      if (provider === undefined) return unavailable(providerName);
      const outcome = await runWithDeadline(
        (providerSignal) =>
          provider.search(
            { query: request.query, limit: request.limit, access },
            providerSignal,
          ),
        signal,
        this.providerTimeoutMs,
      );
      if (outcome.kind === 'timed_out') return timedOut(providerName);
      if (outcome.kind === 'failed') return unavailable(providerName);
      const response = outcome.value;
      const providerCompleteness = validateCompleteness(
        response.completeness,
        providerName,
      );
      if (providerCompleteness === null) return unavailable(providerName);
      if (
        providerCompleteness.state === 'unavailable' ||
        providerCompleteness.state === 'timed_out'
      ) {
        return { records: [], completeness: providerCompleteness };
      }
      const persisted = await this.persistAliases(
        providerName,
        response,
        access,
        authenticated,
        requestContext,
        request.limit,
        signal,
      );
      return {
        records: persisted.records,
        completeness:
          persisted.filtered && providerCompleteness.state === 'complete'
            ? {
                provider: providerName,
                state: 'partial',
                errorCode: 'partial_results',
              }
            : providerCompleteness,
      };
    } catch (error) {
      assertActive(signal);
      if (error instanceof DOMException && error.name === 'AbortError') {
        return timedOut(providerName);
      }
      return unavailable(providerName);
    } finally {
      observeDuration(
        this.telemetry,
        this.clock,
        'provider.duration',
        startedAt,
        { provider: providerName, operation: 'search_brain' },
      );
    }
  }

  private async persistAliases(
    provider: KnowledgeProviderName,
    response: ProviderSearchResponse,
    access: ProviderAccessScope,
    authenticated: AuthenticatedPrincipal,
    requestContext: RequestContext,
    limit: number,
    signal: AbortSignal,
  ): Promise<PersistedProviderRecords> {
    const records: BrainRecordSummary[] = [];
    let filtered = response.records.length > limit;
    for (const record of response.records.slice(0, limit)) {
      assertActive(signal);
      if (
        record.provenance.provider !== provider ||
        record.canonicalLocation.provider !== provider ||
        !access.brainScopes.includes(record.policy.scope) ||
        !access.rootRefs.includes(record.canonicalLocation.containerRef)
      ) {
        filtered = true;
        continue;
      }
      const decision = this.authorization.evaluate({
        principal: authenticated.principal,
        operation: 'search_brain',
        scope: record.policy.scope,
      });
      if (decision.kind !== 'ALLOW') {
        filtered = true;
        continue;
      }
      const candidate: BrainRecordAlias = {
        brainRecordId: record.brainRecordId,
        provider,
        providerRecordId: record.provenance.providerRecordId,
        canonicalLocation: record.canonicalLocation,
        createdAt: requestContext.receivedAt,
        updatedAt: requestContext.receivedAt,
      };
      const alias = await this.aliases.ensureBrainRecordAlias(candidate);
      assertActive(signal);
      if (
        alias.provider !== provider ||
        alias.providerRecordId !== record.provenance.providerRecordId ||
        alias.canonicalLocation.provider !== provider
      ) {
        throw readUnavailable('record_reference_invalid');
      }
      records.push(projectSummary(record, alias.brainRecordId));
    }
    return { records, filtered };
  }
}
