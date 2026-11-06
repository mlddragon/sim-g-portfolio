import {
  createOfficialDriveSdkClient,
  DriveClientFailure,
  OfficialDriveClient,
  type CreateOfficialDriveSdkClientOptions,
  type DriveClient,
} from '../adapters/drive/drive-client.js';
import { DriveKnowledgeProvider } from '../adapters/drive/drive-knowledge-provider.js';
import type { DriveGovernedRoot } from '../adapters/drive/drive-root-guard.js';
import { UnregisteredGitHubProvider } from '../adapters/github/unregistered-github-provider.js';
import {
  canonicalNotionId,
  createOfficialNotionFamilyInboxSdkClient,
  createOfficialNotionMutationSdkClient,
  createOfficialNotionSdkClient,
  NotionClientFailure,
  OfficialNotionRetrievalClient,
  type NotionFamilyInboxSdkClient,
  type NotionMutationSdkClient,
  type NotionObjectReference,
  type NotionParentReference,
  type NotionRetrievalClient,
} from '../adapters/notion/notion-client.js';
import { NotionFamilyInboxProjection } from '../adapters/notion/notion-family-inbox.js';
import { NotionMutableKnowledgeProvider } from '../adapters/notion/notion-mutations.js';
import type { NotionGovernedRoot } from '../adapters/notion/notion-scope-guard.js';
import type { GatewayPorts } from '../bootstrap.js';
import type { EnvironmentConfig } from '../config/environment.js';
import type { RegisteredKnowledgeSurface } from '../domain/authorization/authorization-engine.js';
import { containerRecordPolicy } from '../domain/policy/container-policy.js';
import type { ExecutablePolicy } from '../domain/policy/policy-loader.js';
import type { RecordPolicyMetadata } from '../domain/records.js';
import type { ApprovalProjectionPort } from '../ports/approval-projection.js';
import type { SecretProvider } from '../ports/secret-provider.js';

export interface NotionClients {
  readonly retrieval: NotionRetrievalClient;
  readonly mutation: NotionMutationSdkClient;
  readonly inbox: NotionFamilyInboxSdkClient;
}

export interface RuntimeProviderOptions {
  readonly config: EnvironmentConfig;
  readonly policy: ExecutablePolicy;
  readonly secrets: SecretProvider;
  readonly signal: AbortSignal;
  /** The Drive machine identity's workload credentials (built by the entry point). */
  readonly driveAuth?: CreateOfficialDriveSdkClientOptions['auth'];
  /** Test seams; production builds the official clients. */
  readonly clients?: {
    readonly notion?: (token: string) => NotionClients;
    readonly drive?: () => DriveClient;
  };
}

export interface RuntimeProviders {
  readonly providers: GatewayPorts['providers'];
  readonly surfaces: readonly RegisteredKnowledgeSurface[];
  readonly approvalProjection: ApprovalProjectionPort;
}

const maximumAncestryDepth = 64;

function invalidProviderConfiguration(): TypeError {
  return new TypeError('invalid_provider_configuration');
}

function invalidRootNesting(): TypeError {
  return new TypeError('invalid_root_nesting');
}

/** The root policy from the executable policy; legal hold only tightens it. */
function rootPolicy(
  policy: ExecutablePolicy,
  rootRef: string,
  legalHold: boolean,
): RecordPolicyMetadata {
  const base = containerRecordPolicy(policy, rootRef);
  if (base === undefined) throw invalidProviderConfiguration();
  return legalHold ? { ...base, protectedClass: 'legal_hold' } : base;
}

export function notionGovernedRoots(
  config: EnvironmentConfig,
  policy: ExecutablePolicy,
): readonly NotionGovernedRoot[] {
  return config.providers.notion.roots.map((root) => {
    const rootRef = policy.routing.containers.notion[root.container];
    return {
      rootRef,
      notionObject: { kind: root.object.kind, id: root.object.id },
      displayPath: root.displayPath,
      policy: rootPolicy(policy, rootRef, root.legalHold === true),
    };
  });
}

