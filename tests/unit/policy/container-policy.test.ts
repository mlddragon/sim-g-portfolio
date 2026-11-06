import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { UnregisteredGitHubProvider } from '../../../src/adapters/github/unregistered-github-provider.js';
import type {
  NotionParentReference,
  NotionRetrievalClient,
} from '../../../src/adapters/notion/notion-client.js';
import { NotionScopeGuard } from '../../../src/adapters/notion/notion-scope-guard.js';
import {
  DriveClientFailure,
  type DriveClient,
  type DriveFileSnapshot,
} from '../../../src/adapters/drive/drive-client.js';
import { DriveRootGuard } from '../../../src/adapters/drive/drive-root-guard.js';
import {
  containerRecordPolicy,
  registeredSurfaces,
} from '../../../src/domain/policy/container-policy.js';
import { loadExecutablePolicy } from '../../../src/domain/policy/policy-loader.js';
import { providerRecordId } from '../../../src/domain/identifiers.js';
import { BrainQueryService } from '../../../src/application/brain-query-service.js';
import { AuthorizationEngine } from '../../../src/domain/authorization/authorization-engine.js';
import { FakeFetchableKnowledgeProvider } from '../../support/fake-knowledge-providers.js';
import {
  brainReadContext,
  brainReadNow,
  brainReadPrincipal,
  brainReadRecord,
  brainReadSummary,
} from '../../support/brain-read-fixtures.js';
import { SyntheticMutationStore } from '../../support/synthetic-mutation-store.js';

const policyText = readFileSync(
  new URL('../../../config/policy/family-brain-v1.yaml', import.meta.url),
  'utf8',
);
const policy = loadExecutablePolicy(policyText);
const live = () => new AbortController().signal;

describe('owner-approved container record policy (2026-10-24)', () => {
  it('assigns exactly the approved scope, sensitivity and protection', () => {
    expect(policy.version).toBe('family-brain-v1.2.0');
    expect(policy.containerPolicies).toEqual({
      family_shared: {
        scope: 'family_shared',
        sensitivity: 'family_shared',
        protectedClass: 'none',
      },
      parent_and_stewardship: {
        scope: 'parent_and_stewardship',
        sensitivity: 'parent_and_stewardship',
        protectedClass: 'none',
      },
      protected: {
        scope: 'legal',
        sensitivity: 'protected',
        protectedClass: 'protected',
      },
    });
  });

  it.each([
    [
      'a registered generic restricted container',
      policyText.replace(
        'containerPolicies:\n',
        'containerPolicies:\n  restricted:\n    scope: parent_and_stewardship\n    sensitivity: restricted\n    protectedClass: protected\n',
      ),
    ],
    [
      'a downgraded protected container',
      policyText.replace(
        '  protected:\n    scope: legal',
        '  protected:\n    scope: family_shared',
      ),
    ],
    [
      'an unprotected protected container',
      policyText.replace(
        '    sensitivity: protected\n    protectedClass: protected',
        '    sensitivity: protected\n    protectedClass: none',
      ),
    ],
  ])('refuses %s', (_, text) => {
    expect(text).not.toBe(policyText);
    expect(() => loadExecutablePolicy(text)).toThrow();
  });

  it('keeps legal access for Operator and Steward and none for Participant', () => {
    expect(policy.roleScopes.owner_operator).toContain('legal');
    expect(policy.roleScopes.parent_steward).toContain('legal');
    expect(policy.roleScopes.family_participant).toEqual(['family_shared']);
    expect(policy.legalHoldEvidence).toBe('immutable');
  });

  it('registers surfaces only for approved containers, never generic restricted', () => {
    expect(
      registeredSurfaces(policy).map(({ provider, containerKey, scope }) => ({
        provider,
        containerKey,
        scope,
      })),
    ).toEqual([
      {
        provider: 'notion',
        containerKey: 'notion.family_shared',
        scope: 'family_shared',
      },
      {
        provider: 'notion',
        containerKey: 'notion.parent_and_stewardship',
        scope: 'parent_and_stewardship',
      },
      { provider: 'notion', containerKey: 'notion.protected', scope: 'legal' },
      {
        provider: 'drive',
        containerKey: 'drive.family_shared',
        scope: 'family_shared',
      },
      {
        provider: 'drive',
        containerKey: 'drive.parent_and_stewardship',
        scope: 'parent_and_stewardship',
      },
      { provider: 'drive', containerKey: 'drive.protected', scope: 'legal' },
    ]);
    expect(containerRecordPolicy(policy, 'notion.restricted')).toBeUndefined();
    expect(containerRecordPolicy(policy, 'drive.restricted')).toBeUndefined();
    expect(containerRecordPolicy(policy, 'notion.unknown')).toBeUndefined();
    expect(containerRecordPolicy(policy, 'drive.protected')).toEqual(
      policy.containerPolicies.protected,
    );
  });
});

