import { createHash } from 'node:crypto';

import { DomainError } from '../../domain/errors.js';
import type { OperationId } from '../../domain/identifiers.js';
import type { UpdateMutation } from '../../domain/operations.js';
import type {
  BrainRecord,
  BrainRecordSummary,
  RecordPolicyMetadata,
} from '../../domain/records.js';
import type {
  MutableKnowledgeProvider,
  ProviderFetchRequest,
  ProviderMutationResult,
  ProviderSearchRequest,
  ProviderSearchResponse,
  ReconciliationRequest,
  ReconciliationResult,
  RoutedAppend,
  RoutedCreate,
  RoutedTrash,
  RoutedUpdate,
} from '../../ports/knowledge-provider.js';
import {
  DRIVE_FOLDER_MIME_TYPE,
  DRIVE_GOOGLE_DOC_MIME_TYPE,
  DRIVE_MAX_CONTENT_BYTES,
  DriveClientFailure,
  type DriveClient,
  type DriveFilePage,
  type DriveFileSnapshot,
} from './drive-client.js';
import {
  driveProviderVersion,
  mapDriveRecord,
  mapDriveSummary,
} from './drive-record-mapper.js';
import {
  DriveRootGuard,
  type DriveAccessScope,
  type DriveGovernedRoot,
} from './drive-root-guard.js';

export type { DriveGovernedRoot } from './drive-root-guard.js';

export interface DriveKnowledgeProviderOptions {
  readonly roots: readonly DriveGovernedRoot[];
}

const maxSearchLimit = 100;
const pageSize = 100;
const maxTraversalFolders = 1_024;
const maxListRequests = 4_096;
const maxListedFiles = 10_000;
const mutableMimeTypes = new Set(['text/plain', 'text/markdown']);
const readableMimeTypes = new Set([
  'text/plain',
  'text/markdown',
  'application/json',
]);

interface TraversalState {
  folders: number;
  requests: number;
  files: number;
}

interface FolderWork {
  readonly folderId: string;
  readonly root: DriveGovernedRoot;
}

interface ManagedTarget {
  readonly file: DriveFileSnapshot;
  readonly root: DriveGovernedRoot;
  readonly content: string;
}

type MutationKind = ReconciliationRequest['operation'];

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function driveOperationHash(operation: OperationId): string {
  return hash(operation);
}

function reconciliationKey(operation: OperationId): string {
  return `drive-op-${driveOperationHash(operation)}`;
}

function invalidSearch(): DomainError {
  return new DomainError('invalid_request', false, {
    reason: 'invalid_provider_search_request',
  });
}

function invalidCreate(): DomainError {
  return new DomainError('invalid_request', false, {
    reason: 'invalid_routed_create',
  });
}

function invalidUpdate(): DomainError {
  return new DomainError('invalid_request', false, {
    reason: 'invalid_routed_update',
  });
}

function invalidAppend(): DomainError {
  return new DomainError('invalid_request', false, {
    reason: 'invalid_routed_append',
  });
}

function notFound(): DomainError {
  return new DomainError('not_found', false, { reason: 'record_not_found' });
}

function unavailable(reason = 'drive_request_failed'): DomainError {
  return new DomainError('provider_unavailable', true, { reason });
}

function unsupported(reason: string): DomainError {
  return new DomainError('provider_capability_unsupported', false, { reason });
}

function versionConflict(): DomainError {
  return new DomainError('idempotency_conflict', false, {
    reason: 'provider_version_mismatch',
  });
}

function repeatedOperation(): DomainError {
  return new DomainError('idempotency_conflict', false, {
    reason: 'provider_operation_repeated',
  });
}

function cancellation(): DOMException {
  return new DOMException('Provider operation cancelled', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw cancellation();
}

function validMetadata(value: unknown, maxLength: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
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

function validContent(value: unknown, allowEmpty = true): value is string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > DRIVE_MAX_CONTENT_BYTES
  ) {
    return false;
  }
  return !value.includes('\0');
}

