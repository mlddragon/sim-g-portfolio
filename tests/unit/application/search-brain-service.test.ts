import { expectTelemetrySurvivesAdapter } from '../../support/telemetry-drift.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchBrainService } from '../../../src/application/search-brain-service.js';
import type { KnowledgeProviderName } from '../../../src/domain/records.js';
import type { ProviderSearchResponse } from '../../../src/ports/knowledge-provider.js';
import {
  SyntheticBrainReadStore,
  brainReadAuthorization,
  brainReadContext,
  brainReadPrincipal,
  brainReadProvider,
  brainReadSummary,
  brainReadSurfaces,
  brainReadTelemetry,
} from '../../support/brain-read-fixtures.js';

function empty(name: KnowledgeProviderName) {
  return Promise.resolve({
    records: [],
    completeness: { provider: name, state: 'complete' as const },
  });
}

describe('SearchBrainService read observations', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('durably audits and measures a partial normalized search without content', async () => {
    const store = new SyntheticBrainReadStore();
    const telemetry = brainReadTelemetry();
    const notion = brainReadSummary('notion', 'partial-result');
    const requestContext = brainReadContext('search_partial_audit');
    const service = new SearchBrainService(
      brainReadAuthorization,
      store,
      [
        brainReadProvider('notion', () =>
          Promise.resolve({
            records: [notion],
            completeness: {
              provider: 'notion',
              state: 'partial',
              errorCode: 'partial_results',
            },
          }),
        ),
        brainReadProvider('drive', () => empty('drive')),
        brainReadProvider('github', () => empty('github')),
      ],
      brainReadSurfaces,
      {
        telemetry: telemetry.sink,
        clock: { now: () => requestContext.receivedAt },
      },
    );

    await expect(
      service.searchBrain(
        brainReadPrincipal(),
        requestContext,
        { query: 'Synthetic', limit: 5 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      requestId: requestContext.requestId,
      results: [{ brainRecordId: notion.brainRecordId }],
      completeness: { complete: false },
    });

    expect(store.auditEvents).toEqual([
      {
        eventType: 'brain.read.partial',
        requestId: requestContext.requestId,
        principalId: brainReadPrincipal().principal.id,
        clientId: 'synthetic-test-client',
        operation: 'search_brain',
        outcome: 'COMPLETED',
        reasonCode: 'partial_results',
        timestamp: requestContext.receivedAt,
      },
    ]);
    expect(JSON.stringify(store.auditEvents)).not.toContain(
      'Synthetic partial-result excerpt',
    );
    expect(telemetry.observations).toEqual(
      expect.arrayContaining([
        {
          kind: 'counter',
          name: 'request.total',
          value: 1,
          tags: { operation: 'search_brain', outcome: 'partial' },
        },
        { kind: 'counter', name: 'search.partial', value: 1 },
        {
          kind: 'duration',
          name: 'request.duration',
          milliseconds: 0,
          tags: { operation: 'search_brain', outcome: 'partial' },
        },
        {
          kind: 'duration',
          name: 'provider.duration',
          milliseconds: 0,
          tags: { provider: 'notion', operation: 'search_brain' },
        },
      ]),
    );
    await expectTelemetrySurvivesAdapter(telemetry.observations);
  });

  it('degrades to an honest partial result when the record-reference store is unreachable', async () => {
    const store = new SyntheticBrainReadStore();
    // A dropped database connection surfaces as a raw driver error.
    store.ensureBrainRecordAlias = () =>
      Promise.reject(new Error('synthetic connection terminated'));
    const notion = brainReadSummary('notion', 'store-outage');
    const service = new SearchBrainService(
      brainReadAuthorization,
      store,
      [
        brainReadProvider('notion', () =>
          Promise.resolve({
            records: [notion],
            completeness: { provider: 'notion', state: 'complete' },
          }),
        ),
        brainReadProvider('drive', () => empty('drive')),
        brainReadProvider('github', () => empty('github')),
      ],
      brainReadSurfaces,
    );

    await expect(
      service.searchBrain(
        brainReadPrincipal(),
        brainReadContext('search_store_outage'),
        { query: 'Synthetic', limit: 5 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      results: [],
      completeness: {
        complete: false,
        providers: expect.arrayContaining([
          {
            provider: 'notion',
            state: 'unavailable',
            errorCode: 'provider_unavailable',
          },
        ]) as unknown,
      },
    });
  });

  it('audits a verified principal invalid request as failed before returning it', async () => {
    const store = new SyntheticBrainReadStore();
    const service = new SearchBrainService(
      brainReadAuthorization,
      store,
      [
        brainReadProvider('notion', () => empty('notion')),
        brainReadProvider('drive', () => empty('drive')),
        brainReadProvider('github', () => empty('github')),
      ],
      brainReadSurfaces,
    );
    const requestContext = brainReadContext('search_invalid_audit');

    await expect(
      service.searchBrain(
        brainReadPrincipal(),
        requestContext,
        { query: '', limit: 5 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(store.auditEvents).toEqual([
      expect.objectContaining({
        eventType: 'brain.read.failed',
        operation: 'search_brain',
        outcome: 'FAILED',
        reasonCode: 'read_invalid_request',
      }),
    ]);
  });

  it('omits providers with no authorized registered surface without marking them failed', async () => {
    const store = new SyntheticBrainReadStore();
    let forbiddenCalls = 0;
    const notionSurface = brainReadSurfaces.find(
      (surface) => surface.provider === 'notion',
    );
    if (notionSurface === undefined) throw new Error('missing test surface');
    const service = new SearchBrainService(
      brainReadAuthorization,
      store,
      [
        brainReadProvider('notion', () => empty('notion')),
        brainReadProvider('drive', () => {
          forbiddenCalls++;
          return empty('drive');
        }),
        brainReadProvider('github', () => {
          forbiddenCalls++;
          return empty('github');
        }),
      ],
      [notionSurface],
    );

    const result = await service.searchBrain(
      brainReadPrincipal(),
      brainReadContext('search_omitted_providers'),
      { query: 'Synthetic', limit: 5 },
      new AbortController().signal,
    );

    expect(result.completeness.complete).toBe(true);
    expect(forbiddenCalls).toBe(0);
  });

  it('settles when an adapter ignores cancellation and absorbs its late rejection', async () => {
    vi.useFakeTimers();
    const store = new SyntheticBrainReadStore();
    const telemetry = brainReadTelemetry();
    const late = Promise.withResolvers<ProviderSearchResponse>();
    const service = new SearchBrainService(
      brainReadAuthorization,
      store,
      [
        brainReadProvider('notion', () => empty('notion')),
        brainReadProvider('drive', () => late.promise),
        brainReadProvider('github', () => empty('github')),
      ],
      brainReadSurfaces,
      {
        providerTimeoutMs: 20,
        telemetry: telemetry.sink,
        clock: { now: () => brainReadContext('clock').receivedAt },
      },
    );
    const searching = service.searchBrain(
      brainReadPrincipal(),
      brainReadContext('search_ignored_abort'),
      { query: 'Synthetic', limit: 5 },
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(20);
    await expect(searching).resolves.toMatchObject({
      completeness: {
        complete: false,
        providers: [
          { provider: 'notion', state: 'complete' },
          { provider: 'drive', state: 'timed_out' },
          { provider: 'github', state: 'complete' },
        ],
      },
    });
    late.reject(new Error('SYNTHETIC_LATE_PRIVATE_FAILURE'));
    await Promise.resolve();
    expect(store.auditEvents).toHaveLength(1);
    expect(telemetry.observations).toContainEqual({
      kind: 'counter',
      name: 'provider.timeout',
      value: 1,
      tags: { provider: 'drive' },
    });
  });
});
