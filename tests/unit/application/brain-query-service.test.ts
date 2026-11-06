import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrainQueryService } from '../../../src/application/brain-query-service.js';
import { AuthorizationEngine } from '../../../src/domain/authorization/authorization-engine.js';
import {
  brainRecordId,
  principalId,
  providerRecordId,
  requestId,
} from '../../../src/domain/identifiers.js';
import { loadExecutablePolicy } from '../../../src/domain/policy/policy-loader.js';
import type { AuthenticatedPrincipal } from '../../../src/domain/principal.js';
import type {
  BrainRecord,
  BrainRecordSummary,
  BrainScope,
  KnowledgeProviderName,
} from '../../../src/domain/records.js';
import { knowledgeProviderNames } from '../../../src/domain/records.js';
import type { RequestContext } from '../../../src/domain/request-context.js';
import type {
  FetchableKnowledgeProvider,
  ProviderFetchRequest,
  ProviderSearchRequest,
  ProviderSearchResponse,
} from '../../../src/ports/knowledge-provider.js';
import type {
  BrainRecordAlias,
  OperationalStateStore,
} from '../../../src/ports/operational-state-store.js';

const now = new Date('2042-07-08T09:10:11.000Z');
const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);
const authorization = new AuthorizationEngine(policy, { now: () => now });

const roots = {
  notion: 'notion://development/family-shared',
  drive: 'drive://development/family-shared',
  github: 'repo:synthetic-owner/synthetic-project',
} as const;

const surfaces = (
  Object.entries(roots) as [KnowledgeProviderName, string][]
).map(([provider, containerKey]) => ({
  provider,
  scope: 'family_shared' as const,
  containerKey,
}));

function authenticatedPrincipal(
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
      authenticatedAt: now,
      principalId: id,
    },
  };
}

function context(): RequestContext {
  return {
    requestId: requestId('req_synthetic_unified_search'),
    receivedAt: now,
  };
}

function summary(
  provider: KnowledgeProviderName,
  suffix: string,
  relevanceScore: number,
  scope: BrainScope = 'family_shared',
): BrainRecordSummary {
  return {
    brainRecordId: brainRecordId(`brn_${provider}_${suffix}`),
    title: `Synthetic ${suffix}`,
    excerpt: `Synthetic ${suffix} excerpt`,
    relevanceScore,
    canonicalLocation: {
      provider,
      containerRef: roots[provider],
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
      sensitivity: 'family_shared',
      protectedClass: 'none',
    },
  };
}

type AliasStore = Pick<
  OperationalStateStore,
  'ensureBrainRecordAlias' | 'findBrainRecordAlias' | 'enqueueAuditEvent'
>;

function aliasStore(): AliasStore {
  const byBrainId = new Map<string, BrainRecordAlias>();
  const byProvider = new Map<string, BrainRecordAlias>();
  return {
    ensureBrainRecordAlias: (candidate) => {
      const providerKey = `${candidate.provider}:${String(candidate.providerRecordId)}`;
      const existing = byProvider.get(providerKey);
      if (existing !== undefined) return Promise.resolve(existing);
      byBrainId.set(candidate.brainRecordId, candidate);
      byProvider.set(providerKey, candidate);
      return Promise.resolve(candidate);
    },
    findBrainRecordAlias: (id) => Promise.resolve(byBrainId.get(id) ?? null),
    enqueueAuditEvent: (event) =>
      Promise.resolve({
        id: `audit-${String(event.requestId)}-${event.operation}`,
        event,
        attempts: 0,
        availableAt: event.timestamp,
      }),
  };
}

function provider(
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
  return {
    provider: name,
    search,
    fetch,
  };
}

function fullRecord(value: BrainRecordSummary, content: string): BrainRecord {
  return {
    ...value,
    content,
    contentType: 'text/markdown',
  };
}

