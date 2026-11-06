import { createHash } from 'node:crypto';

import { DomainError } from '../../domain/errors.js';
import {
  brainRecordId,
  providerRecordId,
  type ProviderRecordId,
} from '../../domain/identifiers.js';
import {
  brainScopes,
  type BrainRecord,
  type BrainRecordSummary,
  type BrainScope,
  type RecordPolicyMetadata,
} from '../../domain/records.js';
import type {
  FetchableKnowledgeProvider,
  ProviderAccessScope,
  ProviderFetchRequest,
  ProviderSearchRequest,
  ProviderSearchResponse,
} from '../../ports/knowledge-provider.js';
import {
  GITHUB_MAX_CONTENT_BYTES,
  GITHUB_MAX_PATH_LENGTH,
  GITHUB_MAX_QUERY_LENGTH,
  GitHubClientFailure,
  type GitHubClient,
  type GitHubCodeSearchResult,
  type GitHubFileSnapshot,
  type GitHubResolvedRepository,
} from './github-app-client.js';
import {
  isGitHubKnowledgePath,
  type GitHubProjectRegistry,
  type GitHubRegistryRepository,
  type GitHubRegistrySnapshot,
} from './project-registry.js';

const maxSearchLimit = 100;
const maxAccessRoots = 100;
const providerRecordPrefix = 'gh1:';
const validScopes = new Set<BrainScope>(brainScopes);

interface ParsedProviderRecordId {
  readonly repository: string;
  readonly normalizedRepository: string;
  readonly path: string;
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
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 31 || point === 127)) return false;
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

function invalidSearch(): DomainError {
  return new DomainError('invalid_request', false, {
    reason: 'invalid_provider_search_request',
  });
}

function rejectedAccess(): DomainError {
  return new DomainError('unauthorized', false, {
    reason: 'provider_scope_rejected',
  });
}

function notFound(): DomainError {
  return new DomainError('not_found', false, { reason: 'record_not_found' });
}

function unavailable(): DomainError {
  return new DomainError('provider_unavailable', true, {
    reason: 'github_request_failed',
  });
}

function unsupported(reason: string): DomainError {
  return new DomainError('provider_capability_unsupported', false, { reason });
}

function copyAccess(access: ProviderAccessScope): ProviderAccessScope {
  const candidate: unknown = access;
  if (!isRecord(candidate)) throw rejectedAccess();
  const rawScopes = candidate['brainScopes'];
  const rawRoots = candidate['rootRefs'];
  if (
    !Array.isArray(rawScopes) ||
    rawScopes.length > validScopes.size ||
    !Array.isArray(rawRoots) ||
    rawRoots.length > maxAccessRoots
  ) {
    throw rejectedAccess();
  }
  const scopes = rawScopes.map((scope: unknown) => scope);
  const roots = rawRoots.map((root: unknown) => root);
  if (
    !scopes.every(
      (scope: unknown): scope is BrainScope =>
        typeof scope === 'string' && validScopes.has(scope as BrainScope),
    ) ||
    !roots.every((root: unknown): root is string => safeString(root, 256)) ||
    new Set(scopes).size !== scopes.length ||
    new Set(roots).size !== roots.length
  ) {
    throw rejectedAccess();
  }
  return Object.freeze({
    brainScopes: Object.freeze(scopes),
    rootRefs: Object.freeze(roots),
  });
}

function copyPolicy(policy: RecordPolicyMetadata): RecordPolicyMetadata {
  return Object.freeze({ ...policy });
}

function validPolicy(value: unknown): value is RecordPolicyMetadata {
  if (!isRecord(value) || typeof value['scope'] !== 'string') return false;
  switch (value['scope']) {
    case 'family_shared':
      return (
        value['sensitivity'] === 'family_shared' &&
        value['protectedClass'] === 'none'
      );
    case 'parent_and_stewardship':
      return (
        value['sensitivity'] === 'parent_and_stewardship' &&
        value['protectedClass'] === 'none'
      );
    case 'legal':
      return (
        value['sensitivity'] === 'protected' &&
        value['protectedClass'] === 'legal_hold'
      );
    case 'governance':
      return (
        value['sensitivity'] === 'protected' &&
        value['protectedClass'] === 'governance'
      );
    case 'security':
      return (
        value['sensitivity'] === 'protected' &&
        value['protectedClass'] === 'security'
      );
    default:
      return false;
  }
}