export function driveGovernedRoots(
  config: EnvironmentConfig,
  policy: ExecutablePolicy,
): readonly DriveGovernedRoot[] {
  return config.providers.drive.roots.map((root) => {
    const rootRef = policy.routing.containers.drive[root.container];
    return {
      rootRef,
      folderId: root.folderId,
      ...(root.sharedDriveId === undefined
        ? {}
        : { sharedDriveId: root.sharedDriveId }),
      displayPath: root.displayPath,
      policy: rootPolicy(policy, rootRef, root.legalHold === true),
    };
  });
}

/** Higher is more restrictive. */
function restrictiveness(policy: RecordPolicyMetadata): number {
  if (policy.protectedClass === 'legal_hold') return 3;
  if (policy.scope === 'legal' || policy.protectedClass !== 'none') return 2;
  if (policy.scope === 'parent_and_stewardship') return 1;
  return 0;
}

const maximumAttempts = 3;

function ancestryUnavailable(): TypeError {
  return new TypeError('root_ancestry_unavailable');
}

/** Retries only a transient provider failure, a bounded number of times. */
async function withRetry<Value>(
  run: () => Promise<Value>,
  transient: (error: unknown) => boolean,
  signal: AbortSignal,
): Promise<Value> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (signal.aborted || attempt >= maximumAttempts || !transient(error)) {
        throw error;
      }
    }
  }
}

/**
 * The guards resolve a record to its nearest configured root, so a less
 * restrictive root inside a more restrictive one would expose that subtree.
 * Startup walks each root's ancestry and refuses such nesting. A walk stops at
 * the first configured ancestor, whose own walk covers everything above it.
 * An ancestor the integration cannot see fails closed rather than being
 * assumed to be the top of the tree.
 */
async function verifyNotionNesting(
  roots: readonly NotionGovernedRoot[],
  client: NotionRetrievalClient,
  signal: AbortSignal,
): Promise<void> {
  const byId = new Map(
    roots.map((root) => [canonicalNotionId(root.notionObject.id), root]),
  );
  const transient = (error: unknown) =>
    error instanceof NotionClientFailure && error.kind === 'unavailable';
  for (const root of roots) {
    let current: NotionObjectReference = root.notionObject;
    for (let depth = 0; ; depth += 1) {
      if (depth >= maximumAncestryDepth) throw invalidRootNesting();
      let parent: NotionParentReference;
      try {
        parent = await withRetry(
          () => client.retrieveParent(current, signal),
          transient,
          signal,
        );
      } catch (error) {
        if (
          error instanceof NotionClientFailure &&
          error.kind === 'not_found'
        ) {
          // The root itself missing is a configuration error; an unseen
          // ancestor fails closed as unavailable ancestry.
          throw depth === 0
            ? invalidProviderConfiguration()
            : ancestryUnavailable();
        }
        throw error;
      }
      if (parent.kind === 'terminal') break;
      const ancestor = byId.get(canonicalNotionId(parent.id));
      if (ancestor !== undefined) {
        if (restrictiveness(ancestor.policy) > restrictiveness(root.policy)) {
          throw invalidRootNesting();
        }
        break;
      }
      current = parent;
    }
  }
}