function withinContentLimit(value: string): boolean {
  return new TextEncoder().encode(value).byteLength <= DRIVE_MAX_CONTENT_BYTES;
}

function samePolicy(
  left: RecordPolicyMetadata,
  right: RecordPolicyMetadata,
): boolean {
  return (
    left.scope === right.scope &&
    left.sensitivity === right.sensitivity &&
    left.protectedClass === right.protectedClass
  );
}

function rootHash(root: DriveGovernedRoot): string {
  return hash(root.rootRef);
}

function operationProperties(
  current: Readonly<Record<string, string>>,
  operation: OperationId,
  kind: MutationKind,
  root: DriveGovernedRoot,
  contentHash: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...current,
    sim_g_managed: '1',
    sim_g_operation: driveOperationHash(operation),
    sim_g_operation_kind: kind,
    sim_g_root: rootHash(root),
    sim_g_content_sha256: contentHash,
  });
}

function markerMatches(
  file: DriveFileSnapshot,
  operation: OperationId,
  kind: MutationKind,
  root: DriveGovernedRoot,
): boolean {
  return (
    file.appProperties['sim_g_managed'] === '1' &&
    file.appProperties['sim_g_operation'] === driveOperationHash(operation) &&
    file.appProperties['sim_g_operation_kind'] === kind &&
    file.appProperties['sim_g_root'] === rootHash(root) &&
    /^[a-f0-9]{64}$/u.test(file.appProperties['sim_g_content_sha256'] ?? '')
  );
}

function mutableTarget(
  file: DriveFileSnapshot,
  root: DriveGovernedRoot,
): boolean {
  return (
    mutableMimeTypes.has(file.mimeType) &&
    file.appProperties['sim_g_managed'] === '1' &&
    file.appProperties['sim_g_root'] === rootHash(root) &&
    /^[a-f0-9]{64}$/u.test(file.appProperties['sim_g_content_sha256'] ?? '')
  );
}

function contentSizeTooLarge(file: DriveFileSnapshot): boolean {
  if (file.size === undefined) return false;
  try {
    return BigInt(file.size) > BigInt(DRIVE_MAX_CONTENT_BYTES);
  } catch {
    throw new DriveClientFailure('unavailable');
  }
}

function reference(file: DriveFileSnapshot, root: DriveGovernedRoot) {
  const summary = mapDriveSummary(file, root);
  return {
    provider: 'drive' as const,
    providerRecordId: summary.provenance.providerRecordId,
    providerVersion: driveProviderVersion(file),
    canonicalLocation: summary.canonicalLocation,
    ...(summary.provenance.integrityHash === undefined
      ? {}
      : { integrityHash: summary.provenance.integrityHash }),
  };
}

export class DriveKnowledgeProvider implements MutableKnowledgeProvider {
  readonly provider = 'drive' as const;
  readonly #client: DriveClient;
  readonly #guard: DriveRootGuard;

  constructor(client: DriveClient, options: DriveKnowledgeProviderOptions) {
    this.#client = client;
    this.#guard = new DriveRootGuard(client, options.roots);
  }

  async search(
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ): Promise<ProviderSearchResponse> {
    try {
      assertActive(signal);
      if (
        !validMetadata(request.query, 512) ||
        !Number.isInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > maxSearchLimit
      ) {
        throw invalidSearch();
      }
      const access = this.#guard.snapshotAccess(request.access);
      const records: BrainRecordSummary[] = [];
      const seen = new Set<string>();

      await this.walkFolders(access, signal, async (work, state) => {
        await this.pages(
          (pageToken) =>
            this.#client.searchChildFiles(
              {
                parentId: work.folderId,
                ...(work.root.sharedDriveId === undefined
                  ? {}
                  : { sharedDriveId: work.root.sharedDriveId }),
                query: request.query,
                pageSize,
                ...(pageToken === undefined ? {} : { pageToken }),
              },
              signal,
            ),
          state,
          async (file) => {
            const root = await this.#guard.resolveAuthorizedRoot(
              file,
              access,
              signal,
            );
            if (root === undefined || seen.has(file.id)) return true;
            seen.add(file.id);
            records.push(mapDriveSummary(file, root));
            return records.length < request.limit;
          },
        );
        return records.length < request.limit;
      });

