import { DomainError } from '../../domain/errors.js';
import {
  brainScopes,
  type BrainScope,
  type ProtectedClass,
  type RecordPolicyMetadata,
  type Sensitivity,
} from '../../domain/records.js';
import {
  DriveClientFailure,
  type DriveClient,
  type DriveFileSnapshot,
} from './drive-client.js';

export interface DriveGovernedRoot {
  readonly rootRef: string;
  readonly folderId: string;
  readonly sharedDriveId?: string;
  readonly displayPath: string;
  readonly policy: RecordPolicyMetadata;
}

export interface DriveAccessScope {
  readonly brainScopes: readonly BrainScope[];
  readonly rootRefs: readonly string[];
}

const validScopes = new Set<BrainScope>(brainScopes);
const validSensitivities = new Set<Sensitivity>([
  'family_shared',
  'parent_and_stewardship',
  'restricted',
  'protected',
]);
const validProtectedClasses = new Set<ProtectedClass>([
  'none',
  'protected',
  'legal_hold',
  'governance',
  'security',
]);
const maxConfiguredRoots = 32;
const maxAncestryDepth = 64;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeString(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
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

function invalidConfiguration(): TypeError {
  return new TypeError('invalid_drive_provider_configuration');
}

function rejectedAccess(): DomainError {
  return new DomainError('unauthorized', false, {
    reason: 'provider_scope_rejected',
  });
}

function cancellation(): DOMException {
  return new DOMException('Provider operation cancelled', 'AbortError');
}

function copyRoot(candidate: unknown): DriveGovernedRoot {
  if (!isRecord(candidate)) throw invalidConfiguration();
  const policy = candidate['policy'];
  if (
    !safeString(candidate['rootRef']) ||
    !safeString(candidate['folderId']) ||
    (candidate['sharedDriveId'] !== undefined &&
      !safeString(candidate['sharedDriveId'])) ||
    !safeString(candidate['displayPath']) ||
    !isRecord(policy) ||
    typeof policy['scope'] !== 'string' ||
    !validScopes.has(policy['scope'] as BrainScope) ||
    typeof policy['sensitivity'] !== 'string' ||
    !validSensitivities.has(policy['sensitivity'] as Sensitivity) ||
    typeof policy['protectedClass'] !== 'string' ||
    !validProtectedClasses.has(policy['protectedClass'] as ProtectedClass)
  ) {
    throw invalidConfiguration();
  }

  return Object.freeze({
    rootRef: candidate['rootRef'],
    folderId: candidate['folderId'],
    ...(typeof candidate['sharedDriveId'] === 'string'
      ? { sharedDriveId: candidate['sharedDriveId'] }
      : {}),
    displayPath: candidate['displayPath'],
    policy: Object.freeze({
      scope: policy['scope'] as BrainScope,
      sensitivity: policy['sensitivity'] as Sensitivity,
      protectedClass: policy['protectedClass'] as ProtectedClass,
    }),
  });
}

export class DriveRootGuard {
  readonly #client: Pick<DriveClient, 'getFile'>;
  readonly #roots: readonly DriveGovernedRoot[];
  readonly #rootsByFolderId = new Map<string, DriveGovernedRoot>();
  readonly #configuredRootRefs = new Set<string>();
  readonly #configuredScopes = new Set<BrainScope>();

  constructor(
    client: Pick<DriveClient, 'getFile'>,
    roots: readonly DriveGovernedRoot[],
  ) {
    if (
      !Array.isArray(roots) ||
      roots.length === 0 ||
      roots.length > maxConfiguredRoots
    ) {
      throw invalidConfiguration();
    }
    this.#client = client;
    const copies: DriveGovernedRoot[] = [];
    for (const candidate of roots) {
      const root = copyRoot(candidate);
      if (
        this.#rootsByFolderId.has(root.folderId) ||
        this.#configuredRootRefs.has(root.rootRef)
      ) {
        throw invalidConfiguration();
      }
      copies.push(root);
      this.#rootsByFolderId.set(root.folderId, root);
      this.#configuredRootRefs.add(root.rootRef);
      this.#configuredScopes.add(root.policy.scope);
    }
    this.#roots = Object.freeze(copies);
  }

  snapshotAccess(access: DriveAccessScope): DriveAccessScope {
    const candidate: unknown = access;
    if (!isRecord(candidate)) throw rejectedAccess();
    const rawScopes = candidate['brainScopes'];
    const rawRoots = candidate['rootRefs'];
    if (
      !Array.isArray(rawScopes) ||
      rawScopes.length > validScopes.size ||
      !Array.isArray(rawRoots) ||
      rawRoots.length > maxConfiguredRoots
    ) {
      throw rejectedAccess();
    }
    const scopes = rawScopes.map((value: unknown) => value);
    const roots = rawRoots.map((value: unknown) => value);
    if (
      !scopes.every(
        (scope: unknown): scope is BrainScope =>
          typeof scope === 'string' && validScopes.has(scope as BrainScope),
      ) ||
      !roots.every((root: unknown): root is string => safeString(root)) ||
      new Set(scopes).size !== scopes.length ||
      new Set(roots).size !== roots.length ||
      scopes.some((scope) => !this.#configuredScopes.has(scope)) ||
      roots.some((root) => !this.#configuredRootRefs.has(root))
    ) {
      throw rejectedAccess();
    }
    return Object.freeze({
      brainScopes: Object.freeze(scopes),
      rootRefs: Object.freeze(roots),
    });
  }

  authorizedRoots(access: DriveAccessScope): readonly DriveGovernedRoot[] {
    const snapshot = this.snapshotAccess(access);
    return Object.freeze(
      this.#roots.filter(
        (root) =>
          snapshot.rootRefs.includes(root.rootRef) &&
          snapshot.brainScopes.includes(root.policy.scope),
      ),
    );
  }

  rootForCreate(
    rootRef: string,
    access: DriveAccessScope,
  ): DriveGovernedRoot | undefined {
    return this.authorizedRoots(access).find(
      (root) => root.rootRef === rootRef,
    );
  }

  async resolveAuthorizedRoot(
    file: DriveFileSnapshot,
    access: DriveAccessScope,
    signal: AbortSignal,
    options: { readonly allowTrashed?: boolean } = {},
  ): Promise<DriveGovernedRoot | undefined> {
    if (signal.aborted) throw cancellation();
    const snapshot = this.snapshotAccess(access);
    if (file.trashed && options.allowTrashed !== true) return undefined;

    const initialDrive = file.sharedDriveId;
    const visited = new Set<string>();
    let currentId = file.id;
    let parents = file.parents;
    let currentTrashed = file.trashed && options.allowTrashed !== true;

    for (let depth = 0; depth < maxAncestryDepth; depth += 1) {
      if (visited.has(currentId)) {
        throw new DriveClientFailure('unavailable');
      }
      visited.add(currentId);

      const configuredRoot = this.#rootsByFolderId.get(currentId);
      if (configuredRoot !== undefined) {
        if (configuredRoot.sharedDriveId !== initialDrive) return undefined;
        return snapshot.rootRefs.includes(configuredRoot.rootRef) &&
          snapshot.brainScopes.includes(configuredRoot.policy.scope)
          ? configuredRoot
          : undefined;
      }

      if (currentTrashed || parents.length === 0) return undefined;
      if (parents.length !== 1) throw new DriveClientFailure('unavailable');
      const parentId = parents[0];
      if (parentId === undefined) throw new DriveClientFailure('unavailable');
      currentId = parentId;

      const parentRoot = this.#rootsByFolderId.get(currentId);
      if (parentRoot !== undefined) continue;

      let parent: DriveFileSnapshot;
      try {
        parent = await this.#client.getFile(currentId, signal);
      } catch (error) {
        if (error instanceof DriveClientFailure && error.kind === 'not_found') {
          return undefined;
        }
        throw error;
      }
      if (parent.id !== currentId || parent.sharedDriveId !== initialDrive) {
        throw new DriveClientFailure('unavailable');
      }
      parents = parent.parents;
      currentTrashed = parent.trashed;
    }

    throw new DriveClientFailure('unavailable');
  }
}