describe('BrainQueryService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fans out concurrently with server-derived access, then ranks and deduplicates deterministically', async () => {
    const started: KnowledgeProviderName[] = [];
    const observed = new Map<KnowledgeProviderName, ProviderSearchRequest>();
    const releases = new Map<
      KnowledgeProviderName,
      ReturnType<typeof Promise.withResolvers<ProviderSearchResponse>>
    >();
    const notion = summary('notion', 'shared', 0.6);
    const drive = summary('drive', 'drive', 0.9);
    const github = summary('github', 'github', 0.6);
    const responses: Record<KnowledgeProviderName, ProviderSearchResponse> = {
      notion: {
        records: [notion, { ...notion, relevanceScore: 0.2 }],
        completeness: { provider: 'notion', state: 'complete' },
      },
      drive: {
        records: [drive],
        completeness: { provider: 'drive', state: 'complete' },
      },
      github: {
        records: [github],
        completeness: { provider: 'github', state: 'complete' },
      },
    };
    const providers = (Object.keys(responses) as KnowledgeProviderName[]).map(
      (name) =>
        provider(name, (request) => {
          started.push(name);
          observed.set(name, request);
          const release = Promise.withResolvers<ProviderSearchResponse>();
          releases.set(name, release);
          return release.promise;
        }),
    );
    const service = new BrainQueryService(
      authorization,
      aliasStore(),
      providers,
      surfaces,
    );

    const searching = service.searchBrain(
      authenticatedPrincipal(),
      context(),
      { query: 'Synthetic', limit: 10 },
      new AbortController().signal,
    );

    try {
      await vi.waitFor(() => {
        expect(new Set(started)).toEqual(
          new Set<KnowledgeProviderName>(['notion', 'drive', 'github']),
        );
      });
    } finally {
      for (const [name, release] of releases) release.resolve(responses[name]);
    }

    await expect(searching).resolves.toEqual({
      requestId: context().requestId,
      results: [notion, drive, github],
      completeness: {
        complete: true,
        providers: [
          { provider: 'notion', state: 'complete' },
          { provider: 'drive', state: 'complete' },
          { provider: 'github', state: 'complete' },
        ],
      },
    });
    for (const name of ['notion', 'drive', 'github'] as const) {
      expect(observed.get(name)).toEqual({
        query: 'Synthetic',
        limit: 10,
        access: {
          brainScopes: ['family_shared'],
          rootRefs: [roots[name]],
        },
      });
    }
  });

  it('returns successful results after a bounded provider timeout and reports every incomplete provider', async () => {
    vi.useFakeTimers();
    const notion = summary('notion', 'available', 0.8);
    let driveAborted = false;
    const providers = [
      provider('notion', () =>
        Promise.resolve({
          records: [notion],
          completeness: { provider: 'notion', state: 'complete' },
        }),
      ),
      provider(
        'drive',
        (_request, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                driveAborted = true;
                reject(new DOMException('synthetic abort', 'AbortError'));
              },
              { once: true },
            );
          }),
      ),
      provider('github', () =>
        Promise.reject(new Error('SYNTHETIC_PRIVATE_PROVIDER_FAILURE')),
      ),
    ];
    const external = new AbortController();
    const service = new BrainQueryService(
      authorization,
      aliasStore(),
      providers,
      surfaces,
      { providerTimeoutMs: 25 },
    );
    const searching = service.searchBrain(
      authenticatedPrincipal(),
      context(),
      { query: 'Synthetic', limit: 10 },
      external.signal,
    );

    try {
      await vi.advanceTimersByTimeAsync(25);
      expect(
        await Promise.race([searching, Promise.resolve('still-pending')]),
      ).toEqual({
        requestId: context().requestId,
        results: [notion],
        completeness: {
          complete: false,
          providers: [
            { provider: 'notion', state: 'complete' },
            {
              provider: 'drive',
              state: 'timed_out',
              errorCode: 'provider_unavailable',
            },
            {
              provider: 'github',
              state: 'unavailable',
              errorCode: 'provider_unavailable',
            },
          ],
        },
      });
      expect(driveAborted).toBe(true);
    } finally {
      external.abort();
      await searching;
    }
  });

  it('filters unauthorized provider rows and marks that provider partial instead of claiming completeness', async () => {
    const visible = summary('notion', 'visible', 0.7);
    const forbidden = summary(
      'notion',
      'parent-only',
      1,
      'parent_and_stewardship',
    );
    const providers = [
      provider('notion', () =>
        Promise.resolve({
          records: [forbidden, visible],
          completeness: { provider: 'notion', state: 'complete' },
        }),
      ),
      provider('drive', () =>
        Promise.resolve({
          records: [],
          completeness: { provider: 'drive', state: 'complete' },
        }),
      ),
      provider('github', () =>
        Promise.resolve({
          records: [],
          completeness: { provider: 'github', state: 'complete' },
        }),
      ),
    ];
    const service = new BrainQueryService(
      authorization,
      aliasStore(),
      providers,
      surfaces,
    );

    await expect(
      service.searchBrain(
        authenticatedPrincipal('family_participant'),
        context(),
        { query: 'Synthetic', limit: 10 },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      requestId: context().requestId,
      results: [visible],
      completeness: {
        complete: false,
        providers: [
          {
            provider: 'notion',
            state: 'partial',
            errorCode: 'partial_results',
          },
          { provider: 'drive', state: 'complete' },
          { provider: 'github', state: 'complete' },
        ],
      },
    });
  });

  it('resolves a stable Brain ID and returns a freshly fetched normalized record from the exact governed root', async () => {
    const aliases = aliasStore();
    const gatewayId = brainRecordId('brn_gateway_stable_alias');
    const currentSummary = {
      ...summary('notion', 'current', 0.9),
      brainRecordId: brainRecordId('brn_provider_generated_current'),
      provenance: {
        ...summary('notion', 'current', 0.9).provenance,
        providerVersion: 'notion-version-current-2',
      },
    };
    const current = fullRecord(currentSummary, 'Synthetic current body.');
    await aliases.ensureBrainRecordAlias({
      brainRecordId: gatewayId,
      provider: 'notion',
      providerRecordId: current.provenance.providerRecordId,
      canonicalLocation: current.canonicalLocation,
      createdAt: now,
      updatedAt: now,
    });
    let observedFetch: ProviderFetchRequest | undefined;
    const providers = [
      provider(
        'notion',
        () => Promise.reject(new Error('unexpected synthetic search')),
        (request) => {
          observedFetch = request;
          return Promise.resolve(current);
        },
      ),
      provider('drive', () =>
        Promise.reject(new Error('unexpected synthetic search')),
      ),
      provider('github', () =>
        Promise.reject(new Error('unexpected synthetic search')),
      ),
    ];
    const service = new BrainQueryService(
      authorization,
      aliases,
      providers,
      surfaces,
    );

    await expect(
      service.fetchRecord(
        authenticatedPrincipal(),
        context(),
        { brainRecordId: gatewayId },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      record: { ...current, brainRecordId: gatewayId },
    });
    expect(observedFetch).toEqual({
      providerRecordId: current.provenance.providerRecordId,
      access: {
        brainScopes: ['family_shared'],
        rootRefs: [roots.notion],
      },
    });
  });

  it('re-authorizes at fetch time and does not call the provider after a principal loses target access', async () => {
    const parentRoot = 'notion://development/parent-and-stewardship';
    const parentRecord = {
      ...summary('notion', 'parent-only', 0.9, 'parent_and_stewardship'),
      canonicalLocation: {
        provider: 'notion' as const,
        containerRef: parentRoot,
        displayPath: 'Synthetic Parent / parent-only',
      },
      policy: {
        scope: 'parent_and_stewardship' as const,
        sensitivity: 'parent_and_stewardship' as const,
        protectedClass: 'none' as const,
      },
    };
    let fetchCalls = 0;
    const providers = [
      provider(
        'notion',
        () =>
          Promise.resolve({
            records: [parentRecord],
            completeness: { provider: 'notion', state: 'complete' },
          }),
        () => {
          fetchCalls++;
          return Promise.resolve(fullRecord(parentRecord, 'Parent-only body'));
        },
      ),
      provider('drive', () =>
        Promise.resolve({
          records: [],
          completeness: { provider: 'drive', state: 'complete' },
        }),
      ),
      provider('github', () =>
        Promise.resolve({
          records: [],
          completeness: { provider: 'github', state: 'complete' },
        }),
      ),
    ];
    const service = new BrainQueryService(
      authorization,
      aliasStore(),
      providers,
      [
        ...surfaces,
        {
          provider: 'notion',
          scope: 'parent_and_stewardship',
          containerKey: parentRoot,
        },
      ],
    );
    const masonResult = await service.searchBrain(
      authenticatedPrincipal(),
      context(),
      { query: 'Synthetic', limit: 10 },
      new AbortController().signal,
    );
    const selected = masonResult.results[0];
    expect(selected?.brainRecordId).toBe(parentRecord.brainRecordId);

    await expect(
      service.fetchRecord(
        authenticatedPrincipal('family_participant'),
        context(),
        { brainRecordId: parentRecord.brainRecordId },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'not_found',
      retryable: false,
      details: { reason: 'record_not_found' },
    });
    expect(fetchCalls).toBe(0);
  });

  it('fails one provider closed when its response claims another provider identity', async () => {
    const mislabeled = summary('notion', 'mislabeled', 1);
    const providers = [
      provider('notion', () =>
        Promise.resolve({
          records: [mislabeled],
          completeness: { provider: 'drive', state: 'complete' },
        }),
      ),
      provider('drive', () =>
        Promise.resolve({
          records: [],
          completeness: { provider: 'drive', state: 'complete' },
        }),
      ),
      provider('github', () =>
        Promise.resolve({
          records: [],
          completeness: { provider: 'github', state: 'complete' },
        }),
      ),
    ];
    const service = new BrainQueryService(
      authorization,
      aliasStore(),
      providers,
      surfaces,
    );

    await expect(
      service.searchBrain(
        authenticatedPrincipal(),
        context(),
        { query: 'Synthetic', limit: 10 },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      requestId: context().requestId,
      results: [],
      completeness: {
        complete: false,
        providers: [
          {
            provider: 'notion',
            state: 'unavailable',
            errorCode: 'provider_unavailable',
          },
          { provider: 'drive', state: 'complete' },
          { provider: 'github', state: 'complete' },
        ],
      },
    });
  });

  it('bounds a targeted fetch and cancels the provider when its deadline expires', async () => {
    vi.useFakeTimers();
    const aliases = aliasStore();
    const target = summary('drive', 'slow-fetch', 0.5);
    await aliases.ensureBrainRecordAlias({
      brainRecordId: target.brainRecordId,
      provider: 'drive',
      providerRecordId: target.provenance.providerRecordId,
      canonicalLocation: target.canonicalLocation,
      createdAt: now,
      updatedAt: now,
    });
    let providerAborted = false;
    const providers = [
      provider('notion', () =>
        Promise.reject(new Error('unexpected synthetic search')),
      ),
      provider(
        'drive',
        () => Promise.reject(new Error('unexpected synthetic search')),
        (_request, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                providerAborted = true;
                reject(new DOMException('synthetic abort', 'AbortError'));
              },
              { once: true },
            );
          }),
      ),
      provider('github', () =>
        Promise.reject(new Error('unexpected synthetic search')),
      ),
    ];
    const external = new AbortController();
    const service = new BrainQueryService(
      authorization,
      aliases,
      providers,
      surfaces,
      { providerTimeoutMs: 25 },
    );
    const fetching = service
      .fetchRecord(
        authenticatedPrincipal(),
        context(),
        { brainRecordId: target.brainRecordId },
        external.signal,
      )
      .then(
        () => 'unexpected-success' as const,
        (error: unknown) => error,
      );

    try {
      await vi.advanceTimersByTimeAsync(25);
      expect(
        await Promise.race([fetching, Promise.resolve('still-pending')]),
      ).toMatchObject({
        code: 'provider_unavailable',
        retryable: true,
        details: { reason: 'provider_fetch_timeout' },
      });
      expect(providerAborted).toBe(true);
    } finally {
      external.abort();
      await fetching;
    }
  });

  it('drops a provider result when durable alias resolution returns a mismatched provider reference', async () => {
    const record = summary('notion', 'alias-mismatch', 1);
    const aliases: AliasStore = {
      ensureBrainRecordAlias: (candidate) =>
        Promise.resolve({ ...candidate, provider: 'drive' }),
      findBrainRecordAlias: () => Promise.resolve(null),
      enqueueAuditEvent: (event) =>
        Promise.resolve({
          id: 'audit-synthetic-alias-mismatch',
          event,
          attempts: 0,
          availableAt: event.timestamp,
        }),
    };
    const providers = [
      provider('notion', () =>
        Promise.resolve({
          records: [record],
          completeness: { provider: 'notion', state: 'complete' },
        }),
      ),
      provider('drive', () =>
        Promise.resolve({
          records: [],
          completeness: { provider: 'drive', state: 'complete' },
        }),
      ),
      provider('github', () =>
        Promise.resolve({
          records: [],
          completeness: { provider: 'github', state: 'complete' },
        }),
      ),
    ];
    const service = new BrainQueryService(
      authorization,
      aliases,
      providers,
      surfaces,
    );

    await expect(
      service.searchBrain(
        authenticatedPrincipal(),
        context(),
        { query: 'Synthetic', limit: 10 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      results: [],
      completeness: {
        complete: false,
        providers: [
          {
            provider: 'notion',
            state: 'unavailable',
            errorCode: 'provider_unavailable',
          },
          { provider: 'drive', state: 'complete' },
          { provider: 'github', state: 'complete' },
        ],
      },
    });
  });

  it.each([
    { query: ' Synthetic', limit: 10 },
    { query: 'Synthetic\nquery', limit: 10 },
    { query: '---', limit: 10 },
    { query: 'Synthetic', limit: 0 },
    { query: 'Synthetic', limit: 101 },
  ])('rejects an unsafe or unbounded search request %#', async (request) => {
    const emptyResponse = (providerName: KnowledgeProviderName) =>
      Promise.resolve({
        records: [],
        completeness: { provider: providerName, state: 'complete' as const },
      });
    const service = new BrainQueryService(
      authorization,
      aliasStore(),
      [
        provider('notion', () => emptyResponse('notion')),
        provider('drive', () => emptyResponse('drive')),
        provider('github', () => emptyResponse('github')),
      ],
      surfaces,
    );

    await expect(
      service.searchBrain(
        authenticatedPrincipal(),
        context(),
        request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      retryable: false,
      details: { reason: 'invalid_search_request' },
    });
  });

  it('rejects duplicate provider wiring instead of silently replacing an adapter', () => {
    const configured = (name: KnowledgeProviderName) =>
      provider(name, () =>
        Promise.resolve({
          records: [],
          completeness: { provider: name, state: 'complete' },
        }),
      );
    const notion = configured('notion');

    expect(
      () =>
        new BrainQueryService(
          authorization,
          aliasStore(),
          [notion, configured('drive'), configured('github'), notion],
          surfaces,
        ),
    ).toThrow('invalid_brain_query_provider_configuration');
  });

  it('does not return records from a provider that declares itself unavailable', async () => {
    const stale = summary('drive', 'unavailable-stale', 1);
    const providers = [
      provider('notion', () =>
        Promise.resolve({
          records: [],
          completeness: { provider: 'notion', state: 'complete' },
        }),
      ),
      provider('drive', () =>
        Promise.resolve({
          records: [stale],
          completeness: {
            provider: 'drive',
            state: 'unavailable',
            errorCode: 'provider_unavailable',
          },
        }),
      ),
      provider('github', () =>
        Promise.resolve({
          records: [],
          completeness: { provider: 'github', state: 'complete' },
        }),
      ),
    ];
    const service = new BrainQueryService(
      authorization,
      aliasStore(),
      providers,
      surfaces,
    );

    await expect(
      service.searchBrain(
        authenticatedPrincipal(),
        context(),
        { query: 'Synthetic', limit: 10 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      results: [],
      completeness: {
        complete: false,
        providers: [
          { provider: 'notion', state: 'complete' },
          {
            provider: 'drive',
            state: 'unavailable',
            errorCode: 'provider_unavailable',
          },
          { provider: 'github', state: 'complete' },
        ],
      },
    });
  });

  it('preserves provider partial state, reuses a durable alias, and bounds excerpts', async () => {
    const aliases = aliasStore();
    const generated = {
      ...summary('github', 'partial', 0.4),
      excerpt: 'x'.repeat(400),
    };
    const stableId = brainRecordId('brn_stable_existing_alias');
    await aliases.ensureBrainRecordAlias({
      brainRecordId: stableId,
      provider: 'github',
      providerRecordId: generated.provenance.providerRecordId,
      canonicalLocation: generated.canonicalLocation,
      createdAt: now,
      updatedAt: now,
    });
    const emptyResponse = (name: 'notion' | 'drive') =>
      Promise.resolve({
        records: [],
        completeness: { provider: name, state: 'complete' as const },
      });
    const service = new BrainQueryService(
      authorization,
      aliases,
      [
        provider('notion', () => emptyResponse('notion')),
        provider('drive', () => emptyResponse('drive')),
        provider('github', () =>
          Promise.resolve({
            records: [generated],
            completeness: {
              provider: 'github',
              state: 'partial',
              errorCode: 'partial_results',
            },
          }),
        ),
      ],
      surfaces,
    );

    const result = await service.searchBrain(
      authenticatedPrincipal(),
      context(),
      { query: 'Synthetic', limit: 10 },
      new AbortController().signal,
    );

    expect(result.results).toEqual([
      { ...generated, brainRecordId: stableId, excerpt: 'x'.repeat(160) },
    ]);
    expect(result.completeness).toEqual({
      complete: false,
      providers: [
        { provider: 'notion', state: 'complete' },
        { provider: 'drive', state: 'complete' },
        {
          provider: 'github',
          state: 'partial',
          errorCode: 'partial_results',
        },
      ],
    });
  });

  it('cancels all in-flight provider searches when the caller disconnects', async () => {
    const started = new Set<KnowledgeProviderName>();
    const aborted = new Set<KnowledgeProviderName>();
    const providers = knowledgeProviderNames.map((name) =>
      provider(
        name,
        (_request, signal) =>
          new Promise((_resolve, reject) => {
            started.add(name);
            signal.addEventListener(
              'abort',
              () => {
                aborted.add(name);
                reject(new DOMException('private abort reason', 'AbortError'));
              },
              { once: true },
            );
          }),
      ),
    );
    const service = new BrainQueryService(
      authorization,
      aliasStore(),
      providers,
      surfaces,
    );
    const controller = new AbortController();
    const searching = service.searchBrain(
      authenticatedPrincipal(),
      context(),
      { query: 'Synthetic', limit: 10 },
      controller.signal,
    );
    await vi.waitFor(() => {
      expect(started.size).toBe(3);
    });

    controller.abort(new Error('SYNTHETIC_PRIVATE_CALLER_REASON'));

    await expect(searching).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toEqual(new Set(knowledgeProviderNames));
  });

  it('returns the same non-enumerating not-found error for an unknown stable Brain ID', async () => {
    let providerCalls = 0;
    const configured = (name: KnowledgeProviderName) =>
      provider(
        name,
        () => Promise.reject(new Error('unexpected synthetic search')),
        () => {
          providerCalls++;
          return Promise.reject(new Error('unexpected synthetic fetch'));
        },
      );
    const service = new BrainQueryService(
      authorization,
      aliasStore(),
      [configured('notion'), configured('drive'), configured('github')],
      surfaces,
    );

    await expect(
      service.fetchRecord(
        authenticatedPrincipal(),
        context(),
        { brainRecordId: brainRecordId('brn_unknown_synthetic') },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'not_found',
      retryable: false,
      details: { reason: 'record_not_found' },
    });
    expect(providerCalls).toBe(0);
  });

  it('rejects a mismatched authenticated identity before any provider operation', async () => {
    let providerCalls = 0;
    const configured = (name: KnowledgeProviderName) =>
      provider(name, () => {
        providerCalls++;
        return Promise.reject(new Error('unexpected synthetic search'));
      });
    const identity = authenticatedPrincipal();
    const mismatched = {
      ...identity,
      identity: {
        ...identity.identity,
        principalId: principalId('prn_forged_synthetic'),
      },
    };
    const service = new BrainQueryService(
      authorization,
      aliasStore(),
      [configured('notion'), configured('drive'), configured('github')],
      surfaces,
    );

    await expect(
      service.searchBrain(
        mismatched,
        context(),
        { query: 'Synthetic', limit: 10 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'unauthenticated',
      retryable: false,
      details: { reason: 'identity_not_authorized' },
    });
    expect(providerCalls).toBe(0);
  });

  it('projects bounded summaries even if an adapter returns an unexpected full body', async () => {
    const leaked = fullRecord(
      summary('notion', 'unexpected-body', 0.5),
      'SYNTHETIC_PRIVATE_FULL_BODY',
    );
    const emptyResponse = (name: 'drive' | 'github') =>
      Promise.resolve({
        records: [],
        completeness: { provider: name, state: 'complete' as const },
      });
    const service = new BrainQueryService(
      authorization,
      aliasStore(),
      [
        provider('notion', () =>
          Promise.resolve({
            records: [leaked],
            completeness: { provider: 'notion', state: 'complete' },
          }),
        ),
        provider('drive', () => emptyResponse('drive')),
        provider('github', () => emptyResponse('github')),
      ],
      surfaces,
    );

    const result = await service.searchBrain(
      authenticatedPrincipal(),
      context(),
      { query: 'Synthetic', limit: 10 },
      new AbortController().signal,
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).not.toHaveProperty('content');
    expect(result.results[0]).not.toHaveProperty('contentType');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_FULL_BODY');
  });
});
