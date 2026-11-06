import { createHash } from 'node:crypto';

import { z } from 'zod';

import { DomainError } from '../errors.js';
import type {
  GovernanceArtifactReference,
  GovernanceSnapshot,
  GovernanceSource,
} from '../../ports/governance-source.js';
import {
  loadExecutablePolicy,
  loadProjectRegistry,
  type ExecutablePolicy,
  type ProjectRegistry,
} from './policy-loader.js';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const environmentVariableSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/u);

const canonicalGovernanceLockSchema = z.strictObject({
  bindingStatus: z.enum(['pending', 'bound']),
  version: z.string().min(1).max(256),
  contentSha256: sha256Schema,
  canonicalMarker: z.string().min(1).max(256),
  sourceReferenceEnvironmentVariable: environmentVariableSchema,
});

const governanceLockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  executablePolicy: z.strictObject({
    version: z.string().min(1).max(256),
    contentSha256: sha256Schema,
  }),
  canonicalGovernance: canonicalGovernanceLockSchema,
});

const projectRegistryLockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('project_registry'),
  bindingStatus: z.enum(['pending', 'bound']),
  version: z.string().min(1).max(256),
  contentSha256: sha256Schema,
  canonicalMarker: z.string().min(1).max(256),
  sourceReferenceEnvironmentVariable: environmentVariableSchema,
});

export type GovernanceLock = z.infer<typeof governanceLockSchema>;
export type ProjectRegistryLock = z.infer<typeof projectRegistryLockSchema>;

export interface PolicyBundleInput {
  readonly policyContent: string;
  readonly governanceLockContent: string;
  readonly projectRegistryContent: string;
  readonly projectRegistryLockContent: string;
}

export interface VerifiedPolicyBundle {
  readonly policy: ExecutablePolicy;
  readonly governanceLock: GovernanceLock;
  readonly projectRegistry: ProjectRegistry;
  readonly projectRegistryLock: ProjectRegistryLock;
}

interface LiveGovernanceValidationInput<
  Lock extends GovernanceLock | ProjectRegistryLock,
> {
  readonly source: GovernanceSource;
  readonly reference: GovernanceArtifactReference;
  readonly lock: Lock;
  readonly signal: AbortSignal;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function decodeJson(content: string, reason: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new DomainError('invalid_request', false, { reason });
  }
}

function drift(reason: string, kind: string): never {
  throw new DomainError('policy_drift', false, { reason, kind });
}

export function parseGovernanceLock(content: string): GovernanceLock {
  const parsed = governanceLockSchema.safeParse(
    decodeJson(content, 'invalid_governance_lock'),
  );
  if (!parsed.success) {
    throw new DomainError('invalid_request', false, {
      reason: 'invalid_governance_lock',
    });
  }
  return parsed.data;
}

export function parseProjectRegistryLock(content: string): ProjectRegistryLock {
  const parsed = projectRegistryLockSchema.safeParse(
    decodeJson(content, 'invalid_project_registry_lock'),
  );
  if (!parsed.success) {
    throw new DomainError('invalid_request', false, {
      reason: 'invalid_project_registry_lock',
    });
  }
  return parsed.data;
}

export function verifyProjectRegistryLock(
  content: string,
  registry: ProjectRegistry,
  lock: ProjectRegistryLock,
): void {
  if (sha256(content) !== lock.contentSha256) {
    drift('project_registry_hash_mismatch', 'project_registry');
  }
  if (registry.version !== lock.version) {
    drift('project_registry_version_mismatch', 'project_registry');
  }
  if (registry.canonicalMarker !== lock.canonicalMarker) {
    drift('project_registry_marker_mismatch', 'project_registry');
  }
}

