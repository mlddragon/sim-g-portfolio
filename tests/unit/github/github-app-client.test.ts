import { describe, expect, it, vi } from 'vitest';

import {
  GITHUB_API_VERSION,
  GITHUB_APP_TOKEN_PERMISSIONS,
  GITHUB_CLIENT_TIMEOUT_MS,
  GITHUB_MAX_CONTENT_BYTES,
  OfficialGitHubClient,
  createOfficialGitHubSdkClient,
  type GitHubSdkClient,
} from '../../../src/adapters/github/github-app-client.js';

interface RecordedSdkCalls {
  readonly installationRepositories: unknown[];
  readonly repository: unknown[];
  readonly commit: unknown[];
  readonly codeSearch: unknown[];
  readonly content: unknown[];
}

function response(data: unknown) {
  return Promise.resolve({ data });
}

function syntheticSdk(): GitHubSdkClient & {
  readonly calls: RecordedSdkCalls;
} {
  const calls: RecordedSdkCalls = {
    installationRepositories: [],
    repository: [],
    commit: [],
    codeSearch: [],
    content: [],
  };
  return {
    apiVersion: GITHUB_API_VERSION,
    installationRepositories: vi.fn((parameters: unknown) => {
      calls.installationRepositories.push(parameters);
      return response({
        total_count: 2,
        repositories: [
          { full_name: 'Synthetic-Owner/Project-One' },
          { full_name: 'Synthetic-Owner/Project-Two' },
        ],
      });
    }),
    repository: vi.fn((parameters: unknown) => {
      calls.repository.push(parameters);
      return response({
        full_name: 'Synthetic-Owner/Project-One',
        default_branch: 'trunk',
        created_at: '2042-01-01T00:00:00.000Z',
      });
    }),
    commit: vi.fn((parameters: unknown) => {
      calls.commit.push(parameters);
      return response({
        sha: 'a'.repeat(40),
        commit: { committer: { date: '2042-01-02T00:00:00.000Z' } },
      });
    }),
    codeSearch: vi.fn((parameters: unknown) => {
      calls.codeSearch.push(parameters);
      return response({
        incomplete_results: false,
        items: [
          {
            path: 'docs/Synthetic Notes.md',
            sha: 'b'.repeat(40),
            score: 12.5,
            repository: { full_name: 'Synthetic-Owner/Project-One' },
          },
        ],
      });
    }),
    content: vi.fn((parameters: unknown) => {
      calls.content.push(parameters);
      return response({
        type: 'file',
        name: 'Synthetic Notes.md',
        path: 'docs/Synthetic Notes.md',
        sha: 'b'.repeat(40),
        size: 18,
        encoding: 'base64',
        content: Buffer.from('Synthetic contents').toString('base64'),
      });
    }),
    calls,
  };
}

