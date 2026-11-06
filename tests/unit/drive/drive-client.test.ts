import { describe, expect, it, vi } from 'vitest';

import {
  DRIVE_API_VERSION,
  DRIVE_CLIENT_TIMEOUT_MS,
  OfficialDriveClient,
  createOfficialDriveSdkClient,
  type DriveSdkClient,
} from '../../../src/adapters/drive/drive-client.js';

function sdkResponse(data: unknown) {
  return Promise.resolve({ data });
}

interface RecordedCall {
  readonly params: unknown;
  readonly options: unknown;
}

interface CallLog {
  readonly list: RecordedCall[];
  readonly get: RecordedCall[];
  readonly export: RecordedCall[];
  readonly create: RecordedCall[];
  readonly update: RecordedCall[];
}

function syntheticSdk(): DriveSdkClient & {
  readonly calls: CallLog;
} {
  const calls: CallLog = {
    list: [],
    get: [],
    export: [],
    create: [],
    update: [],
  };
  const method = (name: keyof CallLog, data: unknown) =>
    vi.fn((params: unknown, options?: unknown) => {
      calls[name].push({ params, options });
      return sdkResponse(data);
    });
  return {
    apiVersion: DRIVE_API_VERSION,
    files: {
      list: method('list', { files: [], nextPageToken: null }),
      get: vi.fn((params: unknown, options?: unknown) => {
        calls.get.push({ params, options });
        if (
          typeof params === 'object' &&
          params !== null &&
          'alt' in params &&
          params.alt === 'media'
        ) {
          return sdkResponse(new TextEncoder().encode('Synthetic download'));
        }
        return sdkResponse({
          id: 'file-1',
          name: 'Synthetic.md',
          mimeType: 'text/markdown',
          parents: ['folder-1'],
          driveId: 'shared-drive-1',
          createdTime: '2042-01-02T03:04:05.000Z',
          modifiedTime: '2042-01-03T04:05:06.000Z',
          version: '7',
          trashed: false,
          appProperties: {},
        });
      }),
      export: method('export', new TextEncoder().encode('Synthetic export')),
      create: method('create', {
        id: 'created-file',
        name: 'Created.md',
        mimeType: 'text/markdown',
        parents: ['folder-1'],
        driveId: 'shared-drive-1',
        createdTime: '2042-01-02T03:04:05.000Z',
        modifiedTime: '2042-01-03T04:05:06.000Z',
        version: '8',
        trashed: false,
        appProperties: {},
      }),
      update: method('update', {
        id: 'file-1',
        name: 'Updated.md',
        mimeType: 'text/markdown',
        parents: ['folder-1'],
        driveId: 'shared-drive-1',
        createdTime: '2042-01-02T03:04:05.000Z',
        modifiedTime: '2042-01-03T04:05:07.000Z',
        version: '8',
        trashed: false,
        appProperties: {},
      }),
    },
    calls,
  };
}

