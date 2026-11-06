import type { BrainRecordSummary } from '../records.js';
import { knowledgeProviderNames } from '../records.js';

const providerRank = new Map(
  knowledgeProviderNames.map((provider, index) => [provider, index]),
);

function tokens(value: string): ReadonlySet<string> {
  return new Set(
    [...value.toLocaleLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map(
      (match) => match[0],
    ),
  );
}

function overlap(queryTokens: ReadonlySet<string>, candidate: string): number {
  let matches = 0;
  for (const token of tokens(candidate)) {
    if (queryTokens.has(token)) matches++;
  }
  return matches;
}

function localScore(
  queryTokens: ReadonlySet<string>,
  record: BrainRecordSummary,
): number {
  const canonical = [
    record.canonicalLocation.containerRef,
    record.canonicalLocation.displayPath ?? '',
  ].join(' ');
  return (
    overlap(queryTokens, record.title) * 4 +
    overlap(queryTokens, canonical) * 2 +
    overlap(queryTokens, record.excerpt)
  );
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

/** Pure local ranking; provider-native scores never decide cross-provider order. */
export function rankAndDeduplicate(
  query: string,
  records: readonly BrainRecordSummary[],
  limit: number,
): readonly BrainRecordSummary[] {
  if (query.length === 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('invalid_rank_request');
  }
  const queryTokens = tokens(query);
  if (queryTokens.size === 0) throw new TypeError('invalid_rank_request');

  const scored = records.map((record, index) => ({
    record,
    index,
    score: localScore(queryTokens, record),
  }));
  scored.sort((first, second) => {
    const scoreDifference = second.score - first.score;
    if (scoreDifference !== 0) return scoreDifference;
    const providerDifference =
      (providerRank.get(first.record.provenance.provider) ??
        knowledgeProviderNames.length) -
      (providerRank.get(second.record.provenance.provider) ??
        knowledgeProviderNames.length);
    if (providerDifference !== 0) return providerDifference;
    const idDifference = compareText(
      first.record.brainRecordId,
      second.record.brainRecordId,
    );
    return idDifference === 0 ? first.index - second.index : idDifference;
  });

  const seen = new Set<string>();
  const result: BrainRecordSummary[] = [];
  for (const entry of scored) {
    if (seen.has(entry.record.brainRecordId)) continue;
    seen.add(entry.record.brainRecordId);
    result.push(entry.record);
    if (result.length === limit) break;
  }
  return result;
}