function safeConfiguredPath(value: unknown): value is string {
  if (
    !safeString(value, GITHUB_MAX_PATH_LENGTH) ||
    value.startsWith('/') ||
    value.includes('//')
  ) {
    return false;
  }
  const normalized = value.endsWith('/') ? value.slice(0, -1) : value;
  return (
    normalized.length > 0 &&
    normalized.split('/').every((part) => part !== '.' && part !== '..')
  );
}

function copyRegistry(
  snapshot: GitHubRegistrySnapshot,
): GitHubRegistrySnapshot {
  const candidate: unknown = snapshot;
  if (
    !isRecord(candidate) ||
    !safeString(candidate['version'], 256) ||
    typeof candidate['contentHash'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(candidate['contentHash']) ||
    !safeString(candidate['canonicalMarker'], 256) ||
    !Array.isArray(candidate['repositories']) ||
    candidate['repositories'].length > maxAccessRoots
  ) {
    throw unavailable();
  }
  const repositories = candidate['repositories'].map((raw: unknown) => {
    if (!isRecord(raw)) throw unavailable();
    const policy = raw['policy'];
    const knowledgePaths = raw['knowledgePaths'];
    if (
      !safeRepository(raw['repository']) ||
      raw['normalizedRepository'] !== raw['repository'].toLocaleLowerCase() ||
      raw['rootRef'] !== `repo:${raw['normalizedRepository']}` ||
      !safeString(raw['projectKey'], 256) ||
      !Array.isArray(knowledgePaths) ||
      knowledgePaths.length < 1 ||
      knowledgePaths.length > 32 ||
      !knowledgePaths.every(safeConfiguredPath) ||
      !validPolicy(policy)
    ) {
      throw unavailable();
    }
    return Object.freeze({
      repository: raw['repository'],
      normalizedRepository: raw['normalizedRepository'],
      rootRef: raw['rootRef'],
      projectKey: raw['projectKey'],
      knowledgePaths: Object.freeze([...knowledgePaths]),
      policy: copyPolicy(policy),
    });
  });
  if (
    new Set(repositories.map((entry) => entry.normalizedRepository)).size !==
    repositories.length
  ) {
    throw unavailable();
  }
  return Object.freeze({
    version: candidate['version'],
    contentHash: candidate['contentHash'],
    canonicalMarker: candidate['canonicalMarker'],
    repositories: Object.freeze(repositories),
  });
}

function validateAccess(
  access: ProviderAccessScope,
  registry: GitHubRegistrySnapshot,
): void {
  const roots = new Set(registry.repositories.map((entry) => entry.rootRef));
  const scopes = new Set(
    registry.repositories.map((entry) => entry.policy.scope),
  );
  if (
    access.rootRefs.some((root) => !roots.has(root)) ||
    access.brainScopes.some((scope) => !scopes.has(scope))
  ) {
    throw rejectedAccess();
  }
}

function authorizedEntries(
  access: ProviderAccessScope,
  registry: GitHubRegistrySnapshot,
): readonly GitHubRegistryRepository[] {
  return registry.repositories.filter(
    (entry) =>
      access.rootRefs.includes(entry.rootRef) &&
      access.brainScopes.includes(entry.policy.scope),
  );
}

export function githubProviderRecordId(
  repository: string,
  path: string,
): ProviderRecordId {
  if (!safeRepository(repository) || !safePath(path)) {
    throw new TypeError('invalid_github_provider_record_id');
  }
  return providerRecordId(`${providerRecordPrefix}${repository}:${path}`);
}

function parseProviderRecordId(
  value: ProviderRecordId,
): ParsedProviderRecordId {
  const raw = String(value);
  if (!raw.startsWith(providerRecordPrefix)) throw notFound();
  const separator = raw.indexOf(':', providerRecordPrefix.length);
  if (separator < 0) throw notFound();
  const repository = raw.slice(providerRecordPrefix.length, separator);
  const path = raw.slice(separator + 1);
  if (!safeRepository(repository) || !safePath(path)) throw notFound();
  return {
    repository,
    normalizedRepository: repository.toLocaleLowerCase(),
    path,
  };
}

function parseDate(value: string): Date {
  if (!validTimestamp(value)) throw new GitHubClientFailure('unavailable');
  return new Date(value);
}

function validateResolved(
  value: GitHubResolvedRepository,
  expectedRepository: string,
): void {
  if (
    !safeRepository(value.fullName) ||
    value.fullName.toLocaleLowerCase() !==
      expectedRepository.toLocaleLowerCase() ||
    !safeString(value.defaultBranch, 255) ||
    !fullSha(value.commitSha) ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.updatedAt)
  ) {
    throw new GitHubClientFailure('unavailable');
  }
}

