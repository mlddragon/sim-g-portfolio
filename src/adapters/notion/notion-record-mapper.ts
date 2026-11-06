import { brainRecordId, providerRecordId } from '../../domain/identifiers.js';
import type {
  BrainRecord,
  BrainRecordSummary,
  CanonicalLocation,
  RecordPolicyMetadata,
  RecordProvenance,
} from '../../domain/records.js';
import {
  NotionClientFailure,
  type NotionPageSnapshot,
} from './notion-client.js';
import type { NotionGovernedRoot } from './notion-scope-guard.js';

function parseTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new NotionClientFailure('unavailable');
  }
  return parsed;
}

function location(
  page: NotionPageSnapshot,
  root: NotionGovernedRoot,
): CanonicalLocation {
  return {
    provider: 'notion',
    containerRef: root.rootRef,
    displayPath: `${root.displayPath} / ${page.title}`,
  };
}

function provenance(page: NotionPageSnapshot): RecordProvenance {
  return {
    provider: 'notion',
    providerRecordId: providerRecordId(page.id),
    providerVersion: page.updatedTime,
    createdAt: parseTimestamp(page.createdTime),
    updatedAt: parseTimestamp(page.updatedTime),
  };
}

function policy(root: NotionGovernedRoot): RecordPolicyMetadata {
  return {
    scope: root.policy.scope,
    sensitivity: root.policy.sensitivity,
    protectedClass: root.policy.protectedClass,
  };
}

export function mapNotionSummary(
  page: NotionPageSnapshot,
  root: NotionGovernedRoot,
): BrainRecordSummary {
  return {
    brainRecordId: brainRecordId(`brn_notion_${page.id.replaceAll('-', '')}`),
    title: page.title,
    excerpt: page.title.slice(0, 160),
    canonicalLocation: location(page, root),
    provenance: provenance(page),
    policy: policy(root),
  };
}

export function mapNotionRecord(
  page: NotionPageSnapshot,
  root: NotionGovernedRoot,
  content: string,
): BrainRecord {
  return {
    ...mapNotionSummary(page, root),
    content,
    contentType: 'text/markdown',
  };
}
