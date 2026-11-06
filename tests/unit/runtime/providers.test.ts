import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DriveKnowledgeProvider } from '../../../src/adapters/drive/drive-knowledge-provider.js';
import {
  DriveClientFailure,
  type DriveClient,
  type DriveFileSnapshot,
} from '../../../src/adapters/drive/drive-client.js';
import { UnregisteredGitHubProvider } from '../../../src/adapters/github/unregistered-github-provider.js';
import {
  NotionClientFailure,
  NOTION_API_VERSION,
  type NotionParentReference,
  type NotionRetrievalClient,
} from '../../../src/adapters/notion/notion-client.js';
import { NotionFamilyInboxProjection } from '../../../src/adapters/notion/notion-family-inbox.js';
import { NotionMutableKnowledgeProvider } from '../../../src/adapters/notion/notion-mutations.js';
import {
  parseEnvironment,
  type EnvironmentConfig,
} from '../../../src/config/environment.js';
import { DomainError } from '../../../src/domain/errors.js';
import { loadExecutablePolicy } from '../../../src/domain/policy/policy-loader.js';
import type { SecretProvider } from '../../../src/ports/secret-provider.js';
import {
  createRuntimeProviders,
  driveGovernedRoots,
  notionGovernedRoots,
} from '../../../src/runtime/providers.js';
import { syntheticConfigDocument } from '../../support/environment-fixtures.js';

const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);
const token = 'synthetic-notion-integration-token';
const sharedId = '30000000-0000-4000-8000-000000000001';
const legalId = '30000000-0000-4000-8000-000000000002';
const live = () => new AbortController().signal;

/** The parts of the synthetic document these tests change. */
interface SyntheticDocument {
  secrets: { bindings: Record<string, string> };
  providers: {
    notion: { credential: { kind: string } };
    drive: { credential: { kind: string }; roots: unknown[] };
  };
}

function config(
  mutate: (document: SyntheticDocument) => void = () => undefined,
) {
  const document = syntheticConfigDocument() as unknown as SyntheticDocument;
  mutate(document);
  return parseEnvironment(document);
}

function secrets(value = token): SecretProvider & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    get: (reference) => {
      requested.push(`${reference.environment}:${reference.name}`);
      return Promise.resolve({ value, version: 'environment' });
    },
  };
}

const rejecting = () => Promise.reject(new Error('unused synthetic SDK call'));

function notionClients(
  parents: Record<string, NotionParentReference | Error | Error[]>,
  lookups: string[] = [],
) {
  const tokens: string[] = [];
  const retrieval = {
    searchPages: rejecting,
    retrievePage: rejecting,
    listBlockChildren: rejecting,
    retrieveParent: (object: { id: string }) => {
      lookups.push(object.id);
      const next = parents[object.id];
      if (Array.isArray(next)) {
        const failure = next.shift();
        if (failure !== undefined) return Promise.reject(failure);
        return Promise.resolve({ kind: 'terminal' } as const);
      }
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? { kind: 'terminal' });
    },
  } as unknown as NotionRetrievalClient;
  const pages = {
    create: rejecting,
    retrieve: rejecting,
    update: rejecting,
    retrieveMarkdown: rejecting,
    updateMarkdown: rejecting,
  };
  return {
    tokens,
    factory: (auth: string) => {
      tokens.push(auth);
      return {
        retrieval,
        mutation: {
          apiVersion: NOTION_API_VERSION,
          pages,
          dataSources: { query: rejecting },
        },
        inbox: {
          apiVersion: NOTION_API_VERSION,
          pages: { create: rejecting, retrieve: rejecting, update: rejecting },
          dataSources: { query: rejecting },
        },
      } as never;
    },
  };
}

function driveFolder(
  id: string,
  parents: readonly string[],
): DriveFileSnapshot {
  return {
    id,
    name: id,
    mimeType: 'application/vnd.google-apps.folder',
    parents,
    sharedDriveId: 'shared-drive-synthetic',
    createdTime: '2042-01-01T00:00:00.000Z',
    modifiedTime: '2042-01-01T00:00:00.000Z',
    version: '1',
    trashed: false,
    appProperties: {},
  };
}