      return {
        records,
        completeness: { provider: 'drive', state: 'complete' },
      };
    } catch (error) {
      throw this.safeReadError(error);
    }
  }

  async fetch(
    request: ProviderFetchRequest,
    signal: AbortSignal,
  ): Promise<BrainRecord> {
    try {
      assertActive(signal);
      const access = this.#guard.snapshotAccess(request.access);
      const file = await this.#client.getFile(request.providerRecordId, signal);
      const root = await this.#guard.resolveAuthorizedRoot(
        file,
        access,
        signal,
      );
      if (root === undefined) throw notFound();
      const content = await this.readContent(file, signal);
      return mapDriveRecord(file, root, content);
    } catch (error) {
      throw this.safeReadError(error);
    }
  }

  async create(
    request: RoutedCreate,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    assertActive(signal);
    try {
      const access = this.#guard.snapshotAccess(request.access);
      const root = this.#guard.rootForCreate(
        request.canonicalLocation.containerRef,
        access,
      );
      if (
        root === undefined ||
        request.canonicalLocation.provider !== 'drive' ||
        request.contentType !== 'text/markdown' ||
        !validMetadata(request.title, 1_024) ||
        !validContent(request.content) ||
        !withinContentLimit(request.content) ||
        !samePolicy(request.policy, root.policy)
      ) {
        throw invalidCreate();
      }
      await this.validateRoot(root, access, signal);
      if (
        (await this.findOperationFiles(request.operationId, access, signal))
          .length > 0
      ) {
        throw repeatedOperation();
      }

      const contentHash = hash(request.content);
      const marker = operationProperties(
        {},
        request.operationId,
        'create',
        root,
        contentHash,
      );
      await this.validateRoot(root, access, signal);
      let created: DriveFileSnapshot;
      try {
        created = await this.#client.createMarkdown(
          {
            parentId: root.folderId,
            name: request.title,
            content: request.content,
            appProperties: marker,
          },
          signal,
        );
      } catch (error) {
        return this.mutationFailure(error, request.operationId);
      }

      return await this.verifyMutation(
        created.id,
        request.operationId,
        'create',
        access,
        signal,
        { contentHash, title: request.title },
      );
    } catch (error) {
      throw this.safeMutationError(error);
    }
  }

  async update(
    request: RoutedUpdate,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    assertActive(signal);
    try {
      const access = this.#guard.snapshotAccess(request.access);
      const target = await this.loadManagedTarget(
        request.providerRecordId,
        request.operationId,
        request.expectedProviderVersion,
        access,
        signal,
      );
      const changes = this.applyUpdate(target, request.mutation);
      await this.refreshTarget(target, access, signal);
      const contentHash = hash(changes.content);
      const marker = operationProperties(
        target.file.appProperties,
        request.operationId,
        'update',
        target.root,
        contentHash,
      );
      try {
        await this.#client.updateTextFile(
          {
            fileId: target.file.id,
            ...(changes.title === target.file.name
              ? {}
              : { name: changes.title }),
            ...(changes.content === target.content
              ? {}
              : { content: changes.content }),
            mimeType: target.file.mimeType as 'text/plain' | 'text/markdown',
            appProperties: marker,
          },
          signal,
        );
      } catch (error) {
        return this.mutationFailure(error, request.operationId);
      }
      return await this.verifyMutation(
        target.file.id,
        request.operationId,
        'update',
        access,
        signal,
        { contentHash, title: changes.title },
      );
    } catch (error) {
      throw this.safeMutationError(error);
    }
  }

  async append(
    request: RoutedAppend,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    assertActive(signal);
    try {
      if (!validContent(request.content, false)) {
        throw invalidAppend();
      }
      const access = this.#guard.snapshotAccess(request.access);
      const target = await this.loadManagedTarget(
        request.providerRecordId,
        request.operationId,
        request.expectedProviderVersion,
        access,
        signal,
      );
      const content = `${target.content}${request.content}`;
      if (!withinContentLimit(content))
        throw unsupported('drive_content_too_large');
      await this.refreshTarget(target, access, signal);
      const contentHash = hash(content);
      const marker = operationProperties(
        target.file.appProperties,
        request.operationId,
        'append',
        target.root,
        contentHash,
      );
      try {
        await this.#client.updateTextFile(
          {
            fileId: target.file.id,
            content,
            mimeType: target.file.mimeType as 'text/plain' | 'text/markdown',
            appProperties: marker,
          },
          signal,
        );
      } catch (error) {
        return this.mutationFailure(error, request.operationId);
      }
      return await this.verifyMutation(
        target.file.id,
        request.operationId,
        'append',
        access,
        signal,
        { contentHash, title: target.file.name },
      );
    } catch (error) {
      throw this.safeMutationError(error);
    }
  }

  async trash(
    request: RoutedTrash,
    signal: AbortSignal,
  ): Promise<ProviderMutationResult> {
    assertActive(signal);
    try {
      const access = this.#guard.snapshotAccess(request.access);
      const target = await this.loadManagedTarget(
        request.providerRecordId,
        request.operationId,
        request.expectedProviderVersion,
        access,
        signal,
      );
      await this.refreshTarget(target, access, signal);
      const contentHash = hash(target.content);
      const marker = operationProperties(
        target.file.appProperties,
        request.operationId,
        'trash',
        target.root,
        contentHash,
      );
      try {
        await this.#client.trashFile(
          {
            fileId: target.file.id,
            appProperties: marker,
          },
          signal,
        );
      } catch (error) {
        return this.mutationFailure(error, request.operationId);
      }
      return await this.verifyMutation(
        target.file.id,
        request.operationId,
        'trash',
        access,
        signal,
        { contentHash, title: target.file.name },
      );
    } catch (error) {
      throw this.safeMutationError(error);
    }
  }

  async reconcile(
    request: ReconciliationRequest,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    assertActive(signal);
    let access: DriveAccessScope;
    try {
      access = this.#guard.snapshotAccess(request.access);
    } catch (error) {
      throw this.safeMutationError(error);
    }
    const expectedKey = reconciliationKey(request.operationId);
    if (
      request.reconciliationKey !== undefined &&
      request.reconciliationKey !== expectedKey
    ) {
      return { outcome: 'inconclusive' };
    }

    try {
      if (request.providerRecordId !== undefined) {
        const file = await this.#client.getFile(
          request.providerRecordId,
          signal,
        );
        const root = await this.#guard.resolveAuthorizedRoot(
          file,
          access,
          signal,
          { allowTrashed: request.operation === 'trash' },
        );
        if (root === undefined) return { outcome: 'not_found' };
        return await this.reconciledResult(file, root, request, signal);
      }

      if (request.operation !== 'create') return { outcome: 'inconclusive' };
      const matches = await this.findOperationFiles(
        request.operationId,
        access,
        signal,
      );
      if (matches.length === 0) return { outcome: 'not_found' };
      if (matches.length !== 1) return { outcome: 'inconclusive' };
      const match = matches[0];
      if (match === undefined) return { outcome: 'inconclusive' };
      return await this.reconciledResult(
        match.file,
        match.root,
        request,
        signal,
      );
    } catch (error) {
      if (isAbortError(error)) throw cancellation();
      if (error instanceof DomainError && error.code === 'unauthorized') {
        throw error;
      }
      if (error instanceof DriveClientFailure && error.kind === 'not_found') {
        return { outcome: 'not_found' };
      }
      return { outcome: 'inconclusive' };
    }
  }

  private async reconciledResult(
    file: DriveFileSnapshot,
    root: DriveGovernedRoot,
    request: ReconciliationRequest,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    if (
      !markerMatches(file, request.operationId, request.operation, root) ||
      (request.operation === 'trash' ? !file.trashed : file.trashed)
    ) {
      return { outcome: 'not_found' };
    }
    if (request.operation !== 'trash') await this.readContent(file, signal);
    return { outcome: 'completed', record: reference(file, root) };
  }

  private async loadManagedTarget(
    providerRecordId: string,
    operation: OperationId,
    expectedVersion: string | undefined,
    access: DriveAccessScope,
    signal: AbortSignal,
  ): Promise<ManagedTarget> {
    const file = await this.#client.getFile(providerRecordId, signal);
    const root = await this.#guard.resolveAuthorizedRoot(file, access, signal);
    if (root === undefined) throw notFound();
    if (
      file.appProperties['sim_g_operation'] === driveOperationHash(operation)
    ) {
      throw repeatedOperation();
    }
    if (
      expectedVersion !== undefined &&
      expectedVersion !== driveProviderVersion(file)
    ) {
      throw versionConflict();
    }
    if (!mutableTarget(file, root)) {
      throw unsupported('drive_record_not_mutable');
    }
    const content = await this.readContent(file, signal);
    return { file, root, content };
  }

  private async refreshTarget(
    target: ManagedTarget,
    access: DriveAccessScope,
    signal: AbortSignal,
  ): Promise<void> {
    const refreshed = await this.#client.getFile(target.file.id, signal);
    const root = await this.#guard.resolveAuthorizedRoot(
      refreshed,
      access,
      signal,
    );
    if (root === undefined || root.rootRef !== target.root.rootRef) {
      throw notFound();
    }
    if (
      driveProviderVersion(refreshed) !== driveProviderVersion(target.file) ||
      refreshed.appProperties['sim_g_content_sha256'] !==
        target.file.appProperties['sim_g_content_sha256'] ||
      !mutableTarget(refreshed, root)
    ) {
      throw versionConflict();
    }
  }

  private applyUpdate(
    target: ManagedTarget,
    mutation: UpdateMutation,
  ): { readonly title: string; readonly content: string } {
    let title = target.file.name;
    let content = target.content;
    if (mutation.mode === 'replace') {
      if (
        !validContent(mutation.replacement.content) ||
        !withinContentLimit(mutation.replacement.content) ||
        (mutation.replacement.title !== undefined &&
          !validMetadata(mutation.replacement.title, 1_024))
      ) {
        throw invalidUpdate();
      }
      title = mutation.replacement.title ?? title;
      content = mutation.replacement.content;
    } else {
      const keys = Object.keys(mutation.patch);
      const hasTitle = Object.hasOwn(mutation.patch, 'title');
      const hasContent = Object.hasOwn(mutation.patch, 'content');
      const titleValue = mutation.patch['title'];
      const contentValue = mutation.patch['content'];
      if (
        keys.length === 0 ||
        keys.some((key) => key !== 'title' && key !== 'content') ||
        (!hasTitle && !hasContent) ||
        (hasTitle && !validMetadata(titleValue, 1_024)) ||
        (hasContent &&
          (!validContent(contentValue) || !withinContentLimit(contentValue)))
      ) {
        throw invalidUpdate();
      }
      if (typeof titleValue === 'string') {
        title = titleValue;
      }
      if (typeof contentValue === 'string') {
        content = contentValue;
      }
    }
    return { title, content };
  }

  private async readContent(
    file: DriveFileSnapshot,
    signal: AbortSignal,
  ): Promise<string> {
    if (contentSizeTooLarge(file)) throw unsupported('drive_content_too_large');
    let bytes: Uint8Array;
    try {
      if (file.mimeType === DRIVE_GOOGLE_DOC_MIME_TYPE) {
        bytes = await this.#client.exportGoogleDocument(
          file.id,
          DRIVE_MAX_CONTENT_BYTES,
          signal,
        );
      } else if (readableMimeTypes.has(file.mimeType)) {
        bytes = await this.#client.downloadFile(
          file.id,
          DRIVE_MAX_CONTENT_BYTES,
          signal,
        );
      } else {
        throw unsupported('drive_mime_type_not_readable');
      }
    } catch (error) {
      if (error instanceof DriveClientFailure && error.kind === 'too_large') {
        throw unsupported('drive_content_too_large');
      }
      throw error;
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      throw unavailable('drive_content_invalid_utf8');
    }
    const actualHash = hash(content);
    const managedHash = file.appProperties['sim_g_content_sha256'];
    if (
      (managedHash !== undefined && managedHash !== actualHash) ||
      (file.sha256Checksum !== undefined &&
        /^[a-f0-9]{64}$/u.test(file.sha256Checksum) &&
        file.sha256Checksum !== actualHash)
    ) {
      throw unavailable('drive_integrity_mismatch');
    }
    return content;
  }

  private async validateRoot(
    root: DriveGovernedRoot,
    access: DriveAccessScope,
    signal: AbortSignal,
  ): Promise<void> {
    const folder = await this.#client.getFile(root.folderId, signal);
    const resolved = await this.#guard.resolveAuthorizedRoot(
      folder,
      access,
      signal,
    );
    if (
      folder.mimeType !== DRIVE_FOLDER_MIME_TYPE ||
      folder.trashed ||
      resolved?.rootRef !== root.rootRef
    ) {
      throw new DriveClientFailure('unavailable');
    }
  }

  private async walkFolders(
    access: DriveAccessScope,
    signal: AbortSignal,
    visit: (work: FolderWork, state: TraversalState) => Promise<boolean>,
  ): Promise<void> {
    const roots = this.#guard.authorizedRoots(access);
    const queue: FolderWork[] = [];
    for (const root of roots) {
      await this.validateRoot(root, access, signal);
      queue.push({ folderId: root.folderId, root });
    }
    const visited = new Set<string>();
    const state: TraversalState = { folders: 0, requests: 0, files: 0 };

    while (queue.length > 0) {
      assertActive(signal);
      const work = queue.shift();
      if (work === undefined) break;
      if (visited.has(work.folderId)) continue;
      visited.add(work.folderId);
      state.folders += 1;
      if (state.folders > maxTraversalFolders) {
        throw new DriveClientFailure('unavailable');
      }
      if (!(await visit(work, state))) return;

      const children: FolderWork[] = [];
      await this.pages(
        (pageToken) =>
          this.#client.listChildFolders(
            {
              parentId: work.folderId,
              ...(work.root.sharedDriveId === undefined
                ? {}
                : { sharedDriveId: work.root.sharedDriveId }),
              pageSize,
              ...(pageToken === undefined ? {} : { pageToken }),
            },
            signal,
          ),
        state,
        async (folder) => {
          const root = await this.#guard.resolveAuthorizedRoot(
            folder,
            access,
            signal,
          );
          if (root !== undefined) {
            children.push({ folderId: folder.id, root });
          }
          return true;
        },
      );
      queue.push(...children);
    }
  }

  private async pages(
    fetchPage: (pageToken: string | undefined) => Promise<DriveFilePage>,
    state: TraversalState,
    visit: (file: DriveFileSnapshot) => Promise<boolean>,
  ): Promise<void> {
    const tokens = new Set<string>();
    let token: string | undefined;
    do {
      state.requests += 1;
      if (state.requests > maxListRequests) {
        throw new DriveClientFailure('unavailable');
      }
      const page = await fetchPage(token);
      for (const file of page.files) {
        state.files += 1;
        if (state.files > maxListedFiles) {
          throw new DriveClientFailure('unavailable');
        }
        if (!(await visit(file))) return;
      }
      token = page.nextPageToken;
      if (token !== undefined) {
        if (tokens.has(token)) throw new DriveClientFailure('unavailable');
        tokens.add(token);
      }
    } while (token !== undefined);
  }

  private async findOperationFiles(
    operation: OperationId,
    access: DriveAccessScope,
    signal: AbortSignal,
  ): Promise<readonly { file: DriveFileSnapshot; root: DriveGovernedRoot }[]> {
    const matches: Array<{
      file: DriveFileSnapshot;
      root: DriveGovernedRoot;
    }> = [];
    const seen = new Set<string>();
    await this.walkFolders(access, signal, async (work, state) => {
      await this.pages(
        (pageToken) =>
          this.#client.findChildFilesByOperation(
            {
              parentId: work.folderId,
              ...(work.root.sharedDriveId === undefined
                ? {}
                : { sharedDriveId: work.root.sharedDriveId }),
              operationHash: driveOperationHash(operation),
              pageSize,
              ...(pageToken === undefined ? {} : { pageToken }),
            },
            signal,
          ),
        state,
        async (file) => {
          if (seen.has(file.id)) return true;
          const root = await this.#guard.resolveAuthorizedRoot(
            file,
            access,
            signal,
          );
          if (root !== undefined) {
            seen.add(file.id);
            matches.push({ file, root });
          }
          return matches.length < 2;
        },
      );
      return matches.length < 2;
    });
    return Object.freeze(matches);
  }

  private async verifyMutation(
    fileId: string,
    operation: OperationId,
    kind: MutationKind,
    access: DriveAccessScope,
    signal: AbortSignal,
    expected: { readonly contentHash: string; readonly title: string },
  ): Promise<ProviderMutationResult> {
    try {
      const file = await this.#client.getFile(fileId, signal);
      const root = await this.#guard.resolveAuthorizedRoot(
        file,
        access,
        signal,
        { allowTrashed: kind === 'trash' },
      );
      if (
        root === undefined ||
        file.name !== expected.title ||
        !markerMatches(file, operation, kind, root) ||
        file.appProperties['sim_g_content_sha256'] !== expected.contentHash ||
        (kind === 'trash' ? !file.trashed : file.trashed)
      ) {
        return {
          outcome: 'unknown',
          reconciliationKey: reconciliationKey(operation),
        };
      }
      if (kind !== 'trash') {
        const content = await this.readContent(file, signal);
        if (hash(content) !== expected.contentHash) {
          return {
            outcome: 'unknown',
            reconciliationKey: reconciliationKey(operation),
          };
        }
      }
      return { outcome: 'completed', record: reference(file, root) };
    } catch {
      return {
        outcome: 'unknown',
        reconciliationKey: reconciliationKey(operation),
      };
    }
  }

  private mutationFailure(
    error: unknown,
    operation: OperationId,
  ): ProviderMutationResult {
    if (
      isAbortError(error) ||
      (error instanceof DriveClientFailure && error.kind === 'outcome_unknown')
    ) {
      return {
        outcome: 'unknown',
        reconciliationKey: reconciliationKey(operation),
      };
    }
    throw error;
  }

  private safeReadError(error: unknown): unknown {
    if (error instanceof DomainError) return error;
    if (isAbortError(error)) return cancellation();
    if (error instanceof DriveClientFailure) {
      if (error.kind === 'not_found') return notFound();
      if (error.kind === 'too_large') {
        return unsupported('drive_content_too_large');
      }
    }
    return unavailable();
  }

  private safeMutationError(error: unknown): unknown {
    if (error instanceof DomainError) return error;
    if (isAbortError(error)) return cancellation();
    if (error instanceof DriveClientFailure) {
      if (error.kind === 'not_found') return notFound();
      if (error.kind === 'version_conflict') return versionConflict();
      if (error.kind === 'too_large') {
        return unsupported('drive_content_too_large');
      }
    }
    return unavailable();
  }
}
