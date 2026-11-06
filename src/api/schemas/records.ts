import type { BrainRecord, BrainRecordSummary } from '../../domain/records.js';

/** Explicit field-by-field projection so nothing unlisted reaches the wire. */
export function summaryBody(
  summary: BrainRecordSummary,
): Record<string, unknown> {
  const { canonicalLocation, provenance, policy } = summary;
  return {
    brainRecordId: summary.brainRecordId,
    title: summary.title,
    excerpt: summary.excerpt,
    canonicalLocation: {
      provider: canonicalLocation.provider,
      containerRef: canonicalLocation.containerRef,
      ...(canonicalLocation.displayPath === undefined
        ? {}
        : { displayPath: canonicalLocation.displayPath }),
    },
    provenance: {
      provider: provenance.provider,
      providerRecordId: provenance.providerRecordId,
      ...(provenance.providerVersion === undefined
        ? {}
        : { providerVersion: provenance.providerVersion }),
      ...(provenance.creatorPrincipalId === undefined
        ? {}
        : { creatorPrincipalId: provenance.creatorPrincipalId }),
      createdAt: provenance.createdAt.toISOString(),
      updatedAt: provenance.updatedAt.toISOString(),
      ...(provenance.integrityHash === undefined
        ? {}
        : { integrityHash: provenance.integrityHash }),
    },
    policy: {
      scope: policy.scope,
      sensitivity: policy.sensitivity,
      protectedClass: policy.protectedClass,
    },
    ...(summary.relevanceScore === undefined
      ? {}
      : { relevanceScore: summary.relevanceScore }),
  };
}

/** A summary plus the full content; only `fetch_record` returns content. */
export function recordBody(record: BrainRecord): Record<string, unknown> {
  return {
    ...summaryBody(record),
    content: record.content,
    contentType: record.contentType,
  };
}
