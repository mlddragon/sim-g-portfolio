import { DomainError } from '../../domain/errors.js';
import {
  loadProjectRegistry,
  type ProjectRegistry,
} from '../../domain/policy/policy-loader.js';
import {
  validateLiveProjectRegistry,
  verifyProjectRegistryLock,
  type ProjectRegistryLock,
} from '../../domain/policy/governance-validator.js';
import type { BrainScope, RecordPolicyMetadata } from '../../domain/records.js';
import type {
  GovernanceArtifactReference,
  GovernanceSource,
} from '../../ports/governance-source.js';

export const GITHUB_REGISTRY_MAX_REPOSITORIES = 100;
export const GITHUB_REGISTRY_MAX_KNOWLEDGE_PATHS = 32;
const maxKnowledgePathLength = 280;

export interface GitHubRegistryRepository {
  readonly repository: string;
  readonly normalizedRepository: string;
  readonly rootRef: string;
  readonly projectKey: string;
  readonly knowledgePaths: readonly string[];
  readonly policy: RecordPolicyMetadata;
}

export interface GitHubRegistrySnapshot {
  readonly version: string;
  readonly contentHash: string;
  readonly canonicalMarker: string;
  readonly repositories: readonly GitHubRegistryRepository[];
}

export interface GitHubProjectRegistry {
  load(signal: AbortSignal): Promise<GitHubRegistrySnapshot>;
}

export interface LiveGitHubProjectRegistryOptions {
  readonly checkedInContent: string;
  readonly lock: ProjectRegistryLock;
  readonly source: GovernanceSource;
  readonly reference: GovernanceArtifactReference;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const scopeRank: Readonly<Record<BrainScope, number>> = Object.freeze({
  family_shared: 0,
  parent_and_stewardship: 1,
  legal: 2,
  governance: 3,
  security: 4,
});

const policies: Readonly<Record<BrainScope, RecordPolicyMetadata>> =
  Object.freeze({
    family_shared: Object.freeze({
      scope: 'family_shared',
      sensitivity: 'family_shared',
      protectedClass: 'none',
    }),
    parent_and_stewardship: Object.freeze({
      scope: 'parent_and_stewardship',
      sensitivity: 'parent_and_stewardship',
      protectedClass: 'none',
    }),
    legal: Object.freeze({
      scope: 'legal',
      sensitivity: 'protected',
      protectedClass: 'legal_hold',
    }),
    governance: Object.freeze({
      scope: 'governance',
      sensitivity: 'protected',
      protectedClass: 'governance',
    }),
    security: Object.freeze({
      scope: 'security',
      sensitivity: 'protected',
      protectedClass: 'security',
    }),
  });

function cancellation(): DOMException {
  return new DOMException('Provider operation cancelled', 'AbortError');
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw cancellation();
}

function mostRestrictiveScope(scopes: readonly BrainScope[]): BrainScope {
  const selected = scopes.reduce<BrainScope | undefined>((current, scope) => {
    if (current === undefined || scopeRank[scope] > scopeRank[current]) {
      return scope;
    }
    return current;
  }, undefined);
  if (selected === undefined) {
    throw new DomainError('policy_drift', false, {
      kind: 'project_registry',
      reason: 'project_registry_scope_missing',
    });
  }
  return selected;
}

function unsupportedRegistry(reason: string): never {
  throw new DomainError('policy_drift', false, {
    kind: 'project_registry',
    reason,
  });
}

function supportedKnowledgePath(value: string): boolean {
  if (
    value.length > maxKnowledgePathLength ||
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

function projectRepositories(
  registry: ProjectRegistry,
): readonly GitHubRegistryRepository[] {
  if (registry.repositories.length > GITHUB_REGISTRY_MAX_REPOSITORIES) {
    unsupportedRegistry('project_registry_repository_limit_exceeded');
  }

  const repositories = registry.repositories.map((entry) => {
    if (
      entry.knowledgePaths.length > GITHUB_REGISTRY_MAX_KNOWLEDGE_PATHS ||
      entry.knowledgePaths.some((path) => !supportedKnowledgePath(path))
    ) {
      unsupportedRegistry('project_registry_knowledge_path_limit_exceeded');
    }
    const scope = mostRestrictiveScope(entry.scopes);
    const normalizedRepository = entry.repository.toLocaleLowerCase();
    return Object.freeze({
      repository: entry.repository,
      normalizedRepository,
      rootRef: `repo:${normalizedRepository}`,
      projectKey: entry.projectKey,
      knowledgePaths: Object.freeze([...entry.knowledgePaths]),
      policy: policies[scope],
    });
  });
  return Object.freeze(repositories);
}

function copyLock(lock: ProjectRegistryLock): ProjectRegistryLock {
  return Object.freeze({ ...lock });
}

function copyReference(
  reference: GovernanceArtifactReference,
): GovernanceArtifactReference {
  return Object.freeze({ ...reference });
}

/**
 * Joins the independently locked repository artifact to its separately loaded
 * canonical source. No repository is returned until both byte/hash and live
 * source-marker validation have succeeded.
 */
export class LiveGitHubProjectRegistry implements GitHubProjectRegistry {
  readonly #checkedInContent: string;
  readonly #lock: ProjectRegistryLock;
  readonly #source: GovernanceSource;
  readonly #reference: GovernanceArtifactReference;

  constructor(options: LiveGitHubProjectRegistryOptions) {
    const candidate: unknown = options;
    if (
      !isRecord(candidate) ||
      typeof candidate['checkedInContent'] !== 'string' ||
      !isRecord(candidate['source']) ||
      typeof candidate['source']['load'] !== 'function' ||
      !isRecord(candidate['reference']) ||
      typeof candidate['reference']['environment'] !== 'string' ||
      typeof candidate['reference']['kind'] !== 'string' ||
      typeof candidate['reference']['sourceReference'] !== 'string' ||
      !isRecord(candidate['lock'])
    ) {
      throw new TypeError('invalid_github_project_registry_configuration');
    }
    const checkedIn = loadProjectRegistry(options.checkedInContent);
    const lock = copyLock(options.lock);
    verifyProjectRegistryLock(options.checkedInContent, checkedIn, lock);

    this.#checkedInContent = options.checkedInContent;
    this.#lock = lock;
    this.#source = options.source;
    this.#reference = copyReference(options.reference);
  }

  async load(signal: AbortSignal): Promise<GitHubRegistrySnapshot> {
    assertActive(signal);
    const live = await validateLiveProjectRegistry({
      source: this.#source,
      reference: this.#reference,
      lock: this.#lock,
      signal,
    });
    assertActive(signal);

    // Recheck both copies at the point of use. This protects against mutable
    // caller objects and makes the independently checked-in snapshot explicit.
    const checkedIn = loadProjectRegistry(this.#checkedInContent);
    verifyProjectRegistryLock(this.#checkedInContent, checkedIn, this.#lock);
    const registry = loadProjectRegistry(live.content);
    verifyProjectRegistryLock(live.content, registry, this.#lock);

    return Object.freeze({
      version: registry.version,
      contentHash: live.contentHash,
      canonicalMarker: registry.canonicalMarker,
      repositories: projectRepositories(registry),
    });
  }
}

export function isGitHubKnowledgePath(
  path: string,
  configuredPaths: readonly string[],
): boolean {
  return configuredPaths.some((configured) =>
    configured.endsWith('/')
      ? path.startsWith(configured)
      : path === configured,
  );
}
