import { readFileSync } from 'node:fs';

import { AuthorizationEngine } from '../../src/domain/authorization/authorization-engine.js';
import {
  brainRecordId,
  principalId,
  providerRecordId,
  requestId,
} from '../../src/domain/identifiers.js';
import { loadExecutablePolicy } from '../../src/domain/policy/policy-loader.js';
import type { AuthenticatedPrincipal } from '../../src/domain/principal.js';
import type {
  BrainRecord,
  BrainRecordSummary,
  BrainScope,
  KnowledgeProviderName,
} from '../../src/domain/records.js';
import type { RequestContext } from '../../src/domain/request-context.js';
import type {
  FetchableKnowledgeProvider,
  ProviderFetchRequest,
  ProviderSearchRequest,
  ProviderSearchResponse,
} from '../../src/ports/knowledge-provider.js';
import type {
  AuditOutboxRecord,
  BrainRecordAlias,
} from '../../src/ports/operational-state-store.js';
import type {
  TelemetryObservation,
  TelemetrySink,
} from '../../src/ports/telemetry-sink.js';
import type { AuditEvent } from '../../src/ports/audit-sink.js';

export const brainReadNow = new Date('2042-07-08T09:10:11.000Z');
const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);
export const brainReadAuthorization = new AuthorizationEngine(policy, {
  now: () => brainReadNow,
});

export const brainReadRoots = {
  notion: 'notion://development/family-shared',
  drive: 'drive://development/family-shared',
  github: 'repo:synthetic-owner/synthetic-project',
} as const;

export const brainReadSurfaces = (
  Object.entries(brainReadRoots) as [KnowledgeProviderName, string][]
).map(([provider, containerKey]) => ({
  provider,
  scope: 'family_shared' as const,
  containerKey,
}));

export function brainReadPrincipal(
  role: AuthenticatedPrincipal['principal']['role'] = 'owner_operator',
): AuthenticatedPrincipal {
  const key = role === 'family_participant' ? 'participant' : 'operator';
  const id = principalId(`prn_${key}`);
  return {
    principal: {
      id,
      key,
      displayName: key,
      role,
      status: 'active',
    },
    identity: {
      issuer: 'https://accounts.google.com',
      externalSubject: `synthetic-subject-${key}`,
      email: `${key}@example.invalid`,
      authenticatedAt: brainReadNow,
      principalId: id,
    },
  };
}

export function brainReadContext(suffix: string): RequestContext {
  return {
    requestId: requestId(`req_synthetic_${suffix}`),
    receivedAt: brainReadNow,
    clientId: 'synthetic-test-client',
  };
}

export function brainReadSummary(
  provider: KnowledgeProviderName,
  suffix: string,
  scope: BrainScope = 'family_shared',
): BrainRecordSummary {
  return {
    brainRecordId: brainRecordId(`brn_${provider}_${suffix}`),
    title: `Synthetic ${suffix}`,
    excerpt: `Synthetic ${suffix} excerpt`,
    canonicalLocation: {
      provider,
      containerRef: brainReadRoots[provider],
      displayPath: `Synthetic / ${suffix}`,
    },
    provenance: {
      provider,
      providerRecordId: providerRecordId(`${provider}-record-${suffix}`),
      providerVersion: `${provider}-version-${suffix}`,
      createdAt: new Date('2042-01-01T00:00:00.000Z'),
      updatedAt: new Date('2042-01-02T00:00:00.000Z'),
    },
    policy: {
      scope,
      sensitivity:
        scope === 'family_shared' ? 'family_shared' : 'parent_and_stewardship',
      protectedClass: 'none',
    },
  };
}

export function brainReadRecord(
  summary: BrainRecordSummary,
  content = 'Synthetic full body.',
): BrainRecord {
  return { ...summary, content, contentType: 'text/markdown' };
}

export function brainReadProvider(
  name: KnowledgeProviderName,
  search: (
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ) => Promise<ProviderSearchResponse>,
  fetch: (
    request: ProviderFetchRequest,
    signal: AbortSignal,
  ) => Promise<BrainRecord> = () =>
    Promise.reject(new Error('unexpected synthetic fetch')),
): FetchableKnowledgeProvider {
  return { provider: name, search, fetch };
}

export class SyntheticBrainReadStore {
  readonly auditEvents: AuditEvent[] = [];
  readonly #byBrainId = new Map<string, BrainRecordAlias>();
  readonly #byProvider = new Map<string, BrainRecordAlias>();

  ensureBrainRecordAlias(
    candidate: BrainRecordAlias,
  ): Promise<BrainRecordAlias> {
    const key = `${candidate.provider}:${String(candidate.providerRecordId)}`;
    const existing = this.#byProvider.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    this.#byBrainId.set(candidate.brainRecordId, candidate);
    this.#byProvider.set(key, candidate);
    return Promise.resolve(candidate);
  }

  findBrainRecordAlias(id: BrainRecordAlias['brainRecordId']) {
    return Promise.resolve(this.#byBrainId.get(id) ?? null);
  }

  enqueueAuditEvent(event: AuditEvent): Promise<AuditOutboxRecord> {
    this.auditEvents.push(event);
    return Promise.resolve({
      id: `audit-${String(event.requestId)}-${String(this.auditEvents.length)}`,
      event,
      attempts: 0,
      availableAt: event.timestamp,
    });
  }
}

export function brainReadTelemetry(): {
  readonly sink: TelemetrySink;
  readonly observations: TelemetryObservation[];
} {
  const observations: TelemetryObservation[] = [];
  return {
    observations,
    sink: {
      observe: (observation) => {
        observations.push(observation);
      },
    },
  };
}