function validateSearchResult(
  result: GitHubCodeSearchResult,
  entry: GitHubRegistryRepository,
): void {
  if (
    !safeRepository(result.repository) ||
    result.repository.toLocaleLowerCase() !== entry.normalizedRepository ||
    !safePath(result.path) ||
    !fullSha(result.blobSha) ||
    !Number.isFinite(result.score) ||
    result.score < 0
  ) {
    throw new GitHubClientFailure('unavailable');
  }
}

function brainId(repository: string, path: string) {
  const stable = createHash('sha256')
    .update(`${repository.toLocaleLowerCase()}\n${path}`)
    .digest('hex')
    .slice(0, 32);
  return brainRecordId(`brn_github_${stable}`);
}

function baseSummary(
  entry: GitHubRegistryRepository,
  path: string,
  blobSha: string,
  resolved: GitHubResolvedRepository,
): BrainRecordSummary {
  const title = path.split('/').at(-1) ?? path;
  return {
    brainRecordId: brainId(entry.repository, path),
    title,
    excerpt: `GitHub file ${path} in ${entry.repository}.`.slice(0, 160),
    canonicalLocation: {
      provider: 'github',
      containerRef: entry.rootRef,
      displayPath: `${entry.projectKey} / ${path}`,
    },
    provenance: {
      provider: 'github',
      providerRecordId: githubProviderRecordId(entry.repository, path),
      providerVersion: `${resolved.commitSha}:${blobSha}`,
      createdAt: parseDate(resolved.createdAt),
      updatedAt: parseDate(resolved.updatedAt),
      integrityHash: `git-blob-sha1:${blobSha}`,
    },
    policy: copyPolicy(entry.policy),
  };
}

function contentType(path: string): string {
  const lower = path.toLocaleLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return 'text/markdown';
  }
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return 'application/yaml';
  }
  return 'text/plain';
}

function decodeText(content: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new DomainError('provider_unavailable', true, {
      reason: 'github_content_invalid_utf8',
    });
  }
  let controls = 0;
  for (const character of text) {
    const point = character.codePointAt(0);
    if (
      point !== undefined &&
      ((point < 32 && point !== 9 && point !== 10 && point !== 13) ||
        point === 127)
    ) {
      controls += 1;
    }
  }
  if (text.includes('\0') || controls > 0) {
    throw unsupported('github_binary_content_not_readable');
  }
  return text;
}

function mapFile(
  entry: GitHubRegistryRepository,
  file: GitHubFileSnapshot,
  resolved: GitHubResolvedRepository,
): BrainRecord {
  if (file.kind === 'symlink') throw unsupported('github_symlink_not_readable');
  if (file.kind === 'submodule') {
    throw unsupported('github_submodule_not_readable');
  }
  if (file.kind === 'directory') {
    throw unsupported('github_directory_not_readable');
  }
  if (
    file.repository.toLocaleLowerCase() !== entry.normalizedRepository ||
    !safePath(file.path) ||
    !fullSha(file.blobSha) ||
    typeof file.size !== 'number' ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    !(file.content instanceof Uint8Array)
  ) {
    throw new GitHubClientFailure('unavailable');
  }
  if (
    file.size > GITHUB_MAX_CONTENT_BYTES ||
    file.content.byteLength > GITHUB_MAX_CONTENT_BYTES
  ) {
    throw unsupported('github_content_too_large');
  }
  if (file.content.byteLength !== file.size) {
    throw new GitHubClientFailure('unavailable');
  }
  const content = decodeText(file.content);
  return {
    ...baseSummary(entry, file.path, file.blobSha, resolved),
    content,
    contentType: contentType(file.path),
  };
}

function partialCompleteness(): ProviderSearchResponse['completeness'] {
  return {
    provider: 'github',
    state: 'partial',
    errorCode: 'partial_results',
  };
}

export class GitHubKnowledgeProvider implements FetchableKnowledgeProvider {
  readonly provider = 'github' as const;
  readonly #client: GitHubClient;
  readonly #registry: GitHubProjectRegistry;

  constructor(client: GitHubClient, registry: GitHubProjectRegistry) {
    const clientCandidate: unknown = client;
    const registryCandidate: unknown = registry;
    if (
      !isRecord(clientCandidate) ||
      typeof clientCandidate['listInstallationRepositories'] !== 'function' ||
      typeof clientCandidate['resolveDefaultBranch'] !== 'function' ||
      typeof clientCandidate['searchCode'] !== 'function' ||
      typeof clientCandidate['getFile'] !== 'function' ||
      !isRecord(registryCandidate) ||
      typeof registryCandidate['load'] !== 'function'
    ) {
      throw new TypeError('invalid_github_provider_configuration');
    }
    this.#client = client;
    this.#registry = registry;
  }