async function verifyDriveNesting(
  roots: readonly DriveGovernedRoot[],
  client: DriveClient,
  signal: AbortSignal,
): Promise<void> {
  const byId = new Map(roots.map((root) => [root.folderId, root]));
  const transient = (error: unknown) =>
    error instanceof DriveClientFailure && error.kind === 'unavailable';
  const getFolder = async (id: string, ancestor: boolean) => {
    try {
      return await withRetry(
        () => client.getFile(id, signal),
        transient,
        signal,
      );
    } catch (error) {
      if (error instanceof DriveClientFailure && error.kind === 'not_found') {
        throw ancestor ? ancestryUnavailable() : invalidProviderConfiguration();
      }
      throw error;
    }
  };
  for (const root of roots) {
    let folder = await getFolder(root.folderId, false);
    // The guard requires every record to stay on the root's shared drive.
    if (folder.sharedDriveId !== root.sharedDriveId) {
      throw invalidProviderConfiguration();
    }
    for (let depth = 0; ; depth += 1) {
      if (depth >= maximumAncestryDepth || folder.parents.length > 1) {
        throw invalidRootNesting();
      }
      const parentId = folder.parents[0];
      if (parentId === undefined) break;
      const ancestor = byId.get(parentId);
      if (ancestor !== undefined) {
        if (restrictiveness(ancestor.policy) > restrictiveness(root.policy)) {
          throw invalidRootNesting();
        }
        break;
      }
      folder = await getFolder(parentId, true);
    }
  }
}

function defaultNotionClients(token: string): NotionClients {
  return {
    retrieval: new OfficialNotionRetrievalClient(
      createOfficialNotionSdkClient({ auth: token }),
    ),
    mutation: createOfficialNotionMutationSdkClient({ auth: token }),
    inbox: createOfficialNotionFamilyInboxSdkClient({ auth: token }),
  };
}

/**
 * Builds the governed provider adapters from configuration. Root policy comes
 * only from the executable policy, the Notion token only from the configured
 * secret handle, and Drive authenticates as its workload identity. GitHub is
 * visibly unavailable until the Project Registry is bound.
 */
export async function createRuntimeProviders(
  options: RuntimeProviderOptions,
): Promise<RuntimeProviders> {
  const { config, policy, signal } = options;
  const { notion, drive } = config.providers;
  if (
    notion.credential.kind !== 'secret' ||
    drive.credential.kind !== 'workload_identity'
  ) {
    throw invalidProviderConfiguration();
  }
  const driveAuth = options.driveAuth;
  const createDriveClient =
    options.clients?.drive ??
    (driveAuth === undefined
      ? undefined
      : () =>
          new OfficialDriveClient(
            createOfficialDriveSdkClient({ auth: driveAuth }),
          ));
  if (createDriveClient === undefined) throw invalidProviderConfiguration();

  const notionRoots = notionGovernedRoots(config, policy);
  const driveRoots = driveGovernedRoots(config, policy);

  const { value: token } = await options.secrets.get(
    { environment: config.environment, name: notion.credential.name },
    signal,
  );
  const notionClients = (options.clients?.notion ?? defaultNotionClients)(
    token,
  );
  const driveClient = createDriveClient();

  await verifyNotionNesting(notionRoots, notionClients.retrieval, signal);
  await verifyDriveNesting(driveRoots, driveClient, signal);

  const mutationTargets = config.providers.notion.roots.flatMap((root) =>
    root.mutationPropertyIds === undefined
      ? []
      : [
          {
            rootRef: policy.routing.containers.notion[root.container],
            propertyIds: root.mutationPropertyIds,
          },
        ],
  );
  const surfaces: RegisteredKnowledgeSurface[] = [
    ...notionRoots.map((root) => ({
      provider: 'notion' as const,
      containerKey: root.rootRef,
      scope: root.policy.scope,
      protectedClass: root.policy.protectedClass,
    })),
    ...driveRoots.map((root) => ({
      provider: 'drive' as const,
      containerKey: root.rootRef,
      scope: root.policy.scope,
      protectedClass: root.policy.protectedClass,
    })),
  ];
  const { environment: _environment, ...inbox } = notion.familyInbox;

  return {
    providers: {
      notion: new NotionMutableKnowledgeProvider(
        notionClients.retrieval,
        notionClients.mutation,
        { roots: notionRoots, mutationTargets },
      ),
      drive: new DriveKnowledgeProvider(driveClient, { roots: driveRoots }),
      github: new UnregisteredGitHubProvider(),
    },
    surfaces,
    approvalProjection: new NotionFamilyInboxProjection(
      notionClients.inbox,
      inbox,
    ),
  };
}
