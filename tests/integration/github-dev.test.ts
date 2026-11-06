import { describe, expect, it } from 'vitest';

import {
  OfficialGitHubClient,
  createOfficialGitHubSdkClient,
} from '../../src/adapters/github/github-app-client.js';

const runLive = process.env['RUN_GITHUB_DEV_TESTS'] === '1';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new TypeError(`missing_${name.toLocaleLowerCase()}`);
  }
  return value;
}

describe.runIf(runLive)('isolated development GitHub App', () => {
  it('lists, searches and fetches only a declared fictional dev fixture', async () => {
    const repository = required('GITHUB_DEV_REPOSITORY');
    const expectedPath = required('GITHUB_DEV_EXPECTED_PATH');
    const client = new OfficialGitHubClient(
      createOfficialGitHubSdkClient({
        appId: required('GITHUB_DEV_APP_ID'),
        installationId: Number.parseInt(
          required('GITHUB_DEV_INSTALLATION_ID'),
          10,
        ),
        privateKey: required('GITHUB_DEV_APP_PRIVATE_KEY'),
      }),
    );
    const signal = AbortSignal.timeout(15_000);

    const installed = await client.listInstallationRepositories(signal);
    expect(installed.map((value) => value.toLocaleLowerCase())).toContain(
      repository.toLocaleLowerCase(),
    );

    const resolved = await client.resolveDefaultBranch(repository, signal);
    const search = await client.searchCode(
      {
        repository,
        query: required('GITHUB_DEV_SEARCH_QUERY'),
        limit: 10,
      },
      signal,
    );
    expect(search.results.some((result) => result.path === expectedPath)).toBe(
      true,
    );

    const file = await client.getFile(
      { repository, path: expectedPath, ref: resolved.commitSha },
      signal,
    );
    expect(file).toMatchObject({ kind: 'file', path: expectedPath });
  });
});
