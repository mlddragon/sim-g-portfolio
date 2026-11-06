import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DRIVE_MAX_CONTENT_BYTES,
  type DriveFileSnapshot,
} from '../../../src/adapters/drive/drive-client.js';
import {
  DriveKnowledgeProvider,
  driveOperationHash,
} from '../../../src/adapters/drive/drive-knowledge-provider.js';
import type { DriveGovernedRoot } from '../../../src/adapters/drive/drive-root-guard.js';
import { driveProviderVersion } from '../../../src/adapters/drive/drive-record-mapper.js';
import {
  operationId,
  providerRecordId,
} from '../../../src/domain/identifiers.js';
import { SyntheticDriveClient } from '../../support/synthetic-drive-client.js';

const root: DriveGovernedRoot = {
  rootRef: 'drive://development/family-shared',
  folderId: 'folder-family-shared',
  sharedDriveId: 'shared-drive-development',
  displayPath: 'Family Shared',
  policy: {
    scope: 'family_shared',
    sensitivity: 'family_shared',
    protectedClass: 'none',
  },
};

const privateRoot: DriveGovernedRoot = {
  rootRef: 'drive://development/private',
  folderId: 'folder-private',
  sharedDriveId: 'shared-drive-development',
  displayPath: 'Private',
  policy: {
    scope: 'parent_and_stewardship',
    sensitivity: 'parent_and_stewardship',
    protectedClass: 'protected',
  },
};