  async search(
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ): Promise<ProviderSearchResponse> {
    try {
      assertActive(signal);
      if (
        !safeString(request.query, GITHUB_MAX_QUERY_LENGTH) ||
        /repo\s*:/iu.test(request.query) ||
        !Number.isInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > maxSearchLimit
      ) {
        throw invalidSearch();
      }
      const access = copyAccess(request.access);
      const registry = copyRegistry(await this.#registry.load(signal));
      assertActive(signal);
      validateAccess(access, registry);
      const authorized = authorizedEntries(access, registry);
      if (authorized.length === 0) {
        return {
          records: [],
          completeness: { provider: 'github', state: 'complete' },
        };
      }

      const installed = new Set(
        (await this.#client.listInstallationRepositories(signal)).map((entry) =>
          entry.toLocaleLowerCase(),
        ),
      );
      assertActive(signal);
      const eligible = authorized.filter((entry) =>
        installed.has(entry.normalizedRepository),
      );
      let partial = eligible.length !== authorized.length;
      const records: BrainRecordSummary[] = [];
      const seen = new Set<string>();

      for (const entry of eligible) {
        try {
          const resolved = await this.#client.resolveDefaultBranch(
            entry.repository,
            signal,
          );
          assertActive(signal);
          validateResolved(resolved, entry.repository);
          const response = await this.#client.searchCode(
            {
              repository: entry.repository,
              query: request.query,
              limit: request.limit,
            },
            signal,
          );
          assertActive(signal);
          if (response.incomplete) partial = true;
          for (const result of response.results) {
            validateSearchResult(result, entry);
            if (!isGitHubKnowledgePath(result.path, entry.knowledgePaths)) {
              continue;
            }
            const id = String(
              githubProviderRecordId(entry.repository, result.path),
            );
            if (seen.has(id)) continue;
            seen.add(id);
            if (records.length < request.limit) {
              records.push(
                baseSummary(entry, result.path, result.blobSha, resolved),
              );
            }
          }
        } catch (error) {
          if (isAbortError(error)) throw cancellation();
          if (error instanceof GitHubClientFailure) {
            partial = true;
            continue;
          }
          throw error;
        }
      }

      return {
        records,
        completeness: partial
          ? partialCompleteness()
          : { provider: 'github', state: 'complete' },
      };
    } catch (error) {
      throw this.safeReadError(error);
    }
  }

  async fetch(
    request: ProviderFetchRequest,
    signal: AbortSignal,
  ): Promise<BrainRecord> {
    try {
      assertActive(signal);
      const access = copyAccess(request.access);
      const parsed = parseProviderRecordId(request.providerRecordId);
      const registry = copyRegistry(await this.#registry.load(signal));
      assertActive(signal);
      const currentTarget = registry.repositories.find(
        (candidate) =>
          candidate.normalizedRepository === parsed.normalizedRepository,
      );
      if (currentTarget === undefined) throw notFound();
      validateAccess(access, registry);
      const entry = authorizedEntries(access, registry).find(
        (candidate) =>
          candidate.normalizedRepository === parsed.normalizedRepository,
      );
      if (
        entry === undefined ||
        !isGitHubKnowledgePath(parsed.path, entry.knowledgePaths)
      ) {
        throw notFound();
      }

      const installed = await this.#client.listInstallationRepositories(signal);
      assertActive(signal);
      if (
        !installed.some(
          (candidate) =>
            candidate.toLocaleLowerCase() === entry.normalizedRepository,
        )
      ) {
        throw notFound();
      }

      const resolved = await this.#client.resolveDefaultBranch(
        entry.repository,
        signal,
      );
      assertActive(signal);
      validateResolved(resolved, entry.repository);
      const file = await this.#client.getFile(
        {
          repository: entry.repository,
          path: parsed.path,
          ref: resolved.commitSha,
        },
        signal,
      );
      assertActive(signal);
      if (file.path !== parsed.path)
        throw new GitHubClientFailure('unavailable');
      return mapFile(entry, file, resolved);
    } catch (error) {
      throw this.safeReadError(error);
    }
  }

  private safeReadError(error: unknown): unknown {
    if (isAbortError(error)) return cancellation();
    if (error instanceof DomainError) return error;
    if (error instanceof GitHubClientFailure) {
      if (error.kind === 'not_found') return notFound();
      if (error.kind === 'too_large') {
        return unsupported('github_content_too_large');
      }
      return unavailable();
    }
    return unavailable();
  }
}
