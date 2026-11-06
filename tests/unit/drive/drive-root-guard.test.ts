import { describe, expect, it } from 'vitest';

import {
  DriveClientFailure,
  type DriveClient,
  type DriveFileSnapshot,
} from '../../../src/adapters/drive/drive-client.js';
import {
  DriveRootGuard,
  type DriveGovernedRoot,
} from '../../../src/adapters/drive/drive-root-guard.js';

const sharedRoot: DriveGovernedRoot = {
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

const nestedPrivateRoot: DriveGovernedRoot = {
  rootRef: 'drive://development/parent-stewardship',
  folderId: 'folder-parent-stewardship',
  sharedDriveId: 'shared-drive-development',
  displayPath: 'Parent and Stewardship',
  policy: {
    scope: 'parent_and_stewardship',
    sensitivity: 'parent_and_stewardship',
    protectedClass: 'protected',
  },
};

function file(
  id: string,
  parents: readonly string[],
  overrides: Partial<DriveFileSnapshot> = {},
): DriveFileSnapshot {
  return {
    id,
    name: `${id}.md`,
    mimeType: 'text/markdown',
    parents,
    sharedDriveId: 'shared-drive-development',
    createdTime: '2042-01-02T03:04:05.000Z',
    modifiedTime: '2042-01-03T04:05:06.000Z',
    version: '7',
    trashed: false,
    appProperties: {},
    ...overrides,
  };
}

class MetadataClient implements Pick<DriveClient, 'getFile'> {
  readonly #files: ReadonlyMap<string, DriveFileSnapshot>;

  constructor(files: readonly DriveFileSnapshot[]) {
    this.#files = new Map(files.map((entry) => [entry.id, entry]));
  }

  async getFile(
    fileId: string,
    signal: AbortSignal,
  ): Promise<DriveFileSnapshot> {
    await Promise.resolve();
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
    const found = this.#files.get(fileId);
    if (found === undefined) throw new DriveClientFailure('not_found');
    return found;
  }
}

const fullAccess = {
  brainScopes: ['family_shared', 'parent_and_stewardship'] as const,
  rootRefs: [sharedRoot.rootRef, nestedPrivateRoot.rootRef],
};

describe('DriveRootGuard', () => {
  it('authorizes direct and nested descendants of an exact configured root', async () => {
    const direct = file('file-direct', [sharedRoot.folderId]);
    const folder = file('folder-nested', [sharedRoot.folderId], {
      mimeType: 'application/vnd.google-apps.folder',
    });
    const nested = file('file-nested', [folder.id]);
    const guard = new DriveRootGuard(
      new MetadataClient([direct, folder, nested]),
      [sharedRoot],
    );

    await expect(
      guard.resolveAuthorizedRoot(
        direct,
        {
          brainScopes: ['family_shared'],
          rootRefs: [sharedRoot.rootRef],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual(sharedRoot);
    await expect(
      guard.resolveAuthorizedRoot(
        nested,
        {
          brainScopes: ['family_shared'],
          rootRefs: [sharedRoot.rootRef],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual(sharedRoot);
  });

  it('stops at the nearest configured root instead of falling through a denied nested root', async () => {
    const target = file('file-private', [nestedPrivateRoot.folderId]);
    const guard = new DriveRootGuard(new MetadataClient([target]), [
      sharedRoot,
      nestedPrivateRoot,
    ]);

    await expect(
      guard.resolveAuthorizedRoot(
        target,
        {
          brainScopes: ['family_shared'],
          rootRefs: [sharedRoot.rootRef],
        },
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });

  it('denies files outside registered roots or in the wrong shared drive', async () => {
    const outside = file('file-outside', ['unregistered-folder']);
    const wrongDrive = file('file-wrong-drive', [sharedRoot.folderId], {
      sharedDriveId: 'another-shared-drive',
    });
    const guard = new DriveRootGuard(
      new MetadataClient([outside, wrongDrive]),
      [sharedRoot],
    );
    const access = {
      brainScopes: ['family_shared'] as const,
      rootRefs: [sharedRoot.rootRef],
    };

    await expect(
      guard.resolveAuthorizedRoot(
        outside,
        access,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    await expect(
      guard.resolveAuthorizedRoot(
        wrongDrive,
        access,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects access expansion and snapshots mutable caller arrays', () => {
    const guard = new DriveRootGuard(new MetadataClient([]), [
      sharedRoot,
      nestedPrivateRoot,
    ]);
    const scopes = ['family_shared'] as Array<'family_shared'>;
    const roots = [sharedRoot.rootRef];
    const snapshot = guard.snapshotAccess({
      brainScopes: scopes,
      rootRefs: roots,
    });
    scopes.push('family_shared');
    roots[0] = nestedPrivateRoot.rootRef;

    expect(snapshot).toEqual({
      brainScopes: ['family_shared'],
      rootRefs: [sharedRoot.rootRef],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() =>
      guard.snapshotAccess({
        brainScopes: ['family_shared', 'legal'],
        rootRefs: [sharedRoot.rootRef, 'drive://development/not-configured'],
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'unauthorized',
        details: { reason: 'provider_scope_rejected' },
      }),
    );
  });

  it('fails closed on parent cycles, multiple parents, and excessive ancestry', async () => {
    const cycleA = file('cycle-a', ['cycle-b']);
    const cycleB = file('cycle-b', ['cycle-a']);
    const multiple = file('multiple', ['one', 'two']);
    const deep = Array.from({ length: 66 }, (_, index) =>
      file(`deep-${String(index)}`, [
        index === 65 ? sharedRoot.folderId : `deep-${String(index + 1)}`,
      ]),
    );
    const guard = new DriveRootGuard(
      new MetadataClient([cycleA, cycleB, multiple, ...deep]),
      [sharedRoot],
    );

    for (const target of [cycleA, multiple, ...deep.slice(0, 1)]) {
      await expect(
        guard.resolveAuthorizedRoot(
          target,
          {
            brainScopes: ['family_shared'],
            rootRefs: [sharedRoot.rootRef],
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        name: 'DriveClientFailure',
        kind: 'unavailable',
      });
    }
  });

  it('rejects duplicate roots and malformed configuration', () => {
    expect(
      () =>
        new DriveRootGuard(new MetadataClient([]), [
          sharedRoot,
          { ...sharedRoot, folderId: 'different-folder' },
        ]),
    ).toThrow('invalid_drive_provider_configuration');
    expect(() => new DriveRootGuard(new MetadataClient([]), [])).toThrow(
      'invalid_drive_provider_configuration',
    );
  });

  it('honors cancellation without exposing the abort reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('SYNTHETIC_PRIVATE_REASON'));
    const target = file('cancelled', [sharedRoot.folderId]);
    const guard = new DriveRootGuard(new MetadataClient([target]), [
      sharedRoot,
    ]);

    const error = await guard
      .resolveAuthorizedRoot(target, fullAccess, controller.signal)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_REASON');
  });
});