const access = {
  brainScopes: ['family_shared'] as const,
  rootRefs: [root.rootRef],
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function folder(
  config: DriveGovernedRoot,
  parents: readonly string[] = [],
): DriveFileSnapshot {
  return {
    id: config.folderId,
    name: config.displayPath,
    mimeType: 'application/vnd.google-apps.folder',
    parents,
    ...(config.sharedDriveId === undefined
      ? {}
      : { sharedDriveId: config.sharedDriveId }),
    createdTime: '2042-01-01T00:00:00.000Z',
    modifiedTime: '2042-01-01T00:00:00.000Z',
    version: '1',
    trashed: false,
    appProperties: {},
  };
}

function record(
  id: string,
  mimeType: string,
  overrides: Partial<DriveFileSnapshot> = {},
): DriveFileSnapshot {
  return {
    id,
    name: `Synthetic ${id}`,
    mimeType,
    parents: [root.folderId],
    ...(root.sharedDriveId === undefined
      ? {}
      : { sharedDriveId: root.sharedDriveId }),
    createdTime: '2042-01-02T03:04:05.000Z',
    modifiedTime: '2042-01-03T04:05:06.000Z',
    version: '7',
    headRevisionId: 'revision-7',
    trashed: false,
    appProperties: {},
    ...overrides,
  };
}

/** driveProviderVersion of record(): head revision and modified time. */
const VERSION_7 = 'revision-7@2042-01-03T04:05:06.000Z';

function managedProperties(
  content: string,
  kind = 'create',
): Readonly<Record<string, string>> {
  return {
    sim_g_managed: '1',
    sim_g_operation: sha256('synthetic-previous-operation'),
    sim_g_operation_kind: kind,
    sim_g_root: sha256(root.rootRef),
    sim_g_content_sha256: sha256(content),
  };
}

function provider(
  files: ConstructorParameters<typeof SyntheticDriveClient>[0],
  options: ConstructorParameters<typeof SyntheticDriveClient>[1] = {},
) {
  const client = new SyntheticDriveClient(
    [{ metadata: folder(root) }, { metadata: folder(privateRoot) }, ...files],
    options,
  );
  return {
    client,
    provider: new DriveKnowledgeProvider(client, {
      roots: [root, privateRoot],
    }),
  };
}

function createRequest(id = 'op_drive_create_001') {
  return {
    operationId: operationId(id),
    access,
    title: 'Synthetic created notes',
    content: '# Synthetic content\n',
    contentType: 'text/markdown',
    canonicalLocation: {
      provider: 'drive' as const,
      containerRef: root.rootRef,
      displayPath: root.displayPath,
    },
    policy: root.policy,
  };
}

describe('DriveKnowledgeProvider retrieval', () => {
  it('searches every authorized descendant folder with bounded pagination', async () => {
    const nested = record(
      'folder-nested',
      'application/vnd.google-apps.folder',
      {
        parents: [root.folderId],
      },
    );
    const direct = record('file-direct', 'text/plain', {
      name: 'Synthetic Garden Direct',
    });
    const nestedMatch = record('file-nested', 'text/markdown', {
      name: 'Synthetic Garden Nested',
      parents: [nested.id],
    });
    const hidden = record('file-private', 'text/plain', {
      name: 'Synthetic Garden Private',
      parents: [privateRoot.folderId],
    });
    const built = provider(
      [
        { metadata: nested },
        { metadata: direct, content: 'garden direct' },
        { metadata: nestedMatch, content: 'garden nested' },
        { metadata: hidden, content: 'garden private' },
      ],
      { pageSizeCap: 1 },
    );

    const response = await built.provider.search(
      { query: 'garden', limit: 10, access },
      new AbortController().signal,
    );

    expect(response.completeness).toEqual({
      provider: 'drive',
      state: 'complete',
    });
    expect(
      response.records.map((entry) => entry.provenance.providerRecordId),
    ).toEqual([providerRecordId(direct.id), providerRecordId(nestedMatch.id)]);
    expect(built.client.searchCalls.map((call) => call.parentId)).toEqual([
      root.folderId,
      nested.id,
    ]);
    expect(built.client.folderListCalls.map((call) => call.parentId)).toEqual([
      root.folderId,
      nested.id,
    ]);
    expect(
      [...built.client.searchCalls, ...built.client.folderListCalls].every(
        (call) => call.sharedDriveId === root.sharedDriveId,
      ),
    ).toBe(true);
  });

  it.each([
    ['text/plain', 'Synthetic plain text', 'text/plain'],
    ['text/markdown', '# Synthetic markdown', 'text/markdown'],
    ['application/json', '{"synthetic":true}', 'application/json'],
  ])(
    'fetches bounded UTF-8 %s files',
    async (mimeType, content, expectedType) => {
      const target = record(`file-${mimeType}`, mimeType, {
        size: String(new TextEncoder().encode(content).byteLength),
      });
      const built = provider([{ metadata: target, content }]);

      await expect(
        built.provider.fetch(
          { providerRecordId: providerRecordId(target.id), access },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ content, contentType: expectedType });
      expect(built.client.downloadCalls).toEqual([target.id]);
    },
  );

  it('exports Google Docs as bounded plain text', async () => {
    const target = record('google-doc', 'application/vnd.google-apps.document');
    const built = provider([
      { metadata: target, exportedContent: 'Synthetic exported document' },
    ]);

    await expect(
      built.provider.fetch(
        { providerRecordId: providerRecordId(target.id), access },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      content: 'Synthetic exported document',
      contentType: 'text/plain',
    });
    expect(built.client.exportCalls).toEqual([target.id]);
    expect(built.client.downloadCalls).toEqual([]);
  });

  it.each(['application/pdf', 'image/png', 'application/octet-stream'])(
    'rejects unsupported %s full-content fetches with a stable bounded error',
    async (mimeType) => {
      const target = record(`unsupported-${mimeType}`, mimeType);
      const built = provider([{ metadata: target, content: 'not returned' }]);

      const error = await built.provider
        .fetch(
          { providerRecordId: providerRecordId(target.id), access },
          new AbortController().signal,
        )
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: 'provider_capability_unsupported',
        retryable: false,
        details: { reason: 'drive_mime_type_not_readable' },
      });
      expect(JSON.stringify(error)).not.toContain(target.id);
      expect(built.client.downloadCalls).toEqual([]);
    },
  );

  it('rejects oversized and invalid UTF-8 content before returning partial data', async () => {
    const tooLarge = record('too-large', 'text/plain', {
      size: String(DRIVE_MAX_CONTENT_BYTES + 1),
    });
    const invalid = record('invalid-utf8', 'text/plain', { size: '1' });
    const built = provider([
      { metadata: tooLarge, content: 'small synthetic fixture' },
      { metadata: invalid, content: new Uint8Array([0xff]) },
    ]);

    await expect(
      built.provider.fetch(
        { providerRecordId: providerRecordId(tooLarge.id), access },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_capability_unsupported',
      details: { reason: 'drive_content_too_large' },
    });
    await expect(
      built.provider.fetch(
        { providerRecordId: providerRecordId(invalid.id), access },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      details: { reason: 'drive_content_invalid_utf8' },
    });
    expect(built.client.downloadCalls).toEqual([invalid.id]);
  });
});

