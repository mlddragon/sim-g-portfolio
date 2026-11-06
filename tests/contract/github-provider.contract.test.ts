import { createHash } from 'node:crypto';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  GitHubKnowledgeProvider,
  githubProviderRecordId,
} from '../../src/adapters/github/github-knowledge-provider.js';
import type {
  GitHubProjectRegistry,
  GitHubRegistrySnapshot,
} from '../../src/adapters/github/project-registry.js';
import {
  brainRecordId,
  providerRecordId,
} from '../../src/domain/identifiers.js';
import type { BrainRecord } from '../../src/domain/records.js';
import type {
  FetchableKnowledgeProvider,
  MutableKnowledgeProvider,
} from '../../src/ports/knowledge-provider.js';
import { fetchableKnowledgeProviderContract } from './knowledge-provider.contract.js';
import { SyntheticGitHubClient } from '../support/synthetic-github-client.js';

const repository = 'Synthetic-Owner/Contract-Knowledge';
const rootRef = 'repo:synthetic-owner/contract-knowledge';
const commitSha = 'a'.repeat(40);
const blobSha = 'b'.repeat(40);
const path = 'docs/garden.md';
const content = '# Synthetic contract garden\n';

const registrySnapshot: GitHubRegistrySnapshot = Object.freeze({
  version: 'synthetic-contract-registry-v1',
  contentHash: 'c'.repeat(64),
  canonicalMarker: 'SYNTHETIC_CONTRACT_REGISTRY_V1',
  repositories: Object.freeze([
    Object.freeze({
      repository,
      normalizedRepository: repository.toLocaleLowerCase(),
      rootRef,
      projectKey: 'synthetic-contract',
      knowledgePaths: Object.freeze(['docs/']),
      policy: Object.freeze({
        scope: 'family_shared',
        sensitivity: 'family_shared',
        protectedClass: 'none',
      }),
    }),
  ]),
});

const registry: GitHubProjectRegistry = {
  load: () => Promise.resolve(registrySnapshot),
};

function provider() {
  return new GitHubKnowledgeProvider(
    new SyntheticGitHubClient([
      {
        fullName: repository,
        commitSha,
        createdAt: '2042-01-01T00:00:00.000Z',
        updatedAt: '2042-01-02T00:00:00.000Z',
        files: [
          { path, blobSha, content },
          {
            path: 'private/hidden.md',
            blobSha: 'd'.repeat(40),
            content: 'Synthetic hidden contract body',
          },
        ],
      },
      {
        fullName: 'Synthetic-Owner/Unregistered',
        commitSha,
        createdAt: '2042-01-01T00:00:00.000Z',
        updatedAt: '2042-01-02T00:00:00.000Z',
        files: [{ path, blobSha, content }],
      },
    ]),
    registry,
  );
}

const visibleRecord: BrainRecord = {
  brainRecordId: brainRecordId(
    `brn_github_${createHash('sha256')
      .update(`${repository.toLocaleLowerCase()}\n${path}`)
      .digest('hex')
      .slice(0, 32)}`,
  ),
  title: 'garden.md',
  excerpt: `GitHub file ${path} in ${repository}.`,
  content,
  contentType: 'text/markdown',
  canonicalLocation: {
    provider: 'github',
    containerRef: rootRef,
    displayPath: `synthetic-contract / ${path}`,
  },
  provenance: {
    provider: 'github',
    providerRecordId: githubProviderRecordId(repository, path),
    providerVersion: `${commitSha}:${blobSha}`,
    createdAt: new Date('2042-01-01T00:00:00.000Z'),
    updatedAt: new Date('2042-01-02T00:00:00.000Z'),
    integrityHash: `git-blob-sha1:${blobSha}`,
  },
  policy: {
    scope: 'family_shared',
    sensitivity: 'family_shared',
    protectedClass: 'none',
  },
};

fetchableKnowledgeProviderContract({
  name: 'Project Registry GitHub adapter',
  provider: 'github',
  getProvider: provider,
  visibleRecord,
  hiddenProviderRecordIds: [
    githubProviderRecordId(repository, 'private/hidden.md'),
    providerRecordId('gh1:Synthetic-Owner/Unregistered:docs/garden.md'),
  ],
  authorizedAccess: {
    brainScopes: ['family_shared'],
    rootRefs: [rootRef],
  },
  unconfiguredRootRef: 'repo:synthetic-owner/unregistered',
  unconfiguredBrainScope: 'legal',
  matchingQuery: 'garden',
});

describe('GitHubKnowledgeProvider capability shape', () => {
  it('implements fetch only and has no mutation or reconciliation surface', () => {
    const github = provider();

    expectTypeOf(github).toExtend<FetchableKnowledgeProvider>();
    expectTypeOf(github).not.toExtend<MutableKnowledgeProvider>();
    for (const method of ['create', 'update', 'append', 'trash', 'reconcile']) {
      expect(github).not.toHaveProperty(method);
    }
  });
});
