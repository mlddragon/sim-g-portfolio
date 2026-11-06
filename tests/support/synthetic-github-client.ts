import {
  GitHubClientFailure,
  type GitHubClient,
  type GitHubCodeSearchRequest,
  type GitHubCodeSearchResponse,
  type GitHubContentRequest,
  type GitHubFileSnapshot,
  type GitHubResolvedRepository,
} from '../../src/adapters/github/github-app-client.js';

export interface SyntheticGitHubFile {
  readonly path: string;
  readonly blobSha: string;
  readonly content?: string | Uint8Array;
  readonly kind?: GitHubFileSnapshot['kind'];
  readonly size?: number;
}

export interface SyntheticGitHubRepository {
  readonly fullName: string;
  readonly installed?: boolean;
  readonly defaultBranch?: string;
  readonly commitSha: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly files: readonly SyntheticGitHubFile[];
}

export interface SyntheticGitHubClientOptions {
  readonly incompleteRepositories?: readonly string[];
  readonly onListInstallationRepositories?: () => void;
  readonly unavailableRepositories?: readonly string[];
}

function cancelled(): DOMException {
  return new DOMException('Provider operation cancelled', 'AbortError');
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}

function bytes(content: string | Uint8Array | undefined): Uint8Array {
  if (content === undefined) return new Uint8Array();
  return typeof content === 'string'
    ? new TextEncoder().encode(content)
    : new Uint8Array(content);
}

function normalize(value: string): string {
  return value.toLocaleLowerCase();
}

function cloneFile(
  repository: string,
  file: SyntheticGitHubFile,
): GitHubFileSnapshot {
  const content = bytes(file.content);
  return Object.freeze({
    repository,
    path: file.path,
    name: file.path.split('/').at(-1) ?? file.path,
    blobSha: file.blobSha,
    kind: file.kind ?? 'file',
    size: file.size ?? content.byteLength,
    ...((file.kind ?? 'file') === 'file'
      ? { content: new Uint8Array(content) }
      : {}),
  });
}

export class SyntheticGitHubClient implements GitHubClient {
  readonly listInstallationRepositoryCalls: number[] = [];
  readonly resolveCalls: string[] = [];
  readonly searchCalls: GitHubCodeSearchRequest[] = [];
  readonly contentCalls: GitHubContentRequest[] = [];
  readonly #repositories: readonly SyntheticGitHubRepository[];
  readonly #options: SyntheticGitHubClientOptions;

  constructor(
    repositories: readonly SyntheticGitHubRepository[],
    options: SyntheticGitHubClientOptions = {},
  ) {
    this.#repositories = repositories.map((repository) => ({
      ...repository,
      files: repository.files.map((file) => ({
        ...file,
        ...(file.content instanceof Uint8Array
          ? { content: new Uint8Array(file.content) }
          : {}),
      })),
    }));
    this.#options = options;
  }

  async listInstallationRepositories(
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    await Promise.resolve();
    assertActive(signal);
    this.listInstallationRepositoryCalls.push(1);
    this.#options.onListInstallationRepositories?.();
    return Object.freeze(
      this.#repositories
        .filter((repository) => repository.installed !== false)
        .map((repository) => repository.fullName),
    );
  }

  async resolveDefaultBranch(
    repository: string,
    signal: AbortSignal,
  ): Promise<GitHubResolvedRepository> {
    await Promise.resolve();
    assertActive(signal);
    this.resolveCalls.push(repository);
    this.assertAvailable(repository);
    const found = this.repository(repository);
    if (found === undefined || found.installed === false) {
      throw new GitHubClientFailure('not_found');
    }
    return Object.freeze({
      fullName: found.fullName,
      defaultBranch: found.defaultBranch ?? 'main',
      commitSha: found.commitSha,
      createdAt: found.createdAt,
      updatedAt: found.updatedAt,
    });
  }

  async searchCode(
    request: GitHubCodeSearchRequest,
    signal: AbortSignal,
  ): Promise<GitHubCodeSearchResponse> {
    await Promise.resolve();
    assertActive(signal);
    this.searchCalls.push({ ...request });
    this.assertAvailable(request.repository);
    const repository = this.repository(request.repository);
    if (repository === undefined || repository.installed === false) {
      throw new GitHubClientFailure('not_found');
    }
    const query = normalize(request.query);
    const results = repository.files
      .filter((file) => {
        const content = new TextDecoder().decode(bytes(file.content));
        return normalize(`${file.path}\n${content}`).includes(query);
      })
      .slice(0, request.limit)
      .map((file, index) =>
        Object.freeze({
          repository: repository.fullName,
          path: file.path,
          blobSha: file.blobSha,
          score: 1 - index / 100,
        }),
      );
    return Object.freeze({
      results: Object.freeze(results),
      incomplete: (this.#options.incompleteRepositories ?? []).some(
        (candidate) => normalize(candidate) === normalize(repository.fullName),
      ),
    });
  }

  async getFile(
    request: GitHubContentRequest,
    signal: AbortSignal,
  ): Promise<GitHubFileSnapshot> {
    await Promise.resolve();
    assertActive(signal);
    this.contentCalls.push({ ...request });
    this.assertAvailable(request.repository);
    const repository = this.repository(request.repository);
    if (
      repository === undefined ||
      repository.installed === false ||
      repository.commitSha !== request.ref
    ) {
      throw new GitHubClientFailure('not_found');
    }
    const file = repository.files.find(
      (candidate) => candidate.path === request.path,
    );
    if (file === undefined) throw new GitHubClientFailure('not_found');
    return cloneFile(repository.fullName, file);
  }

  private repository(name: string): SyntheticGitHubRepository | undefined {
    return this.#repositories.find(
      (candidate) => normalize(candidate.fullName) === normalize(name),
    );
  }

  private assertAvailable(repository: string): void {
    if (
      (this.#options.unavailableRepositories ?? []).some(
        (candidate) => normalize(candidate) === normalize(repository),
      )
    ) {
      throw new GitHubClientFailure('unavailable');
    }
  }
}
