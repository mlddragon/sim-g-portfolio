import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  isRepositoryRegistered,
  loadExecutablePolicy,
  loadProjectRegistry,
} from '../../../src/domain/policy/policy-loader.js';
import {
  parseGovernanceLock,
  parseProjectRegistryLock,
  validateLiveGovernance,
  validateLiveProjectRegistry,
  verifyPolicyBundle,
  verifyProjectRegistryLock,
} from '../../../src/domain/policy/governance-validator.js';
import type {
  GovernanceArtifactReference,
  GovernanceSnapshot,
  GovernanceSource,
} from '../../../src/ports/governance-source.js';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../../config/policy/${name}`, import.meta.url),
    'utf8',
  );
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const policyContent = fixture('family-brain-v1.yaml');
const governanceLockContent = fixture('governance-lock.json');
const registryContent = fixture('project-registry.yaml');
const registryLockContent = fixture('project-registry-lock.json');

function source(snapshot: GovernanceSnapshot): GovernanceSource {
  return { load: () => Promise.resolve(snapshot) };
}

function boundGovernanceLock() {
  return parseGovernanceLock(
    JSON.stringify({
      schemaVersion: 1,
      executablePolicy: {
        version: 'family-brain-v1.2.0',
        contentSha256: sha256(policyContent),
      },
      canonicalGovernance: {
        bindingStatus: 'bound',
        version: 'synthetic-governance-v1',
        contentSha256: sha256('synthetic canonical governance'),
        canonicalMarker: 'SYNTHETIC_GOVERNANCE_V1',
        sourceReferenceEnvironmentVariable:
          'FAMILY_BRAIN_GOVERNANCE_SOURCE_REF',
      },
    }),
  );
}

const governanceReference: GovernanceArtifactReference = {
  environment: 'development',
  kind: 'canonical_governance',
  sourceReference: 'notion://synthetic-governance',
};

function governanceSnapshot(
  override: Partial<GovernanceSnapshot> = {},
): GovernanceSnapshot {
  return {
    kind: 'canonical_governance',
    version: 'synthetic-governance-v1',
    contentHash: sha256('synthetic canonical governance'),
    canonicalMarker: 'SYNTHETIC_GOVERNANCE_V1',
    sourceReference: governanceReference.sourceReference,
    content: 'synthetic canonical governance',
    loadedAt: new Date('2042-06-07T08:09:10.000Z'),
    ...override,
  };
}

describe('policy and governance locks', () => {
  it('verifies the checked-in executable policy and empty fail-closed registry bundle', () => {
    const bundle = verifyPolicyBundle({
      policyContent,
      governanceLockContent,
      projectRegistryContent: registryContent,
      projectRegistryLockContent: registryLockContent,
    });

    expect(bundle.policy.version).toBe('family-brain-v1.2.0');
    expect(bundle.projectRegistry.repositories).toEqual([]);
    expect(bundle.governanceLock.canonicalGovernance.bindingStatus).toBe(
      'pending',
    );
    expect(bundle.projectRegistryLock.bindingStatus).toBe('pending');
  });

  it('detects any changed executable-policy byte before parsing it as trusted', () => {
    expect(() =>
      verifyPolicyBundle({
        policyContent: `${policyContent}\n# unauthorized drift\n`,
        governanceLockContent,
        projectRegistryContent: registryContent,
        projectRegistryLockContent: registryLockContent,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'policy_drift',
        details: {
          kind: 'executable_policy',
          reason: 'executable_policy_hash_mismatch',
        },
      }),
    );
  });

  it.each([
    [
      'addition',
      'repositories: []',
      `repositories:\n  - repository: synthetic-owner/new-repository\n    projectKey: synthetic-project\n    scopes: [family_shared]\n    knowledgePaths: [docs/]`,
    ],
    [
      'removal',
      'version: project-registry-v1-pending',
      'version: project-registry-v1-removed',
    ],
  ])(
    'detects a Project Registry %s without a lock update',
    (_name, from, to) => {
      expect(() =>
        verifyPolicyBundle({
          policyContent,
          governanceLockContent,
          projectRegistryContent: registryContent.replace(from, to),
          projectRegistryLockContent: registryLockContent,
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'policy_drift',
          details: {
            kind: 'project_registry',
            reason: 'project_registry_hash_mismatch',
          },
        }),
      );
    },
  );

  it('fails closed on malformed or duplicate repository entries', () => {
    expect(() =>
      loadProjectRegistry(
        `schemaVersion: 1\nversion: bad\ncanonicalMarker: BAD\nrepositories:\n  - repository: not-a-full-name\n    projectKey: synthetic\n    scopes: [family_shared]\n    knowledgePaths: [docs/]\n`,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'invalid_request',
        details: { reason: 'invalid_project_registry' },
      }),
    );

    const duplicate = `schemaVersion: 1\nversion: synthetic-v1\ncanonicalMarker: SYNTHETIC\nrepositories:\n  - repository: Synthetic-Owner/Repository\n    projectKey: one\n    scopes: [family_shared]\n    knowledgePaths: [docs/]\n  - repository: synthetic-owner/repository\n    projectKey: two\n    scopes: [family_shared]\n    knowledgePaths: [src/]\n`;
    expect(() => loadProjectRegistry(duplicate)).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('does not authorize an App-installed but unregistered repository', () => {
    const registry = loadProjectRegistry(registryContent);
    expect(
      isRepositoryRegistered(
        registry,
        'synthetic-owner/credential-visible-repository',
        'family_shared',
      ),
    ).toBe(false);
  });

  it('normalizes a registered repository name without broadening its scope', () => {
    const content = `schemaVersion: 1\nversion: synthetic-v1\ncanonicalMarker: SYNTHETIC\nrepositories:\n  - repository: Synthetic-Owner/Repository\n    projectKey: synthetic\n    scopes: [family_shared]\n    knowledgePaths: [docs/]\n`;
    const registry = loadProjectRegistry(content);
    expect(
      isRepositoryRegistered(
        registry,
        'synthetic-owner/repository',
        'family_shared',
      ),
    ).toBe(true);
    expect(
      isRepositoryRegistered(
        registry,
        'synthetic-owner/repository',
        'parent_and_stewardship',
      ),
    ).toBe(false);
  });

  it('rejects configuration that weakens the exact correction or elevation windows', () => {
    expect(() =>
      loadExecutablePolicy(
        policyContent.replace(
          'correctionWindowMs: 900000',
          'correctionWindowMs: 900001',
        ),
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() =>
      loadExecutablePolicy(
        policyContent.replace(
          'elevationTtlMs: 300000',
          'elevationTtlMs: 600000',
        ),
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('blocks deployment while canonical governance binding is explicitly pending', async () => {
    const pending = parseGovernanceLock(governanceLockContent);
    let called = false;
    await expect(
      validateLiveGovernance({
        source: {
          load: () => {
            called = true;
            return Promise.resolve(governanceSnapshot());
          },
        },
        reference: governanceReference,
        lock: pending,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'policy_drift',
      details: { reason: 'canonical_governance_binding_pending' },
    });
    expect(called).toBe(false);
  });

  it.each([
    ['hash', { contentHash: sha256('changed governance') }],
    ['marker', { canonicalMarker: 'CHANGED_MARKER' }],
    ['version', { version: 'changed-version' }],
    ['source reference', { sourceReference: 'notion://different-source' }],
  ])('detects changed live governance %s', async (_name, override) => {
    await expect(
      validateLiveGovernance({
        source: source(governanceSnapshot(override)),
        reference: governanceReference,
        lock: boundGovernanceLock(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'policy_drift' });
  });

  it('validates a bound canonical governance snapshot only on exact match', async () => {
    await expect(
      validateLiveGovernance({
        source: source(governanceSnapshot()),
        reference: governanceReference,
        lock: boundGovernanceLock(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(governanceSnapshot());
  });

  it('detects a changed live Project Registry marker', async () => {
    const lock = parseProjectRegistryLock(
      JSON.stringify({
        ...parseProjectRegistryLock(registryLockContent),
        bindingStatus: 'bound',
      }),
    );
    const reference: GovernanceArtifactReference = {
      environment: 'development',
      kind: 'project_registry',
      sourceReference: 'notion://synthetic-project-registry',
    };
    const snapshot: GovernanceSnapshot = {
      kind: 'project_registry',
      version: lock.version,
      contentHash: lock.contentSha256,
      canonicalMarker: 'CHANGED_REGISTRY_MARKER',
      sourceReference: reference.sourceReference,
      content: registryContent,
      loadedAt: new Date('2042-06-07T08:09:10.000Z'),
    };

    await expect(
      validateLiveProjectRegistry({
        source: source(snapshot),
        reference,
        lock,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'policy_drift',
      details: { reason: 'live_project_registry_marker_mismatch' },
    });
  });

  it('verifies an independently constructed Project Registry lock', () => {
    const content = `schemaVersion: 1\nversion: synthetic-v1\ncanonicalMarker: SYNTHETIC\nrepositories: []\n`;
    const registry = loadProjectRegistry(content);
    const lock = parseProjectRegistryLock(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'project_registry',
        bindingStatus: 'bound',
        version: registry.version,
        contentSha256: sha256(content),
        canonicalMarker: registry.canonicalMarker,
        sourceReferenceEnvironmentVariable:
          'FAMILY_BRAIN_PROJECT_REGISTRY_SOURCE_REF',
      }),
    );
    expect(() => {
      verifyProjectRegistryLock(content, registry, lock);
    }).not.toThrow();
  });
});