const notionPolicy = (key: string) => {
  const found = containerRecordPolicy(policy, key);
  if (found === undefined) throw new Error(`missing synthetic policy ${key}`);
  return found;
};

describe('nested protected roots take precedence', () => {
  const sharedRootId = '20000000-0000-4000-8000-000000000001';
  const protectedRootId = '20000000-0000-4000-8000-000000000002';
  const parents: Record<string, NotionParentReference> = {
    [protectedRootId]: { kind: 'page', id: sharedRootId },
    [sharedRootId]: { kind: 'terminal' },
  };
  const notionClient = {
    retrieveParent: (object: { id: string }) =>
      Promise.resolve(parents[object.id] ?? { kind: 'terminal' }),
  } as unknown as NotionRetrievalClient;
  const notionRoots = [
    {
      rootRef: 'notion.family_shared',
      notionObject: { kind: 'page' as const, id: sharedRootId },
      displayPath: 'Family Shared',
      policy: notionPolicy('notion.family_shared'),
    },
    {
      rootRef: 'notion.protected',
      notionObject: { kind: 'page' as const, id: protectedRootId },
      displayPath: 'Family Shared / Legal',
      policy: notionPolicy('notion.protected'),
    },
  ];
  const nestedPage = {
    id: '20000000-0000-4000-8000-000000000003',
    title: 'Synthetic legal evidence',
    createdTime: '2042-01-01T00:00:00.000Z',
    updatedTime: '2042-01-01T00:00:00.000Z',
    inTrash: false,
    parent: { kind: 'page' as const, id: protectedRootId },
  };
  // As the services do: the principal's scopes limited to the configured roots.
  const configuredScopes = ['family_shared', 'legal'];
  const access = (scopes: readonly string[]) => ({
    brainScopes: scopes.filter((scope) =>
      configuredScopes.includes(scope),
    ) as never,
    rootRefs: ['notion.family_shared', 'notion.protected'],
  });

  it('gives a page under a nested Notion protected root the protected policy', async () => {
    const guard = new NotionScopeGuard(notionClient, notionRoots);

    await expect(
      guard.resolveAuthorizedRoot(
        nestedPage,
        access(policy.roleScopes.parent_steward),
        live(),
      ),
    ).resolves.toMatchObject({
      rootRef: 'notion.protected',
      policy: { scope: 'legal', protectedClass: 'protected' },
    });
  });

  it.each([
    ['undashed upper case', protectedRootId.replaceAll('-', '').toUpperCase()],
    ['dashed upper case', protectedRootId.toUpperCase()],
  ])(
    'matches a nested protected root configured as %s and never falls back to Family Shared',
    async (_, configuredId) => {
      const guard = new NotionScopeGuard(notionClient, [
        notionRoots[0] as (typeof notionRoots)[number],
        {
          ...(notionRoots[1] as (typeof notionRoots)[number]),
          notionObject: { kind: 'page', id: configuredId },
        },
      ]);

      await expect(
        guard.resolveAuthorizedRoot(
          nestedPage,
          {
            brainScopes: ['family_shared'],
            rootRefs: ['notion.family_shared'],
          },
          live(),
        ),
      ).resolves.toBeUndefined();
      await expect(
        guard.resolveAuthorizedRoot(
          nestedPage,
          access(policy.roleScopes.parent_steward),
          live(),
        ),
      ).resolves.toMatchObject({ rootRef: 'notion.protected' });
    },
  );

  it('never falls back to the outer Family Shared root for Participant', async () => {
    const guard = new NotionScopeGuard(notionClient, notionRoots);

    await expect(
      guard.resolveAuthorizedRoot(
        nestedPage,
        access(policy.roleScopes.family_participant),
        live(),
      ),
    ).resolves.toBeUndefined();
  });

  const driveFile = (
    id: string,
    parentIds: readonly string[],
  ): DriveFileSnapshot => ({
    id,
    name: `${id}.md`,
    mimeType: 'text/markdown',
    parents: parentIds,
    sharedDriveId: 'shared-drive-synthetic',
    createdTime: '2042-01-01T00:00:00.000Z',
    modifiedTime: '2042-01-01T00:00:00.000Z',
    version: '1',
    trashed: false,
    appProperties: {},
  });
  const driveRoots = [
    {
      rootRef: 'drive.family_shared',
      folderId: 'folder-shared',
      sharedDriveId: 'shared-drive-synthetic',
      displayPath: 'Family Shared',
      policy: notionPolicy('drive.family_shared'),
    },
    {
      rootRef: 'drive.protected',
      folderId: 'folder-legal',
      sharedDriveId: 'shared-drive-synthetic',
      displayPath: 'Family Shared / Legal',
      policy: notionPolicy('drive.protected'),
    },
  ];
  const driveClient: Pick<DriveClient, 'getFile'> = {
    getFile: (id) =>
      id === 'folder-legal'
        ? Promise.resolve(driveFile('folder-legal', ['folder-shared']))
        : Promise.reject(new DriveClientFailure('not_found')),
  };
  const evidence = driveFile('file-evidence', ['folder-legal']);

  it.each([
    ['Steward', policy.roleScopes.parent_steward, 'drive.protected'],
    ['Participant', policy.roleScopes.family_participant, undefined],
  ] as const)(
    'resolves a Drive file under a nested protected folder for %s',
    async (_, scopes, expected) => {
      const guard = new DriveRootGuard(driveClient, driveRoots);

      const root = await guard.resolveAuthorizedRoot(
        evidence,
        {
          brainScopes: scopes.filter((scope) =>
            configuredScopes.includes(scope),
          ),
          rootRefs: ['drive.family_shared', 'drive.protected'],
        },
        live(),
      );

      expect(root?.rootRef).toBe(expected);
    },
  );
});

