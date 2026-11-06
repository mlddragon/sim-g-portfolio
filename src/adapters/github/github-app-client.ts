import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

export const GITHUB_API_VERSION = '2026-03-10' as const;
export const GITHUB_CLIENT_TIMEOUT_MS = 5_000;
export const GITHUB_MAX_CONTENT_BYTES = 1024 * 1024;
export const GITHUB_MAX_PATH_LENGTH = 280;
export const GITHUB_MAX_QUERY_LENGTH = 200;
export const GITHUB_MAX_INSTALLATION_REPOSITORIES = 10_000;
export const GITHUB_APP_TOKEN_PERMISSIONS = Object.freeze({
  contents: 'read',
} as const);

interface GitHubSdkResponse {
  readonly data: unknown;
}

interface GitHubRequestControl {
  readonly [key: string]: unknown;
  readonly request: { readonly signal: AbortSignal };
}

export interface GitHubSdkClient {
  readonly apiVersion: typeof GITHUB_API_VERSION;
  installationRepositories(
    parameters: GitHubRequestControl & {
      readonly per_page: number;
      readonly page: number;
    },
  ): Promise<GitHubSdkResponse>;
  repository(
    parameters: GitHubRequestControl & {
      readonly owner: string;
      readonly repo: string;
    },
  ): Promise<GitHubSdkResponse>;
  commit(
    parameters: GitHubRequestControl & {
      readonly owner: string;
      readonly repo: string;
      readonly ref: string;
    },
  ): Promise<GitHubSdkResponse>;
  codeSearch(
    parameters: GitHubRequestControl & {
      readonly q: string;
      readonly per_page: number;
    },
  ): Promise<GitHubSdkResponse>;
  content(
    parameters: GitHubRequestControl & {
      readonly owner: string;
      readonly repo: string;
      readonly path: string;
      readonly ref: string;
    },
  ): Promise<GitHubSdkResponse>;
}

export interface CreateOfficialGitHubSdkClientOptions {
  readonly appId: number | string;
  readonly installationId: number;
  readonly privateKey: string;
  /** Test/composition seam; production normally uses the SDK's global fetch. */
  readonly fetch?: typeof fetch;
}

export interface GitHubResolvedRepository {
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly commitSha: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GitHubCodeSearchRequest {
  readonly repository: string;
  readonly query: string;
  readonly limit: number;
}

export interface GitHubCodeSearchResult {
  readonly repository: string;
  readonly path: string;
  readonly blobSha: string;
  readonly score: number;
}

export interface GitHubCodeSearchResponse {
  readonly results: readonly GitHubCodeSearchResult[];
  readonly incomplete: boolean;
}

export interface GitHubContentRequest {
  readonly repository: string;
  readonly path: string;
  readonly ref: string;
}

export interface GitHubFileSnapshot {
  readonly repository: string;
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'symlink' | 'submodule' | 'directory';
  readonly blobSha?: string;
  readonly size?: number;
  readonly content?: Uint8Array;
}

export interface GitHubClient {
  listInstallationRepositories(signal: AbortSignal): Promise<readonly string[]>;
  resolveDefaultBranch(
    repository: string,
    signal: AbortSignal,
  ): Promise<GitHubResolvedRepository>;
  searchCode(
    request: GitHubCodeSearchRequest,
    signal: AbortSignal,
  ): Promise<GitHubCodeSearchResponse>;
  getFile(
    request: GitHubContentRequest,
    signal: AbortSignal,
  ): Promise<GitHubFileSnapshot>;
}

export type GitHubClientFailureKind = 'not_found' | 'too_large' | 'unavailable';

export class GitHubClientFailure extends Error {
  readonly kind: GitHubClientFailureKind;

  constructor(kind: GitHubClientFailureKind) {
    super('github_client_failure');
    this.name = 'GitHubClientFailure';
    this.kind = kind;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, maxLength: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return false;
    }
  }
  return true;
}

function safeRepository(value: unknown): value is string {
  return (
    safeString(value, 201) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)
  );
}

function safePath(value: unknown): value is string {
  return (
    safeString(value, GITHUB_MAX_PATH_LENGTH) &&
    !value.startsWith('/') &&
    !value.includes('//') &&
    value.split('/').every((part) => part !== '.' && part !== '..')
  );
}

function fullSha(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (/^[a-f0-9]{40}$/u.test(value) || /^[a-f0-9]{64}$/u.test(value))
  );
}

function validTimestamp(value: unknown): value is string {
  return safeString(value, 64) && Number.isFinite(new Date(value).getTime());
}

function cancellation(): DOMException {
  return new DOMException('Provider operation cancelled', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw cancellation();
}

function statusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error['status'] === 'number') return error['status'];
  const response = error['response'];
  return isRecord(response) && typeof response['status'] === 'number'
    ? response['status']
    : undefined;
}

