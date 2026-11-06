import { DomainError } from '../../domain/errors.js';
import {
  brainScopes,
  type BrainScope,
  type ProtectedClass,
  type RecordPolicyMetadata,
  type Sensitivity,
} from '../../domain/records.js';
import {
  canonicalNotionId,
  NotionClientFailure,
  type NotionObjectReference,
  type NotionParentReference,
  type NotionPageSnapshot,
  type NotionRetrievalClient,
} from './notion-client.js';

export interface NotionGovernedRoot {
  readonly rootRef: string;
  readonly notionObject: {
    readonly kind: 'page' | 'data_source';
    readonly id: string;
  };
  readonly displayPath: string;
  readonly policy: RecordPolicyMetadata;
}

export interface NotionAccessScope {
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidConfiguration(): TypeError {
  return new TypeError('invalid_notion_provider_configuration');
}

function rejectedAccess(): DomainError {
  return new DomainError('unauthorized', false, {
    reason: 'provider_scope_rejected',
  });
}

function cancellation(): DOMException {
  return new DOMException('Provider operation cancelled', 'AbortError');
}

function rootKey(object: NotionObjectReference): string {
  return `${object.kind}:${canonicalNotionId(object.id)}`;
}

function isScopeArray(value: unknown): value is readonly BrainScope[] {
  return (
    Array.isArray(value) &&
    value.every(
      (scope: unknown) =>
        typeof scope === 'string' && validScopes.has(scope as BrainScope),
    )
  );
}

function isBrainScope(value: unknown): value is BrainScope {
  return typeof value === 'string' && validScopes.has(value as BrainScope);
}

function isSensitivity(value: unknown): value is Sensitivity {
  return (
    typeof value === 'string' && validSensitivities.has(value as Sensitivity)
  );
}

function isProtectedClass(value: unknown): value is ProtectedClass {
  return (
    typeof value === 'string' &&
    validProtectedClasses.has(value as ProtectedClass)
  );
}

function isRootRefArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(safeString);
}

function copyRoot(candidate: unknown): NotionGovernedRoot {
  if (!isRecord(candidate)) throw invalidConfiguration();
  const object = candidate['notionObject'];
  const policy = candidate['policy'];
  if (
    !safeString(candidate['rootRef']) ||
    !safeString(candidate['displayPath']) ||
    !isRecord(object) ||
    (object['kind'] !== 'page' && object['kind'] !== 'data_source') ||
    !safeString(object['id']) ||
    !isRecord(policy) ||
    !isBrainScope(policy['scope']) ||
    !isSensitivity(policy['sensitivity']) ||
    !isProtectedClass(policy['protectedClass'])
  ) {
    throw invalidConfiguration();
  }

  return Object.freeze({
    rootRef: candidate['rootRef'],
    notionObject: Object.freeze({
      kind: object['kind'],
      id: canonicalNotionId(object['id']),
    }),
    displayPath: candidate['displayPath'],
    policy: Object.freeze({
      scope: policy['scope'],
      sensitivity: policy['sensitivity'],
      protectedClass: policy['protectedClass'],
    }),
  });
}

export class NotionScopeGuard {
  readonly #client: NotionRetrievalClient;
  readonly #rootsByObject = new Map<string, NotionGovernedRoot>();
  readonly #configuredRootRefs = new Set<string>();
  readonly #configuredScopes = new Set<BrainScope>();

  constructor(
    client: NotionRetrievalClient,
    roots: readonly NotionGovernedRoot[],
  ) {
    if (
      !Array.isArray(roots) ||
      roots.length === 0 ||
      roots.length > maxConfiguredRoots
    ) {
      throw invalidConfiguration();
    }
    this.#client = client;

    for (const candidate of roots) {
      const root = copyRoot(candidate);
      const key = rootKey(root.notionObject);
      if (
        this.#rootsByObject.has(key) ||
        this.#configuredRootRefs.has(root.rootRef)
      ) {
        throw invalidConfiguration();
      }
      this.#rootsByObject.set(key, root);
      this.#configuredRootRefs.add(root.rootRef);
      this.#configuredScopes.add(root.policy.scope);
    }
  }

  snapshotAccess(access: NotionAccessScope): NotionAccessScope {
    const candidate: unknown = access;
    if (!isRecord(candidate)) throw rejectedAccess();
    const brainScopes = candidate['brainScopes'];
    const rootRefs = candidate['rootRefs'];
    if (
      !Array.isArray(brainScopes) ||
      brainScopes.length > validScopes.size ||
      !Array.isArray(rootRefs) ||
      rootRefs.length > maxConfiguredRoots
    ) {
      throw rejectedAccess();
    }

    const scopeSnapshot: unknown[] = brainScopes.map(
      (scope: unknown): unknown => scope,
    );
    const rootSnapshot: unknown[] = rootRefs.map(
      (rootRef: unknown): unknown => rootRef,
    );
    if (!isScopeArray(scopeSnapshot) || !isRootRefArray(rootSnapshot)) {
      throw rejectedAccess();
    }
    const validatedScopes: readonly BrainScope[] = scopeSnapshot;
    const validatedRoots: readonly string[] = rootSnapshot;
    if (
      new Set(validatedScopes).size !== validatedScopes.length ||
      new Set(validatedRoots).size !== validatedRoots.length ||
      validatedScopes.some((scope) => !this.#configuredScopes.has(scope)) ||
      validatedRoots.some((rootRef) => !this.#configuredRootRefs.has(rootRef))
    ) {
      throw rejectedAccess();
    }

    return Object.freeze({
      brainScopes: Object.freeze(validatedScopes),
      rootRefs: Object.freeze(validatedRoots),
    });
  }

  assertAccess(access: NotionAccessScope): void {
    this.snapshotAccess(access);
  }

  async resolveAuthorizedRoot(
    page: NotionPageSnapshot,
    access: NotionAccessScope,
    signal: AbortSignal,
  ): Promise<NotionGovernedRoot | undefined> {
    if (signal.aborted) throw cancellation();
    const authorizedAccess = this.snapshotAccess(access);
    if (page.inTrash) return undefined;

    const visited = new Set<string>();
    let current: NotionObjectReference = { kind: 'page', id: page.id };
    let parent: NotionParentReference | undefined = page.parent;

    for (let depth = 0; depth < maxAncestryDepth; depth += 1) {
      const key = rootKey(current);
      if (visited.has(key)) throw new NotionClientFailure('unavailable');
      visited.add(key);

      const configuredRoot = this.#rootsByObject.get(key);
      if (configuredRoot !== undefined) {
        return authorizedAccess.rootRefs.includes(configuredRoot.rootRef) &&
          authorizedAccess.brainScopes.includes(configuredRoot.policy.scope)
          ? configuredRoot
          : undefined;
      }

      parent ??= await this.#client.retrieveParent(current, signal);
      if (parent.kind === 'terminal') return undefined;
      current = parent;
      parent = undefined;
    }

    throw new NotionClientFailure('unavailable');
  }
}
