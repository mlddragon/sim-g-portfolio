import type {
  AuthorizationEngine,
  RegisteredKnowledgeSurface,
} from '../domain/authorization/authorization-engine.js';
import { DomainError } from '../domain/errors.js';
import type { BrainRecordId } from '../domain/identifiers.js';
import type {
  FetchRecordRequest,
  FetchRecordResponse,
} from '../domain/operations.js';
import type { AuthenticatedPrincipal } from '../domain/principal.js';
import {
  type BrainRecord,
  knowledgeProviderNames,
  type KnowledgeProviderName,
} from '../domain/records.js';
import type { RequestContext } from '../domain/request-context.js';
import type { Clock } from '../ports/clock.js';
import type {
  FetchableKnowledgeProvider,
  ProviderAccessScope,
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

export type BrainFetchAliasStore = Pick<
  OperationalStateStore,
  'findBrainRecordAlias' | 'enqueueAuditEvent'
>;

export interface FetchRecordServiceOptions {
  readonly providerTimeoutMs: number;
  readonly telemetry?: TelemetrySink;
  readonly clock?: Clock;
}

const defaultOptions: FetchRecordServiceOptions = {
  providerTimeoutMs: 3_000,
};

class HiddenAuthorizationDenial extends Error {}

function notFound(): DomainError {
  return new DomainError('not_found', false, { reason: 'record_not_found' });
}

function readUnavailable(reason: string): DomainError {
  return new DomainError('provider_unavailable', true, { reason });
}

function projectRecord(
  record: BrainRecord,
  stableId: BrainRecordId,
): BrainRecord {
  return {
    brainRecordId: stableId,
    title: record.title,
    excerpt: record.excerpt.slice(0, 160),
    content: record.content,
    contentType: record.contentType,
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

/** Resolves an opaque alias, authorizes current state, and fetches one record. */
export class FetchRecordService {
  private readonly providers: ReadonlyMap<
    KnowledgeProviderName,
    FetchableKnowledgeProvider
  >;
  private readonly providerTimeoutMs: number;
  private readonly telemetry: TelemetrySink | undefined;
  private readonly clock: Clock | undefined;

  constructor(
    private readonly authorization: AuthorizationEngine,
    private readonly aliases: BrainFetchAliasStore,
    providers: readonly FetchableKnowledgeProvider[],
    private readonly surfaces: readonly RegisteredKnowledgeSurface[],
    options: Partial<FetchRecordServiceOptions> = {},
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

  async fetchRecord(
    authenticated: AuthenticatedPrincipal,
    requestContext: RequestContext,
    request: FetchRecordRequest,
    signal: AbortSignal,
  ): Promise<FetchRecordResponse> {
    assertAuthenticated(authenticated);
    const startedAt = readTimerStart(this.clock);
    let response: FetchRecordResponse;
    try {
      response = await this.executeFetch(authenticated, request, signal);
    } catch (error) {
      const cancelledRead =
        error instanceof DOMException && error.name === 'AbortError';
      const denied =
        error instanceof HiddenAuthorizationDenial ||
        (error instanceof DomainError && error.code === 'unauthorized');
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
        operation: 'fetch_record',
        brainRecordId: request.brainRecordId,
        outcome: denied ? 'DENIED' : cancelledRead ? 'CANCELLED' : 'FAILED',
        reasonCode: denied
          ? 'record_access_denied'
          : error instanceof DomainError
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
          operation: 'fetch_record',
          outcome: denied ? 'denied' : cancelledRead ? 'cancelled' : 'failed',
        },
      });
      observeTelemetry(this.telemetry, {
        kind: 'counter',
        name: 'error.total',
        value: 1,
        tags: {
          operation: 'fetch_record',
          code: denied
            ? 'unauthorized'
            : error instanceof DomainError
              ? error.code
              : 'read_failed',
        },
      });
      if (
        error instanceof DomainError &&
        error.details['reason'] === 'provider_fetch_timeout'
      ) {
        observeTelemetry(this.telemetry, {
          kind: 'counter',
          name: 'provider.timeout',
          value: 1,
        });
      }
      observeDuration(
        this.telemetry,
        this.clock,
        'request.duration',
        startedAt,
        {
          operation: 'fetch_record',
          outcome: denied ? 'denied' : cancelledRead ? 'cancelled' : 'failed',
        },
      );
      if (error instanceof HiddenAuthorizationDenial) throw notFound();
      throw error;
    }

    const record = response.record;
    await enqueueReadAudit(this.aliases, {
      eventType: 'brain.read.completed',
      requestId: requestContext.requestId,
      principalId: authenticated.principal.id,
      ...(requestContext.clientId === undefined
        ? {}
        : { clientId: requestContext.clientId }),
      operation: 'fetch_record',
      provider: record.provenance.provider,
      brainRecordId: record.brainRecordId,
      providerRecordId: record.provenance.providerRecordId,
      ...(record.provenance.providerVersion === undefined
        ? {}
        : { providerVersion: record.provenance.providerVersion }),
      ...(record.provenance.integrityHash === undefined
        ? {}
        : { integrityHash: record.provenance.integrityHash }),
      outcome: 'COMPLETED',
      reasonCode: 'fetch_complete',
      timestamp: requestContext.receivedAt,
    });
    observeTelemetry(this.telemetry, {
      kind: 'counter',
      name: 'request.total',
      value: 1,
      tags: { operation: 'fetch_record', outcome: 'complete' },
    });
    observeDuration(this.telemetry, this.clock, 'request.duration', startedAt, {
      operation: 'fetch_record',
      outcome: 'complete',
    });
    return response;
  }

  private async executeFetch(
    authenticated: AuthenticatedPrincipal,
    request: FetchRecordRequest,
    signal: AbortSignal,
  ): Promise<FetchRecordResponse> {
    assertActive(signal);
    let alias: BrainRecordAlias | null;
    try {
      alias = await this.aliases.findBrainRecordAlias(request.brainRecordId);
    } catch {
      throw readUnavailable('record_reference_store_unavailable');
    }
    assertActive(signal);
    if (alias === null) throw notFound();
    if (
      alias.brainRecordId !== request.brainRecordId ||
      alias.canonicalLocation.provider !== alias.provider
    ) {
      throw readUnavailable('record_reference_invalid');
    }

    const authorized = this.authorization
      .authorizedSearchSurfaces(authenticated.principal, this.surfaces)
      .filter(
        (surface) =>
          surface.provider === alias.provider &&
          surface.containerKey === alias.canonicalLocation.containerRef,
      );
    if (authorized.length === 0) throw new HiddenAuthorizationDenial();
    const access: ProviderAccessScope = {
      brainScopes: [...new Set(authorized.map((surface) => surface.scope))],
      rootRefs: [alias.canonicalLocation.containerRef],
    };
    const provider = this.providers.get(alias.provider);
    if (provider === undefined)
      throw readUnavailable('provider_not_configured');

    const providerStartedAt = readTimerStart(this.clock);
    let outcome;
    try {
      outcome = await runWithDeadline(
        (providerSignal) =>
          provider.fetch(
            { providerRecordId: alias.providerRecordId, access },
            providerSignal,
          ),
        signal,
        this.providerTimeoutMs,
      );
    } finally {
      observeDuration(
        this.telemetry,
        this.clock,
        'provider.duration',
        providerStartedAt,
        { provider: alias.provider, operation: 'fetch_record' },
      );
    }
    if (outcome.kind === 'timed_out') {
      throw readUnavailable('provider_fetch_timeout');
    }
    if (outcome.kind === 'failed') {
      assertActive(signal);
      if (outcome.error instanceof DomainError) throw outcome.error;
      throw readUnavailable('provider_fetch_failed');
    }
    const record = outcome.value;
    assertActive(signal);
    if (
      record.provenance.provider !== alias.provider ||
      record.canonicalLocation.provider !== alias.provider ||
      record.provenance.providerRecordId !== alias.providerRecordId ||
      record.canonicalLocation.containerRef !==
        alias.canonicalLocation.containerRef ||
      !access.brainScopes.includes(record.policy.scope)
    ) {
      throw readUnavailable('provider_record_reference_mismatch');
    }
    const decision = this.authorization.evaluate({
      principal: authenticated.principal,
      operation: 'fetch_record',
      scope: record.policy.scope,
      target: {
        scope: record.policy.scope,
        createdAt: record.provenance.createdAt,
        protectedClass: record.policy.protectedClass,
        ...(record.provenance.creatorPrincipalId === undefined
          ? {}
          : { creatorPrincipalId: record.provenance.creatorPrincipalId }),
        ...(record.provenance.providerVersion === undefined
          ? {}
          : { providerVersion: record.provenance.providerVersion }),
      },
    });
    if (decision.kind !== 'ALLOW') {
      throw new HiddenAuthorizationDenial();
    }
    return { record: projectRecord(record, alias.brainRecordId) };
  }
}
