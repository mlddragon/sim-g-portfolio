import { describe, expect, it } from 'vitest';

import { BrainQueryService } from '../../src/application/brain-query-service.js';
import { FakeFetchableKnowledgeProvider } from '../support/fake-knowledge-providers.js';
import {
  SyntheticBrainReadStore,
  brainReadAuthorization,
  brainReadContext,
  brainReadPrincipal,
  brainReadRecord,
  brainReadRoots,
  brainReadSummary,
  brainReadSurfaces,
} from '../support/brain-read-fixtures.js';

describe('unified Brain retrieval acceptance', () => {
  it('searches every authorized provider and targeted-fetches one current full record', async () => {
    const records = {
      notion: brainReadRecord(brainReadSummary('notion', 'garden-plan')),
      drive: brainReadRecord(brainReadSummary('drive', 'garden-budget')),
      github: brainReadRecord(brainReadSummary('github', 'garden-project')),
    };
    const providers = (['notion', 'drive', 'github'] as const).map(
      (provider) =>
        new FakeFetchableKnowledgeProvider(provider, [records[provider]], {
          configuredAccess: {
            brainScopes: ['family_shared'],
            rootRefs: [brainReadRoots[provider]],
          },
        }),
    );
    const store = new SyntheticBrainReadStore();
    const service = new BrainQueryService(
      brainReadAuthorization,
      store,
      providers,
      brainReadSurfaces,
    );
    const principal = brainReadPrincipal('family_participant');

    const search = await service.searchBrain(
      principal,
      brainReadContext('acceptance_search'),
      { query: 'garden', limit: 10 },
      new AbortController().signal,
    );

    expect(search.results.map((result) => result.provenance.provider)).toEqual([
      'notion',
      'drive',
      'github',
    ]);
    expect(search.completeness).toEqual({
      complete: true,
      providers: [
        { provider: 'notion', state: 'complete' },
        { provider: 'drive', state: 'complete' },
        { provider: 'github', state: 'complete' },
      ],
    });
    expect(search.results.every((result) => !('content' in result))).toBe(true);

    const selected = search.results.find(
      (result) => result.provenance.provider === 'drive',
    );
    expect(selected).toBeDefined();
    if (selected === undefined) throw new Error('missing synthetic result');
    const fetch = await service.fetchRecord(
      principal,
      brainReadContext('acceptance_fetch'),
      { brainRecordId: selected.brainRecordId },
      new AbortController().signal,
    );

    expect(fetch.record).toEqual(records.drive);
    expect(fetch.record.content).toBe('Synthetic full body.');
    expect(store.auditEvents.map((event) => event.eventType)).toEqual([
      'brain.read.completed',
      'brain.read.completed',
    ]);
  });
});
