import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  GITHUB_MAX_CONTENT_BYTES,
  GitHubClientFailure,
} from '../../../src/adapters/github/github-app-client.js';
import {
  GitHubKnowledgeProvider,
  githubProviderRecordId,
} from '../../../src/adapters/github/github-knowledge-provider.js';
import type {
  GitHubProjectRegistry,
  GitHubRegistryRepository,
  GitHubRegistrySnapshot,
} from '../../../src/adapters/github/project-registry.js';
import { providerRecordId } from '../../../src/domain/identifiers.js';
import type { RecordPolicyMetadata } from '../../../src/domain/records.js';
import {
  SyntheticGitHubClient,
  type SyntheticGitHubRepository,
} from '../../support/synthetic-github-client.js';

const sharedRepository = 'Synthetic-Owner/Shared-Knowledge';
const missingRepository = 'Synthetic-Owner/Missing-Installation';
const extraRepository = 'Synthetic-Owner/Credential-Visible-Only';
const sharedRoot = 'repo:synthetic-owner/shared-knowledge';
const missingRoot = 'repo:synthetic-owner/missing-installation';
const commitSha = 'a'.repeat(40);
const blobSha = 'b'.repeat(40);

const sharedPolicy: RecordPolicyMetadata = {
  scope: 'family_shared',
  sensitivity: 'family_shared',
  protectedClass: 'none',
};

function registryEntry(
  repository: string,
  overrides: Partial<GitHubRegistryRepository> = {},
): GitHubRegistryRepository {
  const normalizedRepository = repository.toLocaleLowerCase();
  return Object.freeze({
    repository,
    normalizedRepository,
    rootRef: `repo:${normalizedRepository}`,
    projectKey: normalizedRepository.split('/').at(-1) ?? 'synthetic-project',
    knowledgePaths: Object.freeze(['README.md', 'docs/']),
    policy: Object.freeze(sharedPolicy),
    ...overrides,
  });
}

function snapshot(
  repositories: readonly GitHubRegistryRepository[],
): GitHubRegistrySnapshot {
  return Object.freeze({
    version: 'synthetic-registry-v1',
    contentHash: 'c'.repeat(64),
    canonicalMarker: 'SYNTHETIC_REGISTRY_V1',
    repositories: Object.freeze([...repositories]),
  });
}

function fixedRegistry(
  repositories: readonly GitHubRegistryRepository[],
): GitHubProjectRegistry {
  const value = snapshot(repositories);
  return { load: () => Promise.resolve(value) };
}

function repository(
  fullName = sharedRepository,
  overrides: Partial<SyntheticGitHubRepository> = {},
): SyntheticGitHubRepository {
  return {
    fullName,
    commitSha,
    createdAt: '2042-01-01T00:00:00.000Z',
    updatedAt: '2042-01-02T00:00:00.000Z',
    files: [
      {
        path: 'docs/garden.md',
        blobSha,
        content: '# Synthetic garden architecture\n',
      },
      {
        path: 'private/hidden.md',
        blobSha: 'd'.repeat(40),
        content: 'Synthetic garden content outside the registered path.',
      },
    ],
    ...overrides,
  };
}

const access = {
  brainScopes: ['family_shared'] as const,
  rootRefs: [sharedRoot],
};

function build(
  repositories: readonly SyntheticGitHubRepository[] = [repository()],
  entries: readonly GitHubRegistryRepository[] = [
    registryEntry(sharedRepository, { projectKey: 'synthetic-shared' }),
  ],
  options: ConstructorParameters<typeof SyntheticGitHubClient>[1] = {},
) {
  const client = new SyntheticGitHubClient(repositories, options);
  return {
    client,
    provider: new GitHubKnowledgeProvider(client, fixedRegistry(entries)),
  };
}

function expectedBrainId(repositoryName: string, path: string): string {
  return `brn_github_${createHash('sha256')
    .update(`${repositoryName.toLocaleLowerCase()}\n${path}`)
    .digest('hex')
    .slice(0, 32)}`;
}