function driveClient(folders: readonly DriveFileSnapshot[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return {
    getFile: (id: string) => {
      const found = byId.get(id);
      return found === undefined
        ? Promise.reject(new DriveClientFailure('not_found'))
        : Promise.resolve(found);
    },
  } as unknown as DriveClient;
}

async function build(
  environment: EnvironmentConfig = config(),
  options: {
    readonly notionParents?: Record<
      string,
      NotionParentReference | Error | Error[]
    >;
    readonly notionLookups?: string[];
    readonly driveFolders?: readonly DriveFileSnapshot[];
    readonly secretProvider?: SecretProvider;
  } = {},
) {
  const notion = notionClients(
    options.notionParents ?? {},
    options.notionLookups,
  );
  const result = await createRuntimeProviders({
    config: environment,
    policy,
    secrets: options.secretProvider ?? secrets(),
    signal: live(),
    clients: {
      notion: notion.factory,
      drive: () =>
        driveClient(
          options.driveFolders ?? [driveFolder('folder-family-shared', [])],
        ),
    },
  });
  return { ...result, notion };
}

describe('governed roots from the policy', () => {
  it('derives each root policy from its container, tightening only to legal hold', () => {
    expect(notionGovernedRoots(config(), policy)).toEqual([
      {
        rootRef: 'notion.family_shared',
        notionObject: { kind: 'data_source', id: sharedId },
        displayPath: 'Family Shared',
        policy: policy.containerPolicies.family_shared,
      },
      {
        rootRef: 'notion.protected',
        notionObject: { kind: 'page', id: legalId },
        displayPath: 'Family Shared / Legal',
        policy: {
          ...policy.containerPolicies.protected,
          protectedClass: 'legal_hold',
        },
      },
    ]);
    expect(driveGovernedRoots(config(), policy)).toEqual([
      {
        rootRef: 'drive.family_shared',
        folderId: 'folder-family-shared',
        sharedDriveId: 'shared-drive-synthetic',
        displayPath: 'Family Shared',
        policy: policy.containerPolicies.family_shared,
      },
    ]);
  });
});

describe('Notion ID canonical form', () => {
  it('canonicalises configured Notion IDs to dashed lower case', () => {
    const parsed = config((document) => {
      const notion = document.providers.notion as unknown as {
        roots: { object: { id: string } }[];
        familyInbox: { dataSourceId: string };
      };
      const [shared, legal] = notion.roots;
      if (shared === undefined || legal === undefined)
        throw new Error('fixture');
      shared.object.id = sharedId.toUpperCase();
      legal.object.id = legalId.replaceAll('-', '').toUpperCase();
      notion.familyInbox.dataSourceId = '30000000000040008000000000000009';
    });

    expect(parsed.providers.notion.roots.map((root) => root.object.id)).toEqual(
      [sharedId, legalId],
    );
    expect(parsed.providers.notion.familyInbox.dataSourceId).toBe(
      '30000000-0000-4000-8000-000000000009',
    );
    expect(notionGovernedRoots(parsed, policy)[1]?.notionObject.id).toBe(
      legalId,
    );
  });
});

describe('createRuntimeProviders', () => {
  it('builds the governed adapters and registers only configured containers', async () => {
    const { providers, surfaces, approvalProjection } = await build();

    expect(providers.notion).toBeInstanceOf(NotionMutableKnowledgeProvider);
    expect(providers.drive).toBeInstanceOf(DriveKnowledgeProvider);
    expect(providers.github).toBeInstanceOf(UnregisteredGitHubProvider);
    expect(approvalProjection).toBeInstanceOf(NotionFamilyInboxProjection);
    expect(surfaces).toEqual([
      expect.objectContaining({
        provider: 'notion',
        containerKey: 'notion.family_shared',
        scope: 'family_shared',
      }),
      expect.objectContaining({
        provider: 'notion',
        containerKey: 'notion.protected',
        scope: 'legal',
        protectedClass: 'legal_hold',
      }),
      expect.objectContaining({
        provider: 'drive',
        containerKey: 'drive.family_shared',
        scope: 'family_shared',
      }),
    ]);
  });

  it('resolves the Notion token only through the configured secret handle', async () => {
    const provider = secrets();
    const { notion } = await build(config(), { secretProvider: provider });

    expect(provider.requested).toEqual(['development:notion_development']);
    expect(notion.tokens).toEqual([token]);
  });

  it('propagates a secret failure without building anything', async () => {
    const failing: SecretProvider = {
      get: () =>
        Promise.reject(
          new DomainError('not_found', false, {
            reason: 'secret_not_configured',
          }),
        ),
    };

    await expect(
      build(config(), { secretProvider: failing }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it.each([
    [
      'a Notion credential that is not a secret',
      (document: SyntheticDocument) => {
        document.providers.notion.credential.kind = 'workload_identity';
        const { notion_development: _notion, ...rest } =
          document.secrets.bindings;
        document.secrets.bindings = rest;
      },
    ],
    [
      'a Drive credential that is not a workload identity',
      (document: SyntheticDocument) => {
        document.providers.drive.credential.kind = 'secret';
        document.secrets.bindings = {
          ...document.secrets.bindings,
          drive_development: 'DRIVE_KEY',
        };
      },
    ],
  ])('refuses %s', async (_, mutate) => {
    await expect(build(config(mutate))).rejects.toThrow(
      'invalid_provider_configuration',
    );
  });

  it('refuses to build Drive without its workload identity auth', async () => {
    await expect(
      createRuntimeProviders({
        config: config(),
        policy,
        secrets: secrets(),
        signal: live(),
        clients: { notion: notionClients({}).factory },
      }),
    ).rejects.toThrow('invalid_provider_configuration');
  });

  it('accepts a protected Notion root nested inside Family Shared', async () => {
    await expect(
      build(config(), {
        notionParents: { [legalId]: { kind: 'data_source', id: sharedId } },
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a Family Shared Notion root nested inside a protected root', async () => {
    await expect(
      build(config(), {
        notionParents: { [sharedId]: { kind: 'page', id: legalId } },
      }),
    ).rejects.toThrow('invalid_root_nesting');
  });

  it('fails closed when a root ancestor is not visible to the integration', async () => {
    await expect(
      build(config(), {
        notionParents: {
          [legalId]: {
            kind: 'page',
            id: '30000000-0000-4000-8000-0000000000aa',
          },
          '30000000-0000-4000-8000-0000000000aa': new NotionClientFailure(
            'not_found',
          ),
        },
      }),
    ).rejects.toThrow('root_ancestry_unavailable');
  });

  it('reports a missing Notion root itself as a configuration error', async () => {
    await expect(
      build(config(), {
        notionParents: { [legalId]: new NotionClientFailure('not_found') },
      }),
    ).rejects.toThrow('invalid_provider_configuration');
  });

  it('retries a transient ancestry failure a bounded number of times', async () => {
    await expect(
      build(config(), {
        notionParents: { [legalId]: [new NotionClientFailure('unavailable')] },
      }),
    ).resolves.toBeDefined();
    await expect(
      build(config(), {
        notionParents: {
          [legalId]: [1, 2, 3].map(
            () => new NotionClientFailure('unavailable'),
          ),
        },
      }),
    ).rejects.toThrow(NotionClientFailure);
  });

  it('stops walking at the first configured ancestor', async () => {
    const lookups: string[] = [];
    await build(config(), {
      notionLookups: lookups,
      notionParents: {
        [legalId]: { kind: 'data_source', id: sharedId },
        [sharedId]: {
          kind: 'page',
          id: '30000000-0000-4000-8000-0000000000bb',
        },
      },
    });

    // The protected root's walk ends at the Family Shared root, whose own walk
    // covers everything above it.
    expect(lookups.filter((id) => id === legalId)).toHaveLength(1);
    expect(lookups.filter((id) => id === sharedId)).toHaveLength(1);
  });

  it('refuses a Drive root on another shared drive than configured', async () => {
    await expect(
      build(config(), {
        driveFolders: [
          {
            ...driveFolder('folder-family-shared', []),
            sharedDriveId: 'other-drive',
          },
        ],
      }),
    ).rejects.toThrow('invalid_provider_configuration');
  });

  it('refuses a less restrictive Drive root nested inside a more restrictive one', async () => {
    const nested = config((document) => {
      document.providers.drive.roots.push({
        environment: 'development',
        container: 'parent_and_stewardship',
        folderId: 'folder-parents',
        sharedDriveId: 'shared-drive-synthetic',
        displayPath: 'Parents',
      });
    });

    await expect(
      build(nested, {
        driveFolders: [
          driveFolder('folder-parents', []),
          driveFolder('folder-family-shared', ['folder-parents']),
        ],
      }),
    ).rejects.toThrow('invalid_root_nesting');
    await expect(
      build(nested, {
        driveFolders: [
          driveFolder('folder-family-shared', []),
          driveFolder('folder-parents', ['folder-family-shared']),
        ],
      }),
    ).resolves.toBeDefined();
  });
});