describe('search with GitHub unbound', () => {
  it('reports GitHub unavailable and the search incomplete while other providers answer', async () => {
    const summary = brainReadSummary('notion', 'unbound-search');
    const notionRecord = brainReadRecord({
      ...summary,
      canonicalLocation: {
        ...summary.canonicalLocation,
        containerRef: 'notion.family_shared',
      },
    });
    const surfaces = registeredSurfaces(policy);
    const providerFor = (name: 'notion' | 'drive') =>
      new FakeFetchableKnowledgeProvider(
        name,
        name === 'notion' ? [notionRecord] : [],
        {
          configuredAccess: {
            brainScopes: ['family_shared', 'parent_and_stewardship', 'legal'],
            rootRefs: surfaces
              .filter((surface) => surface.provider === name)
              .map((surface) => surface.containerKey),
          },
        },
      );
    const query = new BrainQueryService(
      new AuthorizationEngine(policy, { now: () => brainReadNow }),
      new SyntheticMutationStore(),
      [
        providerFor('notion'),
        providerFor('drive'),
        new UnregisteredGitHubProvider(),
      ],
      surfaces,
      { clock: { now: () => brainReadNow } },
    );

    const response = await query.searchBrain(
      brainReadPrincipal(),
      brainReadContext('unbound-github'),
      { query: 'Synthetic', limit: 5 },
      live(),
    );

    expect(response.results).toHaveLength(1);
    expect(response.completeness.complete).toBe(false);
    expect(response.completeness.providers).toContainEqual({
      provider: 'github',
      state: 'unavailable',
      errorCode: 'provider_unavailable',
    });
  });
});

describe('UnregisteredGitHubProvider', () => {
  it('reports itself unavailable for search and fetch until the Registry is bound', async () => {
    const github = new UnregisteredGitHubProvider();

    expect(github.provider).toBe('github');
    await expect(
      github.search(
        { query: 'q', limit: 1, access: { brainScopes: [], rootRefs: [] } },
        live(),
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'github_registry_unbound' },
    });
    await expect(
      github.fetch(
        {
          providerRecordId: providerRecordId('github-1'),
          access: { brainScopes: [], rootRefs: [] },
        },
        live(),
      ),
    ).rejects.toMatchObject({ details: { reason: 'github_registry_unbound' } });
  });
});