export function verifyPolicyBundle(
  input: PolicyBundleInput,
): VerifiedPolicyBundle {
  const governanceLock = parseGovernanceLock(input.governanceLockContent);
  if (
    sha256(input.policyContent) !==
    governanceLock.executablePolicy.contentSha256
  ) {
    drift('executable_policy_hash_mismatch', 'executable_policy');
  }
  const policy = loadExecutablePolicy(input.policyContent);
  if (policy.version !== governanceLock.executablePolicy.version) {
    drift('executable_policy_version_mismatch', 'executable_policy');
  }

  const projectRegistryLock = parseProjectRegistryLock(
    input.projectRegistryLockContent,
  );
  if (
    sha256(input.projectRegistryContent) !== projectRegistryLock.contentSha256
  ) {
    drift('project_registry_hash_mismatch', 'project_registry');
  }
  const projectRegistry = loadProjectRegistry(input.projectRegistryContent);
  verifyProjectRegistryLock(
    input.projectRegistryContent,
    projectRegistry,
    projectRegistryLock,
  );

  return {
    policy,
    governanceLock,
    projectRegistry,
    projectRegistryLock,
  };
}

function verifySnapshotIntegrity(
  snapshot: GovernanceSnapshot,
  reason: string,
): void {
  if (sha256(snapshot.content) !== snapshot.contentHash) {
    drift(reason, snapshot.kind);
  }
}

export async function validateLiveGovernance(
  input: LiveGovernanceValidationInput<GovernanceLock>,
): Promise<GovernanceSnapshot> {
  const expected = input.lock.canonicalGovernance;
  if (expected.bindingStatus !== 'bound') {
    drift('canonical_governance_binding_pending', 'canonical_governance');
  }
  if (input.reference.kind !== 'canonical_governance') {
    drift(
      'canonical_governance_reference_kind_mismatch',
      'canonical_governance',
    );
  }

  const snapshot = await input.source.load(input.reference, input.signal);
  verifySnapshotIntegrity(
    snapshot,
    'live_canonical_governance_integrity_mismatch',
  );
  if (snapshot.kind !== 'canonical_governance') {
    drift('live_canonical_governance_kind_mismatch', 'canonical_governance');
  }
  if (snapshot.sourceReference !== input.reference.sourceReference) {
    drift('live_canonical_governance_source_mismatch', 'canonical_governance');
  }
  if (snapshot.version !== expected.version) {
    drift('live_canonical_governance_version_mismatch', 'canonical_governance');
  }
  if (snapshot.contentHash !== expected.contentSha256) {
    drift('live_canonical_governance_hash_mismatch', 'canonical_governance');
  }
  if (snapshot.canonicalMarker !== expected.canonicalMarker) {
    drift('live_canonical_governance_marker_mismatch', 'canonical_governance');
  }
  return snapshot;
}

export async function validateLiveProjectRegistry(
  input: LiveGovernanceValidationInput<ProjectRegistryLock>,
): Promise<GovernanceSnapshot> {
  if (input.lock.bindingStatus !== 'bound') {
    drift('project_registry_binding_pending', 'project_registry');
  }
  if (input.reference.kind !== 'project_registry') {
    drift('project_registry_reference_kind_mismatch', 'project_registry');
  }

  const snapshot = await input.source.load(input.reference, input.signal);
  verifySnapshotIntegrity(snapshot, 'live_project_registry_integrity_mismatch');
  if (snapshot.kind !== 'project_registry') {
    drift('live_project_registry_kind_mismatch', 'project_registry');
  }
  if (snapshot.sourceReference !== input.reference.sourceReference) {
    drift('live_project_registry_source_mismatch', 'project_registry');
  }
  if (snapshot.version !== input.lock.version) {
    drift('live_project_registry_version_mismatch', 'project_registry');
  }
  if (snapshot.contentHash !== input.lock.contentSha256) {
    drift('live_project_registry_hash_mismatch', 'project_registry');
  }
  if (snapshot.canonicalMarker !== input.lock.canonicalMarker) {
    drift('live_project_registry_marker_mismatch', 'project_registry');
  }
  loadProjectRegistry(snapshot.content);
  return snapshot;
}
