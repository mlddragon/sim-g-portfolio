import { describe, expect, it } from 'vitest';

import { rankAndDeduplicate } from '../../../src/domain/search/rank-and-deduplicate.js';
import {
  brainRecordId,
  providerRecordId,
} from '../../../src/domain/identifiers.js';
import type {
  BrainRecordSummary,
  KnowledgeProviderName,
} from '../../../src/domain/records.js';

function result(
  provider: KnowledgeProviderName,
  suffix: string,
  fields: Partial<
    Pick<
      BrainRecordSummary,
      'title' | 'excerpt' | 'canonicalLocation' | 'relevanceScore'
    >
  > = {},
): BrainRecordSummary {
  return {
    brainRecordId: brainRecordId(`brn_${suffix}`),
    title: `Unrelated ${suffix}`,
    excerpt: 'Unrelated excerpt',
    canonicalLocation: {
      provider,
      containerRef: `${provider}://synthetic/root`,
      displayPath: `Synthetic / ${suffix}`,
    },
    provenance: {
      provider,
      providerRecordId: providerRecordId(`${provider}-record-${suffix}`),
      createdAt: new Date('2042-01-01T00:00:00.000Z'),
      updatedAt: new Date('2042-01-02T00:00:00.000Z'),
    },
    policy: {
      scope: 'family_shared',
      sensitivity: 'family_shared',
      protectedClass: 'none',
    },
    ...fields,
  };
}

describe('rankAndDeduplicate', () => {
  it('uses local token overlap, canonical match, provider order, stable ID, deduplication, and limit', () => {
    const exactTitle = result('notion', 'exact-title', {
      title: 'NAS Backup Architecture',
      relevanceScore: 0,
    });
    const titleAndExcerpt = result('drive', 'title-excerpt', {
      title: 'Backup notes',
      excerpt: 'NAS architecture decisions',
      relevanceScore: 0,
    });
    const canonical = result('github', 'canonical', {
      canonicalLocation: {
        provider: 'github',
        containerRef: 'repo:synthetic/nas',
        displayPath: 'Projects / NAS backup architecture',
      },
      relevanceScore: 999,
    });
    const duplicateLowerMatch = {
      ...titleAndExcerpt,
      title: 'Backup only',
      excerpt: 'Unrelated',
    };
    const stableTieA = result('github', 'a-stable-tie', {
      title: 'NAS',
      relevanceScore: 500,
    });
    const stableTieB = result('github', 'b-stable-tie', {
      title: 'NAS',
      relevanceScore: 1,
    });

    const ranked = rankAndDeduplicate(
      'nas, BACKUP architecture',
      [
        stableTieB,
        canonical,
        duplicateLowerMatch,
        exactTitle,
        stableTieA,
        titleAndExcerpt,
      ],
      5,
    );

    expect(ranked).toEqual([
      exactTitle,
      titleAndExcerpt,
      canonical,
      stableTieA,
      stableTieB,
    ]);
    expect(ranked).not.toContain(duplicateLowerMatch);
  });
});