function mapFailure(error: unknown): unknown {
  if (isAbortError(error)) return cancellation();
  if (error instanceof GitHubClientFailure) return error;
  if (statusCode(error) === 404) return new GitHubClientFailure('not_found');
  return new GitHubClientFailure('unavailable');
}

async function withCancellation<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  assertActive(signal);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(cancellation());
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(run)
      .then(
        (value) => {
          finish(() => {
            resolve(value);
          });
        },
        (error: unknown) => {
          finish(() => {
            reject(
              error instanceof Error
                ? error
                : new GitHubClientFailure('unavailable'),
            );
          });
        },
      );
  });
}

function validAppId(value: unknown): value is string | number {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === 'string' && /^[1-9][0-9]{0,31}$/u.test(value))
  );
}

function validPrivateKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 32_768 &&
    !value.includes('\0')
  );
}

/**
 * Constructs the official SDK behind a frozen five-method read surface. The
 * installation token is requested with Contents read only; repository metadata
 * is GitHub's mandatory implicit read permission.
 */
export function createOfficialGitHubSdkClient(
  options: CreateOfficialGitHubSdkClientOptions,
): GitHubSdkClient {
  const candidate: unknown = options;
  if (
    !isRecord(candidate) ||
    !validAppId(candidate['appId']) ||
    !Number.isSafeInteger(candidate['installationId']) ||
    (candidate['installationId'] as number) <= 0 ||
    !validPrivateKey(candidate['privateKey']) ||
    (candidate['fetch'] !== undefined &&
      typeof candidate['fetch'] !== 'function')
  ) {
    throw new TypeError('invalid_github_client_configuration');
  }

  const installationId = candidate['installationId'] as number;
  const auth = createAppAuth({
    appId: candidate['appId'],
    privateKey: candidate['privateKey'],
    installationId,
  });

  const installationClient = async (signal: AbortSignal): Promise<Octokit> => {
    const authentication = await withCancellation(signal, () =>
      auth({
        type: 'installation',
        installationId,
        permissions: GITHUB_APP_TOKEN_PERMISSIONS,
      }),
    );
    if (!safeString(authentication.token, 8_192)) {
      throw new GitHubClientFailure('unavailable');
    }
    return new Octokit({
      auth: authentication.token,
      userAgent: '@simg-showcase/gateway',
      request: {
        timeout: GITHUB_CLIENT_TIMEOUT_MS,
        headers: { 'x-github-api-version': GITHUB_API_VERSION },
        ...(candidate['fetch'] === undefined
          ? {}
          : { fetch: candidate['fetch'] as typeof fetch }),
      },
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
  };

  const withClient = async (
    signal: AbortSignal,
    request: (client: Octokit) => Promise<GitHubSdkResponse>,
  ): Promise<GitHubSdkResponse> => {
    const client = await installationClient(signal);
    assertActive(signal);
    return await request(client);
  };

  return Object.freeze({
    apiVersion: GITHUB_API_VERSION,
    installationRepositories: (
      parameters: Parameters<GitHubSdkClient['installationRepositories']>[0],
    ) =>
      withClient(
        parameters.request.signal,
        async (client) =>
          await client.rest.apps.listReposAccessibleToInstallation(parameters),
      ),
    repository: (parameters: Parameters<GitHubSdkClient['repository']>[0]) =>
      withClient(
        parameters.request.signal,
        async (client) => await client.rest.repos.get(parameters),
      ),
    commit: (parameters: Parameters<GitHubSdkClient['commit']>[0]) =>
      withClient(
        parameters.request.signal,
        async (client) => await client.rest.repos.getCommit(parameters),
      ),
    codeSearch: (parameters: Parameters<GitHubSdkClient['codeSearch']>[0]) =>
      withClient(
        parameters.request.signal,
        async (client) => await client.rest.search.code(parameters),
      ),
    content: (parameters: Parameters<GitHubSdkClient['content']>[0]) =>
      withClient(
        parameters.request.signal,
        async (client) => await client.rest.repos.getContent(parameters),
      ),
  });
}

function repositoryParts(repository: string): {
  readonly owner: string;
  readonly repo: string;
} {
  if (!safeRepository(repository)) throw new GitHubClientFailure('unavailable');
  const [owner, repo] = repository.split('/');
  if (owner === undefined || repo === undefined) {
    throw new GitHubClientFailure('unavailable');
  }
  return { owner, repo };
}

function projectInstalledPage(
  value: unknown,
  page: number,
): {
  readonly repositories: readonly string[];
  readonly total: number;
  readonly hasMore: boolean;
} {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value['total_count']) ||
    (value['total_count'] as number) < 0 ||
    (value['total_count'] as number) > GITHUB_MAX_INSTALLATION_REPOSITORIES ||
    !Array.isArray(value['repositories']) ||
    value['repositories'].length > 100
  ) {
    throw new GitHubClientFailure('unavailable');
  }
  const repositories = value['repositories'].map((candidate: unknown) => {
    if (!isRecord(candidate) || !safeRepository(candidate['full_name'])) {
      throw new GitHubClientFailure('unavailable');
    }
    return candidate['full_name'];
  });
  const total = value['total_count'] as number;
  if (repositories.length === 0 && (page - 1) * 100 < total) {
    throw new GitHubClientFailure('unavailable');
  }
  return {
    repositories: Object.freeze(repositories),
    total,
    hasMore: page * 100 < total,
  };
}

