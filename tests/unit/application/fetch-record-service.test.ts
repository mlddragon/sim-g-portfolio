import { expectTelemetrySurvivesAdapter } from '../../support/telemetry-drift.js';
import { describe, expect, it } from 'vitest';

import { FetchRecordService } from '../../../src/application/fetch-record-service.js';
import type { KnowledgeProviderName } from '../../../src/domain/records.js';
import {
  SyntheticBrainReadStore,
  brainReadAuthorization,
  brainReadContext,
  brainReadNow,
  brainReadPrincipal,
  brainReadProvider,
  brainReadRecord,
  brainReadSummary,
  brainReadSurfaces,
  brainReadTelemetry,
} from '../../support/brain-read-fixtures.js';

function configuredProviders(
  targetProvider: KnowledgeProviderName,
  fetchTarget: ReturnType<typeof brainReadRecord>,
  onFetch: () => void = () => undefined,
) {
  return (['notion', 'drive', 'github'] as const).map((name) =>
    brainReadProvider(
      name,
      () => Promise.reject(new Error('unexpected synthetic search')),
      () => {
        if (name !== targetProvider) {
          return Promise.reject(new Error('wrong synthetic provider'));
        }
        onFetch();
        return Promise.resolve(fetchTarget);
      },
    ),
  );
}