describe('GitHubKnowledgeProvider search', () => {
  it('intersects registered, principal-authorized and App-installed repositories', async () => {
    const built = build(
      [repository(), repository(extraRepository)],
      [
        registryEntry(sharedRepository, { projectKey: 'synthetic-shared' }),
        registryEntry(missingRepository, {
          projectKey: 'synthetic-missing',
        }),
      ],
    );

    const result = await built.provider.search(
      {
        query: 'garden',
        limit: 10,
        access: {
          brainScopes: ['family_shared'],
          rootRefs: [sharedRoot, missingRoot],
        },
      },
      new AbortController().signal,
    );

    expect(built.client.searchCalls).toEqual([
      { repository: sharedRepository, query: 'garden', limit: 10 },
    ]);
    expect(built.client.resolveCalls).toEqual([sharedRepository]);
    expect(result.records).toHaveLength(1);
    expect(result.completeness).toEqual({
      provider: 'github',
      state: 'partial',
      errorCode: 'partial_results',
    });
    expect(JSON.stringify(result)).not.toContain(extraRepository);
    expect(JSON.stringify(result)).not.toContain(missingRepository);
  });

  it('returns stable repository/path identity and commit/blob provenance without a full body', async () => {
    const built = build();
    const result = await built.provider.search(
      { query: 'garden', limit: 10, access },
      new AbortController().signal,
    );

    expect(result).toEqual({
      records: [
        {
          brainRecordId: expectedBrainId(sharedRepository, 'docs/garden.md'),
          title: 'garden.md',
          excerpt:
            'GitHub file docs/garden.md in Synthetic-Owner/Shared-Knowledge.',
          canonicalLocation: {
            provider: 'github',
            containerRef: sharedRoot,
            displayPath: 'synthetic-shared / docs/garden.md',
          },
          provenance: {
            provider: 'github',
            providerRecordId: githubProviderRecordId(
              sharedRepository,
              'docs/garden.md',
            ),
            providerVersion: `${commitSha}:${blobSha}`,
            createdAt: new Date('2042-01-01T00:00:00.000Z'),
            updatedAt: new Date('2042-01-02T00:00:00.000Z'),
            integrityHash: `git-blob-sha1:${blobSha}`,
          },
          policy: sharedPolicy,
        },
      ],
      completeness: { provider: 'github', state: 'complete' },
    });
    expect(result.records[0]).not.toHaveProperty('content');
    expect(JSON.stringify(result)).not.toContain(
      '# Synthetic garden architecture',
    );
  });

  it('filters every result outside registered knowledge paths', async () => {
    const built = build();
    const result = await built.provider.search(
      { query: 'garden', limit: 10, access },
      new AbortController().signal,
    );

    expect(
      result.records.map((record) => record.canonicalLocation.displayPath),
    ).toEqual(['synthetic-shared / docs/garden.md']);
  });

  it('propagates provider incomplete_results as explicit partial completeness', async () => {
    const built = build([repository()], undefined, {
      incompleteRepositories: [sharedRepository],
    });
    await expect(
      built.provider.search(
        { query: 'garden', limit: 10, access },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      completeness: {
        provider: 'github',
        state: 'partial',
        errorCode: 'partial_results',
      },
    });
  });

  it('turns an isolated repository failure into partial results from healthy repositories', async () => {
    const second = 'Synthetic-Owner/Second-Knowledge';
    const secondRoot = 'repo:synthetic-owner/second-knowledge';
    const built = build(
      [repository(), repository(second)],
      [registryEntry(sharedRepository), registryEntry(second)],
      { unavailableRepositories: [second] },
    );
    const result = await built.provider.search(
      {
        query: 'garden',
        limit: 10,
        access: {
          brainScopes: ['family_shared'],
          rootRefs: [sharedRoot, secondRoot],
        },
      },
      new AbortController().signal,
    );

    expect(result.records).toHaveLength(1);
    expect(result.completeness.state).toBe('partial');
  });

  it('fails closed with an empty Registry without touching GitHub', async () => {
    const built = build([repository()], []);
    await expect(
      built.provider.search(
        {
          query: 'garden',
          limit: 10,
          access: { brainScopes: [], rootRefs: [] },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      records: [],
      completeness: { provider: 'github', state: 'complete' },
    });
    expect(built.client.listInstallationRepositoryCalls).toEqual([]);
    expect(built.client.searchCalls).toEqual([]);
  });

  it('rejects repository qualifiers and malformed bounds before provider I/O', async () => {
    const built = build();
    for (const request of [
      { query: 'garden repo:synthetic-owner/other', limit: 10, access },
      { query: ' ', limit: 10, access },
      { query: 'garden', limit: 101, access },
    ]) {
      await expect(
        built.provider.search(request, new AbortController().signal),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        details: { reason: 'invalid_provider_search_request' },
      });
    }
    expect(built.client.listInstallationRepositoryCalls).toEqual([]);
  });

  it('snapshots caller access before any asynchronous registry or provider work', async () => {
    const mutable = {
      brainScopes: ['family_shared'] as string[],
      rootRefs: [sharedRoot],
    };
    const client = new SyntheticGitHubClient([repository()], {
      onListInstallationRepositories: () => {
        mutable.brainScopes.push('legal');
        mutable.rootRefs.push('repo:synthetic-owner/unregistered');
      },
    });
    const provider = new GitHubKnowledgeProvider(
      client,
      fixedRegistry([registryEntry(sharedRepository)]),
    );

    await expect(
      provider.search(
        { query: 'garden', limit: 10, access: mutable as never },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ records: [{ title: 'garden.md' }] });
  });
});