function projectRepository(
  value: unknown,
  expected: string,
): {
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
} {
  if (
    !isRecord(value) ||
    !safeRepository(value['full_name']) ||
    value['full_name'].toLocaleLowerCase() !== expected.toLocaleLowerCase() ||
    !safeString(value['default_branch'], 255) ||
    !validTimestamp(value['created_at'])
  ) {
    throw new GitHubClientFailure('unavailable');
  }
  return {
    fullName: value['full_name'],
    defaultBranch: value['default_branch'],
    createdAt: new Date(value['created_at']).toISOString(),
  };
}

function projectCommit(value: unknown): {
  readonly sha: string;
  readonly updatedAt: string;
} {
  if (!isRecord(value) || !fullSha(value['sha'])) {
    throw new GitHubClientFailure('unavailable');
  }
  const commit = value['commit'];
  const committer = isRecord(commit) ? commit['committer'] : undefined;
  const date = isRecord(committer) ? committer['date'] : undefined;
  if (!validTimestamp(date)) throw new GitHubClientFailure('unavailable');
  return { sha: value['sha'], updatedAt: new Date(date).toISOString() };
}

function projectSearch(
  value: unknown,
  repository: string,
  limit: number,
): GitHubCodeSearchResponse {
  if (
    !isRecord(value) ||
    typeof value['incomplete_results'] !== 'boolean' ||
    !Array.isArray(value['items']) ||
    value['items'].length > limit
  ) {
    throw new GitHubClientFailure('unavailable');
  }
  const results = value['items'].map((candidate: unknown) => {
    if (!isRecord(candidate) || !isRecord(candidate['repository'])) {
      throw new GitHubClientFailure('unavailable');
    }
    const resultRepository = candidate['repository']['full_name'];
    if (
      !safeRepository(resultRepository) ||
      resultRepository.toLocaleLowerCase() !== repository.toLocaleLowerCase() ||
      !safePath(candidate['path']) ||
      !fullSha(candidate['sha']) ||
      typeof candidate['score'] !== 'number' ||
      !Number.isFinite(candidate['score']) ||
      candidate['score'] < 0
    ) {
      throw new GitHubClientFailure('unavailable');
    }
    return Object.freeze({
      repository: resultRepository,
      path: candidate['path'],
      blobSha: candidate['sha'],
      score: candidate['score'],
    });
  });
  return Object.freeze({
    results: Object.freeze(results),
    incomplete: value['incomplete_results'],
  });
}

function strictBase64(value: string): Uint8Array {
  const normalized = value.replaceAll(/\s/gu, '');
  if (normalized.length === 0) return new Uint8Array();
  if (
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      normalized,
    )
  ) {
    throw new GitHubClientFailure('unavailable');
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.toString('base64') !== normalized) {
    throw new GitHubClientFailure('unavailable');
  }
  return new Uint8Array(decoded);
}

function nonFile(
  request: GitHubContentRequest,
  kind: GitHubFileSnapshot['kind'],
): GitHubFileSnapshot {
  return Object.freeze({
    repository: request.repository,
    path: request.path,
    name: request.path.split('/').at(-1) ?? request.path,
    kind,
  });
}

