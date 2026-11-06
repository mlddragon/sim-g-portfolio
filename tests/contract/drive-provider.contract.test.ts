import { createHash } from 'node:crypto';

import { describe } from 'vitest';

import type { DriveFileSnapshot } from '../../src/adapters/drive/drive-client.js';
import { DriveKnowledgeProvider } from '../../src/adapters/drive/drive-knowledge-provider.js';
import { mapDriveRecord } from '../../src/adapters/drive/drive-record-mapper.js';
import type { DriveGovernedRoot } from '../../src/adapters/drive/drive-root-guard.js';
import { operationId, providerRecordId } from '../../src/domain/identifiers.js';
import { mutableKnowledgeProviderContract } from './knowledge-provider.contract.js';
import { SyntheticDriveClient } from '../support/synthetic-drive-client.js';

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

const hiddenRoot: DriveGovernedRoot = {
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

function folder(rootConfig: DriveGovernedRoot): DriveFileSnapshot {
  return {
    id: rootConfig.folderId,
    name: rootConfig.displayPath,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [],
    ...(rootConfig.sharedDriveId === undefined
      ? {}
      : { sharedDriveId: rootConfig.sharedDriveId }),
    createdTime: '2042-01-01T00:00:00.000Z',
    modifiedTime: '2042-01-01T00:00:00.000Z',
    version: '1',
    trashed: false,
    appProperties: {},
  };
}

const visibleContent = 'Synthetic garden notes for contract use.';
const visibleFile: DriveFileSnapshot = {
  id: 'drive-visible-record',
  name: 'Synthetic Garden Notes.md',
  mimeType: 'text/markdown',
  parents: [root.folderId],
  ...(root.sharedDriveId === undefined
    ? {}
    : { sharedDriveId: root.sharedDriveId }),
  createdTime: '2042-01-02T03:04:05.000Z',
  modifiedTime: '2042-01-03T04:05:06.000Z',
  version: '7',
  headRevisionId: 'revision-7',
  trashed: false,
  size: '39',
  appProperties: {
    sim_g_managed: '1',
    sim_g_operation: createHash('sha256')
      .update('synthetic-previous-operation')
      .digest('hex'),
    sim_g_operation_kind: 'create',
    sim_g_root: createHash('sha256').update(root.rootRef).digest('hex'),
    sim_g_content_sha256: createHash('sha256')
      .update(visibleContent)
      .digest('hex'),
  },
};

const hiddenFile: DriveFileSnapshot = {
  ...visibleFile,
  id: 'drive-hidden-record',
  name: 'Synthetic Hidden Notes.md',
  parents: [hiddenRoot.folderId],
};

const unknownCreate = operationId('op_contract_drive_unknown_create');
const unknownHash = createHash('sha256').update(unknownCreate).digest('hex');

describe('DriveKnowledgeProvider contract', () => {
  mutableKnowledgeProviderContract({
    name: 'governed Drive adapter',
    provider: 'drive',
    getProvider: () => {
      const client = new SyntheticDriveClient(
        [
          { metadata: folder(root) },
          { metadata: folder(hiddenRoot) },
          { metadata: visibleFile, content: visibleContent },
          { metadata: hiddenFile, content: 'Synthetic hidden content.' },
        ],
        { unknownOperationHashes: [unknownHash] },
      );
      return new DriveKnowledgeProvider(client, { roots: [root, hiddenRoot] });
    },
    visibleRecord: mapDriveRecord(visibleFile, root, visibleContent),
    hiddenProviderRecordIds: [providerRecordId(hiddenFile.id)],
    authorizedAccess: {
      brainScopes: ['family_shared'],
      rootRefs: [root.rootRef],
    },
    unconfiguredRootRef: 'drive://development/unconfigured',
    unconfiguredBrainScope: 'legal',
    matchingQuery: 'garden',
    unknownCreateOperationId: unknownCreate,
    createContentType: 'text/markdown',
  });
});
