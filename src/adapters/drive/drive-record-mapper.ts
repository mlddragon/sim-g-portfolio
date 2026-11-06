import { createHash } from 'node:crypto';

import { brainRecordId, providerRecordId } from '../../domain/identifiers.js';
import type {
  BrainRecord,
  BrainRecordSummary,
  CanonicalLocation,
  RecordPolicyMetadata,
  RecordProvenance,
} from '../../domain/records.js';
import {
  DRIVE_GOOGLE_DOC_MIME_TYPE,
  DriveClientFailure,
  type DriveFileSnapshot,
} from './drive-client.js';
import type { DriveGovernedRoot } from './drive-root-guard.js';

function timestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new DriveClientFailure('unavailable');
  }
  return parsed;
}

function integrityHash(file: DriveFileSnapshot): string | undefined {
  const managed = file.appProperties['sim_g_content_sha256'];
  if (managed !== undefined && /^[a-f0-9]{64}$/u.test(managed)) return managed;
  if (
    file.sha256Checksum !== undefined &&
    /^[a-f0-9]{64}$/u.test(file.sha256Checksum)
  ) {
    return file.sha256Checksum;
  }
  return undefined;
}

/**
 * The concurrency token: the head content revision and the last modification
 * by anyone. Drive's `version` also counts server changes no user makes and
 * moves shortly after the gateway's own writes, so it would refuse the next
 * legitimate operation.
 */
export function driveProviderVersion(file: DriveFileSnapshot): string {
  return file.headRevisionId === undefined
    ? file.modifiedTime
    : `${file.headRevisionId}@${file.modifiedTime}`;
}

function location(
  file: DriveFileSnapshot,
  root: DriveGovernedRoot,
): CanonicalLocation {
  return {
    provider: 'drive',
    containerRef: root.rootRef,
    displayPath: `${root.displayPath} / ${file.name}`,
  };
}

function provenance(file: DriveFileSnapshot): RecordProvenance {
  const hash = integrityHash(file);
  return {
    provider: 'drive',
    providerRecordId: providerRecordId(file.id),
    providerVersion: driveProviderVersion(file),
    createdAt: timestamp(file.createdTime),
    updatedAt: timestamp(file.modifiedTime),
    ...(hash === undefined ? {} : { integrityHash: hash }),
  };
}

function policy(root: DriveGovernedRoot): RecordPolicyMetadata {
  return {
    scope: root.policy.scope,
    sensitivity: root.policy.sensitivity,
    protectedClass: root.policy.protectedClass,
  };
}

export function mapDriveSummary(
  file: DriveFileSnapshot,
  root: DriveGovernedRoot,
): BrainRecordSummary {
  const stableId = createHash('sha256')
    .update(file.id)
    .digest('hex')
    .slice(0, 32);
  const excerpt = (file.description ?? file.name).slice(0, 160);
  return {
    brainRecordId: brainRecordId(`brn_drive_${stableId}`),
    title: file.name,
    excerpt,
    canonicalLocation: location(file, root),
    provenance: provenance(file),
    policy: policy(root),
  };
}

export function mapDriveRecord(
  file: DriveFileSnapshot,
  root: DriveGovernedRoot,
  content: string,
  contentType = file.mimeType === DRIVE_GOOGLE_DOC_MIME_TYPE
    ? 'text/plain'
    : file.mimeType,
): BrainRecord {
  return {
    ...mapDriveSummary(file, root),
    content,
    contentType,
  };
}