function projectContent(
  value: unknown,
  request: GitHubContentRequest,
): GitHubFileSnapshot {
  if (Array.isArray(value)) return nonFile(request, 'directory');
  if (!isRecord(value)) throw new GitHubClientFailure('unavailable');
  if (value['type'] === 'symlink' || typeof value['target'] === 'string') {
    return nonFile(request, 'symlink');
  }
  if (
    value['type'] === 'submodule' ||
    typeof value['submodule_git_url'] === 'string'
  ) {
    return nonFile(request, 'submodule');
  }
  if (
    value['type'] !== 'file' ||
    !safeString(value['name'], 255) ||
    !safePath(value['path']) ||
    value['path'] !== request.path ||
    !fullSha(value['sha']) ||
    typeof value['size'] !== 'number' ||
    !Number.isSafeInteger(value['size']) ||
    value['size'] < 0
  ) {
    throw new GitHubClientFailure('unavailable');
  }
  const size = value['size'];
  if (size > GITHUB_MAX_CONTENT_BYTES) {
    throw new GitHubClientFailure('too_large');
  }
  if (value['encoding'] !== 'base64' || typeof value['content'] !== 'string') {
    throw new GitHubClientFailure('unavailable');
  }
  const content = strictBase64(value['content']);
  if (content.byteLength !== value['size']) {
    throw new GitHubClientFailure('unavailable');
  }
  return Object.freeze({
    repository: request.repository,
    path: value['path'],
    name: value['name'],
    kind: 'file',
    blobSha: value['sha'],
    size,
    content,
  });
}

export class OfficialGitHubClient implements GitHubClient {
  readonly #sdk: GitHubSdkClient;

  constructor(sdk: GitHubSdkClient) {
    const candidate: unknown = sdk;
    if (
      !isRecord(candidate) ||
      candidate['apiVersion'] !== GITHUB_API_VERSION ||
      typeof candidate['installationRepositories'] !== 'function' ||
      typeof candidate['repository'] !== 'function' ||
      typeof candidate['commit'] !== 'function' ||
      typeof candidate['codeSearch'] !== 'function' ||
      typeof candidate['content'] !== 'function'
    ) {
      throw new TypeError('invalid_github_client_configuration');
    }
    this.#sdk = sdk;
  }

  async listInstallationRepositories(
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    try {
      const repositories: string[] = [];
      const seen = new Set<string>();
      for (let page = 1; page <= 100; page += 1) {
        assertActive(signal);
        const response = await this.#sdk.installationRepositories({
          per_page: 100,
          page,
          request: { signal },
        });
        assertActive(signal);
        const projected = projectInstalledPage(response.data, page);
        for (const repository of projected.repositories) {
          const normalized = repository.toLocaleLowerCase();
          if (seen.has(normalized))
            throw new GitHubClientFailure('unavailable');
          seen.add(normalized);
          repositories.push(repository);
        }
        if (!projected.hasMore) {
          if (repositories.length !== projected.total) {
            throw new GitHubClientFailure('unavailable');
          }
          return Object.freeze(repositories);
        }
      }
      throw new GitHubClientFailure('unavailable');
    } catch (error) {
      throw mapFailure(error);
    }
  }

  async resolveDefaultBranch(
    repository: string,
    signal: AbortSignal,
  ): Promise<GitHubResolvedRepository> {
    try {
      assertActive(signal);
      const parts = repositoryParts(repository);
      const metadataResponse = await this.#sdk.repository({
        ...parts,
        request: { signal },
      });
      assertActive(signal);
      const metadata = projectRepository(metadataResponse.data, repository);
      const commitResponse = await this.#sdk.commit({
        ...parts,
        ref: metadata.defaultBranch,
        request: { signal },
      });
      assertActive(signal);
      const commit = projectCommit(commitResponse.data);
      return Object.freeze({
        fullName: metadata.fullName,
        defaultBranch: metadata.defaultBranch,
        commitSha: commit.sha,
        createdAt: metadata.createdAt,
        updatedAt: commit.updatedAt,
      });
    } catch (error) {
      throw mapFailure(error);
    }
  }

  async searchCode(
    request: GitHubCodeSearchRequest,
    signal: AbortSignal,
  ): Promise<GitHubCodeSearchResponse> {
    try {
      assertActive(signal);
      repositoryParts(request.repository);
      if (
        !safeString(request.query, GITHUB_MAX_QUERY_LENGTH) ||
        /repo\s*:/iu.test(request.query) ||
        !Number.isInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > 100
      ) {
        throw new GitHubClientFailure('unavailable');
      }
      const response = await this.#sdk.codeSearch({
        q: `${request.query} repo:${request.repository}`,
        per_page: request.limit,
        request: { signal },
      });
      assertActive(signal);
      return projectSearch(response.data, request.repository, request.limit);
    } catch (error) {
      throw mapFailure(error);
    }
  }

  async getFile(
    request: GitHubContentRequest,
    signal: AbortSignal,
  ): Promise<GitHubFileSnapshot> {
    try {
      assertActive(signal);
      const parts = repositoryParts(request.repository);
      if (!safePath(request.path) || !fullSha(request.ref)) {
        throw new GitHubClientFailure('unavailable');
      }
      const response = await this.#sdk.content({
        ...parts,
        path: request.path,
        ref: request.ref,
        request: { signal },
      });
      assertActive(signal);
      return projectContent(response.data, request);
    } catch (error) {
      throw mapFailure(error);
    }
  }
}