describe('FetchRecordService read observations', () => {
  it('durably audits normalized provenance and measures a completed targeted fetch', async () => {
    const store = new SyntheticBrainReadStore();
    const telemetry = brainReadTelemetry();
    const summary = brainReadSummary('drive', 'audited-fetch');
    const record = brainReadRecord(summary, 'SYNTHETIC_FULL_BODY');
    await store.ensureBrainRecordAlias({
      brainRecordId: summary.brainRecordId,
      provider: 'drive',
      providerRecordId: summary.provenance.providerRecordId,
      canonicalLocation: summary.canonicalLocation,
      createdAt: brainReadNow,
      updatedAt: brainReadNow,
    });
    const requestContext = brainReadContext('fetch_complete_audit');
    const service = new FetchRecordService(
      brainReadAuthorization,
      store,
      configuredProviders('drive', record),
      brainReadSurfaces,
      {
        telemetry: telemetry.sink,
        clock: { now: () => requestContext.receivedAt },
      },
    );

    await expect(
      service.fetchRecord(
        brainReadPrincipal(),
        requestContext,
        { brainRecordId: summary.brainRecordId },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ record });

    expect(store.auditEvents).toEqual([
      {
        eventType: 'brain.read.completed',
        requestId: requestContext.requestId,
        principalId: brainReadPrincipal().principal.id,
        clientId: 'synthetic-test-client',
        operation: 'fetch_record',
        provider: 'drive',
        brainRecordId: summary.brainRecordId,
        providerRecordId: summary.provenance.providerRecordId,
        providerVersion: summary.provenance.providerVersion,
        outcome: 'COMPLETED',
        reasonCode: 'fetch_complete',
        timestamp: requestContext.receivedAt,
      },
    ]);
    expect(JSON.stringify(store.auditEvents)).not.toContain(
      'SYNTHETIC_FULL_BODY',
    );
    expect(telemetry.observations).toContainEqual({
      kind: 'counter',
      name: 'request.total',
      value: 1,
      tags: { operation: 'fetch_record', outcome: 'complete' },
    });
    expect(telemetry.observations).toContainEqual({
      kind: 'duration',
      name: 'request.duration',
      milliseconds: 0,
      tags: { operation: 'fetch_record', outcome: 'complete' },
    });
    expect(telemetry.observations).toContainEqual({
      kind: 'duration',
      name: 'provider.duration',
      milliseconds: 0,
      tags: { provider: 'drive', operation: 'fetch_record' },
    });
    await expectTelemetrySurvivesAdapter(telemetry.observations);
  });

  it('audits inaccessible aliases as denied while returning non-enumerating not-found', async () => {
    const store = new SyntheticBrainReadStore();
    const parentRoot = 'notion://development/parent-only';
    const summary = {
      ...brainReadSummary('notion', 'denied-fetch', 'parent_and_stewardship'),
      canonicalLocation: {
        provider: 'notion' as const,
        containerRef: parentRoot,
      },
    };
    const record = brainReadRecord(summary);
    await store.ensureBrainRecordAlias({
      brainRecordId: summary.brainRecordId,
      provider: 'notion',
      providerRecordId: summary.provenance.providerRecordId,
      canonicalLocation: summary.canonicalLocation,
      createdAt: brainReadNow,
      updatedAt: brainReadNow,
    });
    let fetchCalls = 0;
    const service = new FetchRecordService(
      brainReadAuthorization,
      store,
      configuredProviders('notion', record, () => {
        fetchCalls++;
      }),
      [
        ...brainReadSurfaces,
        {
          provider: 'notion',
          scope: 'parent_and_stewardship',
          containerKey: parentRoot,
        },
      ],
    );
    const requestContext = brainReadContext('fetch_denied_audit');

    await expect(
      service.fetchRecord(
        brainReadPrincipal('family_participant'),
        requestContext,
        { brainRecordId: summary.brainRecordId },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'not_found',
      details: { reason: 'record_not_found' },
    });
    expect(fetchCalls).toBe(0);
    expect(store.auditEvents).toEqual([
      expect.objectContaining({
        eventType: 'brain.read.denied',
        operation: 'fetch_record',
        outcome: 'DENIED',
        brainRecordId: summary.brainRecordId,
        reasonCode: 'record_access_denied',
      }),
    ]);
  });

  it('returns non-enumerating not-found when current provider metadata revokes access', async () => {
    const store = new SyntheticBrainReadStore();
    const summary = brainReadSummary('notion', 'fresh-denial');
    const currentRecord = brainReadRecord({
      ...summary,
      policy: {
        ...summary.policy,
        protectedClass: 'governance',
      },
    });
    await store.ensureBrainRecordAlias({
      brainRecordId: summary.brainRecordId,
      provider: 'notion',
      providerRecordId: summary.provenance.providerRecordId,
      canonicalLocation: summary.canonicalLocation,
      createdAt: brainReadNow,
      updatedAt: brainReadNow,
    });
    const requestContext = brainReadContext('fetch_fresh_denial');
    const service = new FetchRecordService(
      brainReadAuthorization,
      store,
      configuredProviders('notion', currentRecord),
      brainReadSurfaces,
    );

    await expect(
      service.fetchRecord(
        brainReadPrincipal('family_participant'),
        requestContext,
        { brainRecordId: summary.brainRecordId },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'not_found',
      details: { reason: 'record_not_found' },
    });
    expect(store.auditEvents).toEqual([
      expect.objectContaining({
        eventType: 'brain.read.denied',
        outcome: 'DENIED',
        reasonCode: 'record_access_denied',
      }),
    ]);
  });

  it('projects the normalized full-record contract without provider-native fields', async () => {
    const store = new SyntheticBrainReadStore();
    const summary = brainReadSummary('github', 'normalized-fetch');
    const record = brainReadRecord(summary);
    const tainted = Object.assign({}, record, {
      providerRawObject: { token: 'SYNTHETIC_PRIVATE_PROVIDER_VALUE' },
    });
    await store.ensureBrainRecordAlias({
      brainRecordId: summary.brainRecordId,
      provider: 'github',
      providerRecordId: summary.provenance.providerRecordId,
      canonicalLocation: summary.canonicalLocation,
      createdAt: brainReadNow,
      updatedAt: brainReadNow,
    });
    const service = new FetchRecordService(
      brainReadAuthorization,
      store,
      configuredProviders('github', tainted),
      brainReadSurfaces,
    );

    const result = await service.fetchRecord(
      brainReadPrincipal(),
      brainReadContext('fetch_normalized_projection'),
      { brainRecordId: summary.brainRecordId },
      new AbortController().signal,
    );

    expect(result.record).toEqual(record);
    expect(result.record).not.toHaveProperty('providerRawObject');
    expect(JSON.stringify(result)).not.toContain(
      'SYNTHETIC_PRIVATE_PROVIDER_VALUE',
    );
  });
});