describe('DriveKnowledgeProvider mutations', () => {
  it('creates only routed Markdown with private bounded operation metadata', async () => {
    const built = provider([]);
    const request = createRequest();
    const result = await built.provider.create(
      request,
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      outcome: 'completed',
      record: {
        provider: 'drive',
        canonicalLocation: {
          provider: 'drive',
          containerRef: root.rootRef,
        },
        integrityHash: sha256(request.content),
      },
    });
    expect(built.client.createCalls).toHaveLength(1);
    expect(built.client.createCalls[0]).toMatchObject({
      parentId: root.folderId,
      name: request.title,
      content: request.content,
      appProperties: {
        sim_g_managed: '1',
        sim_g_operation: driveOperationHash(request.operationId),
        sim_g_operation_kind: 'create',
        sim_g_root: sha256(root.rootRef),
        sim_g_content_sha256: sha256(request.content),
      },
    });
  });

  it('rejects non-Markdown create and mismatched routed policy/container', async () => {
    for (const request of [
      { ...createRequest('op_bad_type'), contentType: 'text/plain' },
      {
        ...createRequest('op_bad_root'),
        canonicalLocation: {
          provider: 'drive' as const,
          containerRef: privateRoot.rootRef,
        },
      },
      {
        ...createRequest('op_bad_policy'),
        policy: privateRoot.policy,
      },
    ]) {
      const built = provider([]);
      await expect(
        built.provider.create(request, new AbortController().signal),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        details: { reason: 'invalid_routed_create' },
      });
      expect(built.client.createCalls).toEqual([]);
    }
  });

  it('revalidates the destination root immediately before create dispatch', async () => {
    const built = provider([], {
      onOperationList(count, client) {
        if (count === 1) {
          client.replaceFile({ ...folder(root), trashed: true, version: '2' });
        }
      },
    });

    await expect(
      built.provider.create(
        createRequest('op_create_root_race'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(built.client.createCalls).toEqual([]);
  });

  it.each([
    ['application/vnd.google-apps.document', true],
    ['application/json', true],
    ['text/plain', false],
    ['text/markdown', false],
  ])(
    'allows mutation only for gateway-managed text files (%s, unmanaged=%s)',
    async (mimeType, unmanaged) => {
      const content = 'Synthetic original content.';
      const target = record(
        `mutation-${mimeType}-${String(unmanaged)}`,
        mimeType,
        {
          size: String(content.length),
          appProperties: unmanaged ? {} : managedProperties(content),
        },
      );
      const built = provider([{ metadata: target, content }]);
      const run = built.provider.update(
        {
          operationId: operationId(
            `op_update_${mimeType}_${String(unmanaged)}`,
          ),
          access,
          providerRecordId: providerRecordId(target.id),
          expectedProviderVersion: VERSION_7,
          mutation: {
            mode: 'replace',
            replacement: { content: 'Synthetic replacement.' },
          },
        },
        new AbortController().signal,
      );

      if (
        !unmanaged &&
        (mimeType === 'text/plain' || mimeType === 'text/markdown')
      ) {
        await expect(run).resolves.toMatchObject({ outcome: 'completed' });
        expect(built.client.updateCalls).toHaveLength(1);
      } else {
        await expect(run).rejects.toMatchObject({
          code: 'provider_capability_unsupported',
          details: { reason: 'drive_record_not_mutable' },
        });
        expect(built.client.updateCalls).toEqual([]);
      }
    },
  );

  it('verifies live content integrity before mutation', async () => {
    const trusted = 'Synthetic trusted body.';
    const target = record('integrity-target', 'text/markdown', {
      size: String(trusted.length),
      appProperties: managedProperties(trusted),
    });
    const built = provider([{ metadata: target, content: 'Tampered body.' }]);

    await expect(
      built.provider.append(
        {
          operationId: operationId('op_integrity_append'),
          access,
          providerRecordId: providerRecordId(target.id),
          expectedProviderVersion: VERSION_7,
          content: '\nSynthetic append.',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      details: { reason: 'drive_integrity_mismatch' },
    });
    expect(built.client.updateCalls).toEqual([]);
  });

  it('rejects undefined or unknown patch fields without a metadata-only write', async () => {
    const content = 'Synthetic original body.';
    const target = record('invalid-patch-target', 'text/markdown', {
      size: String(content.length),
      appProperties: managedProperties(content),
    });

    for (const patch of [
      { title: undefined },
      { content: undefined },
      { unknown: 'Synthetic value' },
    ]) {
      const built = provider([{ metadata: target, content }]);
      await expect(
        built.provider.update(
          {
            operationId: operationId(
              `op_invalid_patch_${Object.keys(patch)[0] ?? 'empty'}`,
            ),
            access,
            providerRecordId: providerRecordId(target.id),
            expectedProviderVersion: VERSION_7,
            mutation: { mode: 'patch', patch },
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        details: { reason: 'invalid_routed_update' },
      });
      expect(built.client.updateCalls).toEqual([]);
    }
  });

  it('revalidates ancestry and version immediately before dispatch', async () => {
    const content = 'Synthetic original body.';
    const target = record('moving-target', 'text/markdown', {
      size: String(content.length),
      appProperties: managedProperties(content),
    });
    const built = provider([{ metadata: target, content }], {
      onGet(fileId, count, client) {
        if (fileId === target.id && count === 2) {
          client.replaceFile(
            { ...target, parents: ['unregistered-folder'], version: '8' },
            content,
          );
        }
      },
    });

    await expect(
      built.provider.update(
        {
          operationId: operationId('op_target_moved'),
          access,
          providerRecordId: providerRecordId(target.id),
          expectedProviderVersion: VERSION_7,
          mutation: {
            mode: 'patch',
            patch: { title: 'Should not be written' },
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(built.client.getCalls.filter((id) => id === target.id)).toHaveLength(
      2,
    );
    expect(built.client.updateCalls).toEqual([]);
  });

  it("derives the version from the content revision and modified time, not Drive's internal counter", () => {
    const file = record('versioned-target', 'text/markdown');
    expect(driveProviderVersion(file)).toBe(VERSION_7);
    expect(driveProviderVersion({ ...file, version: '8' })).toBe(VERSION_7);
    expect(
      driveProviderVersion({ ...file, headRevisionId: 'revision-8' }),
    ).not.toBe(VERSION_7);
    expect(
      driveProviderVersion({
        ...file,
        modifiedTime: '2042-01-03T04:05:07.000Z',
      }),
    ).not.toBe(VERSION_7);
    const { headRevisionId: _omitted, ...withoutRevision } = file;
    expect(driveProviderVersion(withoutRevision)).toBe(
      '2042-01-03T04:05:06.000Z',
    );
  });

  // Drive bumps `version` for server changes no user makes, shortly after a write.
  it.each([1, 2])(
    'ignores a version-only bump at get %i, which Drive makes after its own writes',
    async (bumpAt) => {
      const content = 'Synthetic original body.';
      const target = record(
        `settling-target-${String(bumpAt)}`,
        'text/markdown',
        {
          size: String(content.length),
          appProperties: managedProperties(content),
        },
      );
      const built = provider([{ metadata: target, content }], {
        onGet(fileId, count, client) {
          if (fileId === target.id && count === bumpAt) {
            client.replaceFile({ ...target, version: '8' }, content);
          }
        },
      });

      await expect(
        built.provider.append(
          {
            operationId: operationId(`op_version_settle_${String(bumpAt)}`),
            access,
            providerRecordId: providerRecordId(target.id),
            expectedProviderVersion: VERSION_7,
            content: '\nSynthetic append.',
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ outcome: 'completed' });
      expect(built.client.updateCalls).toHaveLength(1);
    },
  );

  it.each([
    ['a new content revision', { version: '8', headRevisionId: 'revision-8' }],
    [
      'a metadata edit by someone else',
      { version: '8', modifiedTime: '2042-01-03T04:05:07.000Z' },
    ],
  ] as const)(
    'rejects %s during the final pre-write refresh',
    async (_label, change) => {
      const content = 'Synthetic original body.';
      const target = record('racing-target', 'text/markdown', {
        size: String(content.length),
        appProperties: managedProperties(content),
      });
      const built = provider([{ metadata: target, content }], {
        onGet(fileId, count, client) {
          if (fileId === target.id && count === 2) {
            client.replaceFile({ ...target, ...change }, content);
          }
        },
      });

      await expect(
        built.provider.append(
          {
            operationId: operationId('op_version_race'),
            access,
            providerRecordId: providerRecordId(target.id),
            expectedProviderVersion: VERSION_7,
            content: '\nSynthetic append.',
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: 'idempotency_conflict',
        details: { reason: 'provider_version_mismatch' },
      });
      expect(built.client.updateCalls).toEqual([]);
    },
  );

  it('uses recoverable trash and reconciles only the exact operation marker', async () => {
    const content = 'Synthetic trashable body.';
    const target = record('trash-target', 'text/markdown', {
      size: String(content.length),
      appProperties: managedProperties(content),
    });
    const built = provider([{ metadata: target, content }]);
    const id = operationId('op_drive_trash_001');

    const result = await built.provider.trash(
      {
        operationId: id,
        access,
        providerRecordId: providerRecordId(target.id),
        expectedProviderVersion: VERSION_7,
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(built.client.trashCalls).toHaveLength(1);
    expect(built.client.file(target.id)?.trashed).toBe(true);

    await expect(
      built.provider.reconcile(
        {
          operationId: id,
          operation: 'trash',
          access,
          providerRecordId: providerRecordId(target.id),
          reconciliationKey: `drive-op-${driveOperationHash(id)}`,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ outcome: 'completed' });
    await expect(
      built.provider.reconcile(
        {
          operationId: id,
          operation: 'trash',
          access,
          providerRecordId: providerRecordId(target.id),
          reconciliationKey: 'drive-op-wrong',
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ outcome: 'inconclusive' });
  });

  it('turns an ambiguous provider write into outcome_unknown without retrying', async () => {
    const id = operationId('op_drive_unknown_create_001');
    const built = provider([], {
      unknownOperationHashes: [driveOperationHash(id)],
    });

    await expect(
      built.provider.create(createRequest(id), new AbortController().signal),
    ).resolves.toEqual({
      outcome: 'unknown',
      reconciliationKey: `drive-op-${driveOperationHash(id)}`,
    });
    expect(built.client.createCalls).toHaveLength(1);
  });
});