describe('OfficialGitHubClient', () => {
  it('lists the bounded installation repository set', async () => {
    const sdk = syntheticSdk();
    const client = new OfficialGitHubClient(sdk);
    const signal = new AbortController().signal;

    await expect(client.listInstallationRepositories(signal)).resolves.toEqual([
      'Synthetic-Owner/Project-One',
      'Synthetic-Owner/Project-Two',
    ]);
    expect(sdk.calls.installationRepositories).toEqual([
      { per_page: 100, page: 1, request: { signal } },
    ]);
  });

  it('resolves only the repository default branch to a full commit SHA', async () => {
    const sdk = syntheticSdk();
    const client = new OfficialGitHubClient(sdk);
    const signal = new AbortController().signal;

    await expect(
      client.resolveDefaultBranch('Synthetic-Owner/Project-One', signal),
    ).resolves.toEqual({
      fullName: 'Synthetic-Owner/Project-One',
      defaultBranch: 'trunk',
      commitSha: 'a'.repeat(40),
      createdAt: '2042-01-01T00:00:00.000Z',
      updatedAt: '2042-01-02T00:00:00.000Z',
    });
    expect(sdk.calls.repository).toEqual([
      {
        owner: 'Synthetic-Owner',
        repo: 'Project-One',
        request: { signal },
      },
    ]);
    expect(sdk.calls.commit).toEqual([
      {
        owner: 'Synthetic-Owner',
        repo: 'Project-One',
        ref: 'trunk',
        request: { signal },
      },
    ]);
  });

  it('adds exactly one registry-derived repository qualifier to every search', async () => {
    const sdk = syntheticSdk();
    const client = new OfficialGitHubClient(sdk);
    const signal = new AbortController().signal;

    await expect(
      client.searchCode(
        {
          repository: 'Synthetic-Owner/Project-One',
          query: 'garden architecture',
          limit: 25,
        },
        signal,
      ),
    ).resolves.toEqual({
      incomplete: false,
      results: [
        {
          repository: 'Synthetic-Owner/Project-One',
          path: 'docs/Synthetic Notes.md',
          blobSha: 'b'.repeat(40),
          score: 12.5,
        },
      ],
    });
    expect(sdk.calls.codeSearch).toEqual([
      {
        q: 'garden architecture repo:Synthetic-Owner/Project-One',
        per_page: 25,
        request: { signal },
      },
    ]);
    expect(
      String(
        (sdk.calls.codeSearch[0] as { readonly q: string } | undefined)?.q,
      ).match(/repo:/giu),
    ).toHaveLength(1);

    await expect(
      client.searchCode(
        {
          repository: 'Synthetic-Owner/Project-One',
          query: 'garden repo:synthetic-owner/other',
          limit: 25,
        },
        signal,
      ),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(sdk.calls.codeSearch).toHaveLength(1);
  });

  it('fetches a file only at an explicit full commit ref', async () => {
    const sdk = syntheticSdk();
    const client = new OfficialGitHubClient(sdk);
    const signal = new AbortController().signal;

    await expect(
      client.getFile(
        {
          repository: 'Synthetic-Owner/Project-One',
          path: 'docs/Synthetic Notes.md',
          ref: 'a'.repeat(40),
        },
        signal,
      ),
    ).resolves.toEqual({
      repository: 'Synthetic-Owner/Project-One',
      path: 'docs/Synthetic Notes.md',
      name: 'Synthetic Notes.md',
      blobSha: 'b'.repeat(40),
      kind: 'file',
      size: 18,
      content: new TextEncoder().encode('Synthetic contents'),
    });
    expect(sdk.calls.content).toEqual([
      {
        owner: 'Synthetic-Owner',
        repo: 'Project-One',
        path: 'docs/Synthetic Notes.md',
        ref: 'a'.repeat(40),
        request: { signal },
      },
    ]);
  });

  it('accepts a valid empty UTF-8 file', async () => {
    const sdk = syntheticSdk();
    const client = new OfficialGitHubClient({
      ...sdk,
      content: vi.fn(() =>
        response({
          type: 'file',
          name: 'empty.md',
          path: 'docs/empty.md',
          sha: 'b'.repeat(40),
          size: 0,
          encoding: 'base64',
          content: '',
        }),
      ),
    });

    await expect(
      client.getFile(
        {
          repository: 'Synthetic-Owner/Project-One',
          path: 'docs/empty.md',
          ref: 'a'.repeat(40),
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: 'file',
      size: 0,
      content: new Uint8Array(),
    });
  });

  it.each([
    ['symlink', { type: 'symlink', target: '../private' }],
    [
      'submodule',
      { type: 'file', submodule_git_url: 'https://example.invalid' },
    ],
    ['directory', []],
  ])(
    'projects provider %s responses without treating them as files',
    async (kind, data) => {
      const sdk = syntheticSdk();
      const client = new OfficialGitHubClient({
        ...sdk,
        content: vi.fn(() => response(data)),
      });

      await expect(
        client.getFile(
          {
            repository: 'Synthetic-Owner/Project-One',
            path: 'docs/item',
            ref: 'a'.repeat(40),
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ kind });
    },
  );

  it('rejects malformed, mismatched, oversized and non-canonical provider responses', async () => {
    const base = syntheticSdk();
    const requests = [
      new OfficialGitHubClient({
        ...base,
        codeSearch: vi.fn(() =>
          response({
            incomplete_results: false,
            items: [
              {
                path: 'docs/item.md',
                sha: 'b'.repeat(40),
                score: 1,
                repository: { full_name: 'Synthetic-Owner/Other' },
              },
            ],
          }),
        ),
      }).searchCode(
        {
          repository: 'Synthetic-Owner/Project-One',
          query: 'item',
          limit: 10,
        },
        new AbortController().signal,
      ),
      new OfficialGitHubClient({
        ...base,
        content: vi.fn(() =>
          response({
            type: 'file',
            name: 'large.md',
            path: 'docs/large.md',
            sha: 'b'.repeat(40),
            size: GITHUB_MAX_CONTENT_BYTES + 1,
            encoding: 'none',
            content: '',
          }),
        ),
      }).getFile(
        {
          repository: 'Synthetic-Owner/Project-One',
          path: 'docs/large.md',
          ref: 'a'.repeat(40),
        },
        new AbortController().signal,
      ),
      new OfficialGitHubClient({
        ...base,
        content: vi.fn(() =>
          response({
            type: 'file',
            name: 'bad.md',
            path: 'docs/bad.md',
            sha: 'b'.repeat(40),
            size: 3,
            encoding: 'base64',
            content: '***not-base64***',
          }),
        ),
      }).getFile(
        {
          repository: 'Synthetic-Owner/Project-One',
          path: 'docs/bad.md',
          ref: 'a'.repeat(40),
        },
        new AbortController().signal,
      ),
    ];

    await expect(requests[0]).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(requests[1]).rejects.toMatchObject({ kind: 'too_large' });
    await expect(requests[2]).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('constructs a frozen official read-only SDK surface with fixed security settings', () => {
    const sdk = createOfficialGitHubSdkClient({
      appId: '12345',
      installationId: 67890,
      privateKey: 'SYNTHETIC_TEST_KEY_NOT_A_CREDENTIAL',
    });

    expect(sdk.apiVersion).toBe('2026-03-10');
    expect(GITHUB_CLIENT_TIMEOUT_MS).toBe(5_000);
    expect(GITHUB_APP_TOKEN_PERMISSIONS).toEqual({ contents: 'read' });
    expect(Object.isFrozen(GITHUB_APP_TOKEN_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(sdk)).toBe(true);
    expect(Object.keys(sdk).sort()).toEqual([
      'apiVersion',
      'codeSearch',
      'commit',
      'content',
      'installationRepositories',
      'repository',
    ]);
    expect(sdk).not.toHaveProperty('issues');
    expect(sdk).not.toHaveProperty('pulls');
    expect(sdk).not.toHaveProperty('create');
    expect(sdk).not.toHaveProperty('update');
    expect(sdk).not.toHaveProperty('delete');
  });

  it('sanitizes cancellation and SDK failure details', async () => {
    const sdk = syntheticSdk();
    const controller = new AbortController();
    controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));
    const client = new OfficialGitHubClient(sdk);
    const abort = await client
      .listInstallationRepositories(controller.signal)
      .catch((caught: unknown) => caught);
    expect(abort).toMatchObject({ name: 'AbortError' });
    expect(String(abort)).not.toContain('SYNTHETIC_PRIVATE_ABORT_REASON');

    const failed = new OfficialGitHubClient({
      ...sdk,
      installationRepositories: vi.fn(() =>
        Promise.reject(new Error('SYNTHETIC_SECRET_PROVIDER_DETAIL')),
      ),
    });
    const error = await failed
      .listInstallationRepositories(new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'unavailable' });
    expect(String(error)).not.toContain('SYNTHETIC_SECRET_PROVIDER_DETAIL');
  });
});
