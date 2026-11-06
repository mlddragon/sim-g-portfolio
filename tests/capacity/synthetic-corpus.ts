import {
  brainRecordId,
  providerRecordId,
} from '../../src/domain/identifiers.js';
import type {
  BrainRecord,
  RecordPolicyMetadata,
} from '../../src/domain/records.js';

/** Words the load generator searches for; every record contains several. */
export const syntheticVocabulary = [
  'garden',
  'insurance',
  'recipe',
  'schedule',
  'maintenance',
  'warranty',
  'travel',
  'school',
  'budget',
  'appliance',
  'medical',
  'vehicle',
] as const;

type Container = 'family_shared' | 'parent_and_stewardship' | 'protected';

// Mirrors the executable policy's containerPolicies (owner decision 2026-10-24).
const containerPolicy: Record<Container, RecordPolicyMetadata> = {
  family_shared: {
    scope: 'family_shared',
    sensitivity: 'family_shared',
    protectedClass: 'none',
  },
  parent_and_stewardship: {
    scope: 'parent_and_stewardship',
    sensitivity: 'parent_and_stewardship',
    protectedClass: 'none',
  },
  protected: {
    scope: 'legal',
    sensitivity: 'protected',
    protectedClass: 'protected',
  },
};

/** Deterministic, obviously fictional records: 60/30/10 across containers. */
export function syntheticCorpus(
  provider: 'notion' | 'drive',
  containers: Readonly<Record<string, string>>,
  count: number,
): BrainRecord[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20_000) {
    throw new TypeError('invalid_capacity_records');
  }
  const records: BrainRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const container: Container =
      index % 10 < 6
        ? 'family_shared'
        : index % 10 < 9
          ? 'parent_and_stewardship'
          : 'protected';
    const containerRef = containers[container];
    if (containerRef === undefined) throw new TypeError('missing_container');
    const words = [0, 3, 7].map(
      (offset) =>
        syntheticVocabulary[(index + offset) % syntheticVocabulary.length],
    );
    const serial = String(index);
    const title = `Synthetic ${words.join(' ')} note ${serial}`;
    // Roughly 1.5–4.5 KiB of filler, like a short household note.
    const content = `${title}\n\n${'Fictional synthetic household text. '.repeat(
      40 + (index % 80),
    )}`;
    const id = `${provider}-synthetic-${serial}`;
    records.push({
      brainRecordId: brainRecordId(`brn_${provider}_capacity_${serial}`),
      title,
      excerpt: `${title} excerpt`,
      content,
      contentType: 'text/markdown',
      canonicalLocation: {
        provider,
        containerRef,
        displayPath: `Synthetic / ${container} / ${serial}`,
      },
      provenance: {
        provider,
        providerRecordId: providerRecordId(id),
        providerVersion: `${id}-v1`,
        createdAt: new Date('2042-01-01T00:00:00.000Z'),
        updatedAt: new Date('2042-01-02T00:00:00.000Z'),
      },
      policy: containerPolicy[container],
    });
  }
  return records;
}