describe('GitHubKnowledgeProvider fetch', () => {
  it('revalidates authorization and pins content retrieval to the resolved current default-branch SHA', async () => {
    const built = build();
    const id = githubProviderRecordId(sharedRepository, 'docs/garden.md');
    const result = await built.provider.fetch(
      { providerRecordId: id, access },
      new AbortController().signal,
    );

    expect(built.client.resolveCalls).toEqual([sharedRepository]);
    expect(built.client.contentCalls).toEqual([
      {
        repository: sharedRepository,
        path: 'docs/garden.md',
        ref: commitSha,
      },
    ]);
    expect(result).toMatchObject({
      brainRecordId: expectedBrainId(sharedRepository, 'docs/garden.md'),
      content: '# Synthetic garden architecture\n',
      contentType: 'text/markdown',
      provenance: {
        providerRecordId: id,
        providerVersion: `${commitSha}:${blobSha}`,
        integrityHash: `git-blob-sha1:${blobSha}`,
      },
    });
  });

  it('keeps the record identity stable while provider version follows a new default-branch head', async () => {
    const first = build();
    const secondCommit = 'e'.repeat(40);
    const secondBlob = 'f'.repeat(40);
    const second = build([
      repository(sharedRepository, {
        commitSha: secondCommit,
        updatedAt: '2042-01-03T00:00:00.000Z',
        files: [
          {
            path: 'docs/garden.md',
            blobSha: secondBlob,
            content: '# Revised synthetic garden architecture\n',
          },
        ],
      }),
    ]);
    const id = githubProviderRecordId(sharedRepository, 'docs/garden.md');

    const [oldRecord, newRecord] = await Promise.all([
      first.provider.fetch(
        { providerRecordId: id, access },
        new AbortController().signal,
      ),
      second.provider.fetch(
        { providerRecordId: id, access },
        new AbortController().signal,
      ),
    ]);
    expect(newRecord.brainRecordId).toBe(oldRecord.brainRecordId);
    expect(newRecord.provenance.providerRecordId).toBe(
      oldRecord.provenance.providerRecordId,
    );
    expect(newRecord.provenance.providerVersion).toBe(
      `${secondCommit}:${secondBlob}`,
    );
  });

  it.each([
    [
      'unregistered repository',
      providerRecordId('gh1:Synthetic-Owner/Unregistered:docs/garden.md'),
    ],
    [
      'path outside knowledge roots',
      githubProviderRecordId(sharedRepository, 'private/hidden.md'),
    ],
    [
      'malformed opaque identifier',
      providerRecordId('not-a-github-provider-record-id'),
    ],
  ])('returns the same safe not-found boundary for %s', async (_name, id) => {
    const built = build([
      repository(),
      repository('Synthetic-Owner/Unregistered'),
    ]);
    await expect(
      built.provider.fetch(
        { providerRecordId: id, access },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'not_found',
      retryable: false,
      details: { reason: 'record_not_found' },
    });
  });

  it.each([
    ['symlink', 'github_symlink_not_readable'],
    ['submodule', 'github_submodule_not_readable'],
    ['directory', 'github_directory_not_readable'],
  ] as const)(
    'rejects a %s without returning provider data',
    async (kind, reason) => {
      const built = build([
        repository(sharedRepository, {
          files: [
            {
              path: 'docs/item',
              blobSha,
              kind,
            },
          ],
        }),
      ]);
      await expect(
        built.provider.fetch(
          {
            providerRecordId: githubProviderRecordId(
              sharedRepository,
              'docs/item',
            ),
            access,
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: 'provider_capability_unsupported',
        details: { reason },
      });
    },
  );

  it('rejects oversized, invalid UTF-8 and binary payloads', async () => {
    const cases = [
      {
        path: 'docs/large.md',
        blobSha,
        content: 'small',
        size: GITHUB_MAX_CONTENT_BYTES + 1,
        reason: 'github_content_too_large',
      },
      {
        path: 'docs/invalid.md',
        blobSha,
        content: new Uint8Array([0xff]),
        reason: 'github_content_invalid_utf8',
      },
      {
        path: 'docs/binary.dat',
        blobSha,
        content: new Uint8Array([0x01]),
        reason: 'github_binary_content_not_readable',
      },
    ];
    const built = build([repository(sharedRepository, { files: cases })]);

    for (const fixture of cases) {
      const error = await built.provider
        .fetch(
          {
            providerRecordId: githubProviderRecordId(
              sharedRepository,
              fixture.path,
            ),
            access,
          },
          new AbortController().signal,
        )
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ details: { reason: fixture.reason } });
      expect(JSON.stringify(error)).not.toContain(fixture.path);
    }
  });

  it('maps provider failures and cancellation to bounded safe errors', async () => {
    const unavailable = build([repository()], undefined, {
      unavailableRepositories: [sharedRepository],
    });
    await expect(
      unavailable.provider.fetch(
        {
          providerRecordId: githubProviderRecordId(
            sharedRepository,
            'docs/garden.md',
          ),
          access,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'github_request_failed' },
    });

    const controller = new AbortController();
    controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));
    const error = await build()
      .provider.fetch(
        {
          providerRecordId: githubProviderRecordId(
            sharedRepository,
            'docs/garden.md',
          ),
          access,
        },
        controller.signal,
      )
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_ABORT_REASON');
  });

  it('revalidates the live Registry on every operation', async () => {
    let current = snapshot([registryEntry(sharedRepository)]);
    const registry: GitHubProjectRegistry = {
      load: () => Promise.resolve(current),
    };
    const client = new SyntheticGitHubClient([repository()]);
    const provider = new GitHubKnowledgeProvider(client, registry);
    await provider.search(
      { query: 'garden', limit: 10, access },
      new AbortController().signal,
    );

    current = snapshot([]);
    await expect(
      provider.fetch(
        {
          providerRecordId: githubProviderRecordId(
            sharedRepository,
            'docs/garden.md',
          ),
          access,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not mistake an unavailable file for an authorization result', async () => {
    const base = build();
    const provider = new GitHubKnowledgeProvider(
      {
        listInstallationRepositories: (signal) =>
          base.client.listInstallationRepositories(signal),
        resolveDefaultBranch: (repositoryName, signal) =>
          base.client.resolveDefaultBranch(repositoryName, signal),
        searchCode: (request, signal) =>
          base.client.searchCode(request, signal),
        getFile: () => Promise.reject(new GitHubClientFailure('not_found')),
      },
      fixedRegistry([registryEntry(sharedRepository)]),
    );
    await expect(
      provider.fetch(
        {
          providerRecordId: githubProviderRecordId(
            sharedRepository,
            'docs/garden.md',
          ),
          access,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
