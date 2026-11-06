import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  LiveGitHubProjectRegistry,
  type GitHubRegistrySnapshot,
} from '../../../src/adapters/github/project-registry.js';
import { parseProjectRegistryLock } from '../../../src/domain/policy/governance-validator.js';
import type {
  GovernanceArtifactReference,
  GovernanceSnapshot,
  GovernanceSource,
} from '../../../src/ports/governance-source.js';

const content = `schemaVersion: 1
version: synthetic-registry-v1
canonicalMarker: SYNTHETIC_REGISTRY_V1
repositories:
  - repository: Synthetic-Owner/Shared-Knowledge
    projectKey: synthetic-shared
    scopes: [family_shared]
    knowledgePaths: [README.md, docs/]
  - repository: Synthetic-Owner/Mixed-Knowledge
    projectKey: synthetic-mixed
    scopes: [family_shared, legal]
    knowledgePaths: [governance/]
`;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function lock(override: Readonly<Record<string, unknown>> = {}) {
  return parseProjectRegistryLock(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'project_registry',
      bindingStatus: 'bound',
      version: 'synthetic-registry-v1',
      contentSha256: sha256(content),
      canonicalMarker: 'SYNTHETIC_REGISTRY_V1',
      sourceReferenceEnvironmentVariable:
        'FAMILY_BRAIN_PROJECT_REGISTRY_SOURCE_REF',
      ...override,
    }),
  );
}

const reference: GovernanceArtifactReference = {
  environment: 'test',
  kind: 'project_registry',
  sourceReference: 'notion://synthetic-project-registry',
};

function snapshot(
  override: Partial<GovernanceSnapshot> = {},
): GovernanceSnapshot {
  return {
    kind: 'project_registry',
    version: 'synthetic-registry-v1',
    contentHash: sha256(content),
    canonicalMarker: 'SYNTHETIC_REGISTRY_V1',
    sourceReference: reference.sourceReference,
    content,
    loadedAt: new Date('2042-01-01T00:00:00.000Z'),
    ...override,
  };
}

function source(value: GovernanceSnapshot): GovernanceSource {
  return { load: () => Promise.resolve(value) };
}

function registry(
  overrides: Partial<
    ConstructorParameters<typeof LiveGitHubProjectRegistry>[0]
  > = {},
) {
  return new LiveGitHubProjectRegistry({
    checkedInContent: content,
    lock: lock(),
    source: source(snapshot()),
    reference,
    ...overrides,
  });
}

describe('LiveGitHubProjectRegistry', () => {
  it('returns only an independently locked and live-marker-verified immutable snapshot', async () => {
    const result = await registry().load(new AbortController().signal);

    expect(result).toMatchObject<Partial<GitHubRegistrySnapshot>>({
      version: 'synthetic-registry-v1',
      contentHash: sha256(content),
      canonicalMarker: 'SYNTHETIC_REGISTRY_V1',
    });
    expect(result.repositories).toEqual([
      {
        repository: 'Synthetic-Owner/Shared-Knowledge',
        normalizedRepository: 'synthetic-owner/shared-knowledge',
        rootRef: 'repo:synthetic-owner/shared-knowledge',
        projectKey: 'synthetic-shared',
        knowledgePaths: ['README.md', 'docs/'],
        policy: {
          scope: 'family_shared',
          sensitivity: 'family_shared',
          protectedClass: 'none',
        },
      },
      {
        repository: 'Synthetic-Owner/Mixed-Knowledge',
        normalizedRepository: 'synthetic-owner/mixed-knowledge',
        rootRef: 'repo:synthetic-owner/mixed-knowledge',
        projectKey: 'synthetic-mixed',
        knowledgePaths: ['governance/'],
        policy: {
          scope: 'legal',
          sensitivity: 'protected',
          protectedClass: 'legal_hold',
        },
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.repositories)).toBe(true);
    expect(Object.isFrozen(result.repositories[0])).toBe(true);
    expect(Object.isFrozen(result.repositories[0]?.knowledgePaths)).toBe(true);
    expect(Object.isFrozen(result.repositories[0]?.policy)).toBe(true);
  });

  it('fails before live I/O when checked-in bytes do not match the independent lock', () => {
    let called = false;
    expect(
      () =>
        new LiveGitHubProjectRegistry({
          checkedInContent: `${content}# drift\n`,
          lock: lock(),
          source: {
            load: () => {
              called = true;
              return Promise.resolve(snapshot());
            },
          },
          reference,
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
    expect(called).toBe(false);
  });

  it.each([
    ['marker', { canonicalMarker: 'CHANGED_MARKER' }],
    ['hash', { contentHash: sha256('changed') }],
    ['version', { version: 'changed-version' }],
    ['source', { sourceReference: 'notion://different-source' }],
  ])(
    'rejects live %s drift without returning any entries',
    async (_name, override) => {
      await expect(
        registry({ source: source(snapshot(override)) }).load(
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'policy_drift' });
    },
  );

  it('fails closed while the live binding is pending', async () => {
    let called = false;
    const pending = registry({
      lock: lock({ bindingStatus: 'pending' }),
      source: {
        load: () => {
          called = true;
          return Promise.resolve(snapshot());
        },
      },
    });

    await expect(
      pending.load(new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'policy_drift',
      details: { reason: 'project_registry_binding_pending' },
    });
    expect(called).toBe(false);
  });

  it('honors cancellation without exposing the caller reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));
    const error = await registry()
      .load(controller.signal)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_ABORT_REASON');
  });
});