describe('OfficialDriveClient', () => {
  it('uses only drive or user corpora and always enables Shared Drive support', async () => {
    const sdk = syntheticSdk();
    const client = new OfficialDriveClient(sdk);

    await client.listChildFolders(
      {
        parentId: "folder-'quoted\\value",
        sharedDriveId: 'shared-drive-1',
        pageSize: 100,
        pageToken: 'page-2',
      },
      new AbortController().signal,
    );
    await client.searchChildFiles(
      {
        parentId: 'folder-personal-root',
        query: "Operator's \\ synthetic",
        pageSize: 25,
      },
      new AbortController().signal,
    );

    expect(sdk.calls.list[0]?.params).toMatchObject({
      corpora: 'drive',
      driveId: 'shared-drive-1',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      spaces: 'drive',
      pageToken: 'page-2',
    });
    expect(sdk.calls.list[0]?.params).not.toMatchObject({
      corpora: 'allDrives',
    });
    expect(sdk.calls.list[0]?.params).toHaveProperty(
      'q',
      "'folder-\\'quoted\\\\value' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'",
    );
    expect(sdk.calls.list[1]?.params).toMatchObject({
      corpora: 'user',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      spaces: 'drive',
    });
    expect(JSON.stringify(sdk.calls.list)).not.toContain('allDrives');
    expect(sdk.calls.list[1]?.params).toHaveProperty(
      'q',
      "'folder-personal-root' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder' and (name contains 'Operator\\'s \\\\ synthetic' or fullText contains 'Operator\\'s \\\\ synthetic')",
    );
  });

  it('omits orderBy for fullText search, which Drive rejects, and keeps it for listings', async () => {
    const sdk = syntheticSdk();
    const client = new OfficialDriveClient(sdk);
    const request = {
      parentId: 'folder-1',
      sharedDriveId: 'shared-drive-1',
      pageSize: 25,
    };

    await client.listChildFolders(request, new AbortController().signal);
    await client.searchChildFiles(
      { ...request, query: 'synthetic' },
      new AbortController().signal,
    );
    await client.findChildFilesByOperation(
      { ...request, operationHash: 'a'.repeat(64) },
      new AbortController().signal,
    );

    expect(sdk.calls.list[0]?.params).toHaveProperty('orderBy', 'name_natural');
    expect(sdk.calls.list[1]?.params).not.toHaveProperty('orderBy');
    expect(sdk.calls.list[2]?.params).toHaveProperty('orderBy', 'name_natural');
  });

  it('uses private appProperties for operation lookup without broad enumeration', async () => {
    const sdk = syntheticSdk();
    const client = new OfficialDriveClient(sdk);
    await client.findChildFilesByOperation(
      {
        parentId: 'folder-1',
        sharedDriveId: 'shared-drive-1',
        operationHash: 'a'.repeat(64),
        pageSize: 100,
      },
      new AbortController().signal,
    );

    expect(sdk.calls.list[0]?.params).toMatchObject({
      corpora: 'drive',
      driveId: 'shared-drive-1',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    expect(sdk.calls.list[0]?.params).toHaveProperty(
      'q',
      "'folder-1' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder' and appProperties has { key='sim_g_operation' and value='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }",
    );
  });

  it('sets bounded reads and narrow create/update/trash request shapes', async () => {
    const sdk = syntheticSdk();
    const client = new OfficialDriveClient(sdk);
    const signal = new AbortController().signal;

    await client.getFile('file-1', signal);
    await client.downloadFile('file-1', 4096, signal);
    await client.exportGoogleDocument('file-1', 4096, signal);
    await client.createMarkdown(
      {
        parentId: 'folder-1',
        name: 'Created.md',
        content: 'Synthetic content',
        appProperties: { sim_g_managed: '1' },
      },
      signal,
    );
    await client.updateTextFile(
      {
        fileId: 'file-1',
        name: 'Updated.md',
        mimeType: 'text/markdown',
        content: 'Updated content',
        appProperties: { sim_g_managed: '1' },
      },
      signal,
    );
    await client.trashFile(
      {
        fileId: 'file-1',
        appProperties: { sim_g_operation_kind: 'trash' },
      },
      signal,
    );

    expect(sdk.calls.get[0]?.params).toMatchObject({
      fileId: 'file-1',
      supportsAllDrives: true,
    });
    expect(sdk.calls.get[1]).toMatchObject({
      params: { fileId: 'file-1', supportsAllDrives: true, alt: 'media' },
      options: {
        responseType: 'arraybuffer',
        maxContentLength: 4096,
        signal,
      },
    });
    expect(sdk.calls.export[0]).toMatchObject({
      params: { fileId: 'file-1', mimeType: 'text/plain' },
      options: {
        responseType: 'arraybuffer',
        maxContentLength: 4096,
        signal,
      },
    });
    expect(sdk.calls.create[0]?.params).toMatchObject({
      supportsAllDrives: true,
      useContentAsIndexableText: true,
      requestBody: {
        name: 'Created.md',
        mimeType: 'text/markdown',
        parents: ['folder-1'],
        appProperties: { sim_g_managed: '1' },
      },
      media: { mimeType: 'text/markdown', body: 'Synthetic content' },
    });
    expect(sdk.calls.update[0]?.params).toMatchObject({
      fileId: 'file-1',
      supportsAllDrives: true,
      useContentAsIndexableText: true,
      requestBody: {
        name: 'Updated.md',
        appProperties: { sim_g_managed: '1' },
      },
      media: { mimeType: 'text/markdown', body: 'Updated content' },
    });
    expect(sdk.calls.update[1]?.params).toMatchObject({
      fileId: 'file-1',
      supportsAllDrives: true,
      requestBody: {
        trashed: true,
        appProperties: { sim_g_operation_kind: 'trash' },
      },
    });
    expect(sdk.calls.update[1]?.params).not.toHaveProperty('media');
  });

  it('constructs a frozen official v3-only method surface with retries disabled', () => {
    const auth = { request: vi.fn() } as never;
    const client = createOfficialDriveSdkClient({ auth });

    expect(client.apiVersion).toBe('v3');
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(client.files)).toBe(true);
    expect(Object.keys(client.files).sort()).toEqual([
      'create',
      'export',
      'get',
      'list',
      'update',
    ]);
    expect(client).not.toHaveProperty('permissions');
    expect(DRIVE_CLIENT_TIMEOUT_MS).toBe(5_000);
  });

  it('rejects malformed SDK responses and cancellation safely', async () => {
    const sdk = syntheticSdk();
    const client = new OfficialDriveClient({
      ...sdk,
      files: {
        ...sdk.files,
        get: vi.fn(() => sdkResponse({ id: 'missing-required-fields' })),
      },
    });
    await expect(
      client.getFile('file-1', new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'unavailable' });

    const controller = new AbortController();
    controller.abort(new Error('SYNTHETIC_PRIVATE_REASON'));
    const error = await client
      .listChildFolders(
        { parentId: 'folder-1', pageSize: 100 },
        controller.signal,
      )
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_REASON');
  });

  it('accepts omitted empty file lists and root parents from valid Drive responses', async () => {
    const sdk = syntheticSdk();
    const client = new OfficialDriveClient({
      ...sdk,
      files: {
        ...sdk.files,
        list: vi.fn(() => sdkResponse({ nextPageToken: null })),
        get: vi.fn(() =>
          sdkResponse({
            id: 'shared-drive-root',
            name: 'Synthetic Shared Drive root',
            mimeType: 'application/vnd.google-apps.folder',
            driveId: 'shared-drive-1',
            createdTime: '2042-01-02T03:04:05.000Z',
            modifiedTime: '2042-01-03T04:05:06.000Z',
            version: '1',
            trashed: false,
          }),
        ),
      },
    });

    await expect(
      client.listChildFolders(
        {
          parentId: 'shared-drive-root',
          sharedDriveId: 'shared-drive-1',
          pageSize: 100,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ files: [] });
    await expect(
      client.getFile('shared-drive-root', new AbortController().signal),
    ).resolves.toMatchObject({ parents: [], appProperties: {} });
  });
});
