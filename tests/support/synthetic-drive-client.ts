import {
  DriveClientFailure,
  type DriveClient,
  type DriveCreateRequest,
  type DriveFilePage,
  type DriveFileSnapshot,
  type DriveFolderListRequest,
  type DriveOperationListRequest,
  type DriveSearchListRequest,
  type DriveTrashRequest,
  type DriveUpdateRequest,
} from '../../src/adapters/drive/drive-client.js';

export interface SyntheticDriveFile {
  readonly metadata: DriveFileSnapshot;
  readonly content?: Uint8Array | string;
  readonly exportedContent?: Uint8Array | string;
}

export interface SyntheticDriveClientOptions {
  readonly pageSizeCap?: number;
  readonly unknownOperationHashes?: readonly string[];
  readonly onOperationList?: (
    count: number,
    client: SyntheticDriveClient,
  ) => void;
  readonly onGet?: (
    fileId: string,
    count: number,
    client: SyntheticDriveClient,
  ) => void;
}

function cloneProperties(
  properties: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze({ ...properties });
}

function cloneFile(file: DriveFileSnapshot): DriveFileSnapshot {
  return Object.freeze({
    ...file,
    parents: Object.freeze([...file.parents]),
    appProperties: cloneProperties(file.appProperties),
  });
}

function bytes(content: Uint8Array | string | undefined): Uint8Array {
  if (content === undefined) return new Uint8Array();
  return typeof content === 'string'
    ? new TextEncoder().encode(content)
    : new Uint8Array(content);
}

function cancelled(): DOMException {
  return new DOMException('Provider operation cancelled', 'AbortError');
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}

function page<T>(
  values: readonly T[],
  requestedSize: number,
  token: string | undefined,
  cap: number,
): { readonly values: readonly T[]; readonly nextPageToken?: string } {
  const offset = token === undefined ? 0 : Number.parseInt(token, 10);
  const size = Math.min(requestedSize, cap);
  const selected = values.slice(offset, offset + size);
  const next = offset + selected.length;
  return {
    values: selected,
    ...(next < values.length ? { nextPageToken: String(next) } : {}),
  };
}

export class SyntheticDriveClient implements DriveClient {
  readonly folderListCalls: DriveFolderListRequest[] = [];
  readonly searchCalls: DriveSearchListRequest[] = [];
  readonly operationListCalls: DriveOperationListRequest[] = [];
  readonly getCalls: string[] = [];
  readonly downloadCalls: string[] = [];
  readonly exportCalls: string[] = [];
  readonly createCalls: DriveCreateRequest[] = [];
  readonly updateCalls: DriveUpdateRequest[] = [];
  readonly trashCalls: DriveTrashRequest[] = [];
  readonly #files = new Map<string, DriveFileSnapshot>();
  readonly #contents = new Map<string, Uint8Array>();
  readonly #exports = new Map<string, Uint8Array>();
  readonly #getCounts = new Map<string, number>();
  readonly #options: SyntheticDriveClientOptions;
  #operationListCount = 0;
  #nextId = 1;

  constructor(
    files: readonly SyntheticDriveFile[],
    options: SyntheticDriveClientOptions = {},
  ) {
    this.#options = options;
    for (const entry of files) {
      this.#files.set(entry.metadata.id, cloneFile(entry.metadata));
      if (entry.content !== undefined) {
        this.#contents.set(entry.metadata.id, bytes(entry.content));
      }
      if (entry.exportedContent !== undefined) {
        this.#exports.set(entry.metadata.id, bytes(entry.exportedContent));
      }
    }
  }

  replaceFile(file: DriveFileSnapshot, content?: Uint8Array | string): void {
    this.#files.set(file.id, cloneFile(file));
    if (content !== undefined) this.#contents.set(file.id, bytes(content));
  }

  file(fileId: string): DriveFileSnapshot | undefined {
    const found = this.#files.get(fileId);
    return found === undefined ? undefined : cloneFile(found);
  }

  async listChildFolders(
    request: DriveFolderListRequest,
    signal: AbortSignal,
  ): Promise<DriveFilePage> {
    await Promise.resolve();
    assertActive(signal);
    this.folderListCalls.push({ ...request });
    const matching = this.children(request.parentId, request.sharedDriveId)
      .filter(
        (entry) =>
          !entry.trashed &&
          entry.mimeType === 'application/vnd.google-apps.folder',
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    return this.paged(matching, request);
  }

  async searchChildFiles(
    request: DriveSearchListRequest,
    signal: AbortSignal,
  ): Promise<DriveFilePage> {
    await Promise.resolve();
    assertActive(signal);
    this.searchCalls.push({ ...request });
    const query = request.query.toLocaleLowerCase();
    const matching = this.children(request.parentId, request.sharedDriveId)
      .filter(
        (entry) =>
          !entry.trashed &&
          entry.mimeType !== 'application/vnd.google-apps.folder',
      )
      .filter((entry) => {
        const body = new TextDecoder().decode(
          this.#contents.get(entry.id) ?? this.#exports.get(entry.id),
        );
        return [entry.name, entry.description ?? '', body]
          .join('\n')
          .toLocaleLowerCase()
          .includes(query);
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    return this.paged(matching, request);
  }

  async findChildFilesByOperation(
    request: DriveOperationListRequest,
    signal: AbortSignal,
  ): Promise<DriveFilePage> {
    await Promise.resolve();
    assertActive(signal);
    this.operationListCalls.push({ ...request });
    this.#operationListCount += 1;
    this.#options.onOperationList?.(this.#operationListCount, this);
    const matching = this.children(request.parentId, request.sharedDriveId)
      .filter(
        (entry) =>
          !entry.trashed &&
          entry.mimeType !== 'application/vnd.google-apps.folder' &&
          entry.appProperties['sim_g_operation'] === request.operationHash,
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    return this.paged(matching, request);
  }

  async getFile(
    fileId: string,
    signal: AbortSignal,
  ): Promise<DriveFileSnapshot> {
    await Promise.resolve();
    assertActive(signal);
    this.getCalls.push(fileId);
    const count = (this.#getCounts.get(fileId) ?? 0) + 1;
    this.#getCounts.set(fileId, count);
    this.#options.onGet?.(fileId, count, this);
    const found = this.#files.get(fileId);
    if (found === undefined) throw new DriveClientFailure('not_found');
    return cloneFile(found);
  }

  async downloadFile(
    fileId: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    await Promise.resolve();
    assertActive(signal);
    this.downloadCalls.push(fileId);
    const found = this.#contents.get(fileId);
    if (found === undefined) throw new DriveClientFailure('not_found');
    if (found.byteLength > maxBytes) throw new DriveClientFailure('too_large');
    return new Uint8Array(found);
  }

  async exportGoogleDocument(
    fileId: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    await Promise.resolve();
    assertActive(signal);
    this.exportCalls.push(fileId);
    const found = this.#exports.get(fileId);
    if (found === undefined) throw new DriveClientFailure('not_found');
    if (found.byteLength > maxBytes) throw new DriveClientFailure('too_large');
    return new Uint8Array(found);
  }

  async createMarkdown(
    request: DriveCreateRequest,
    signal: AbortSignal,
  ): Promise<DriveFileSnapshot> {
    await Promise.resolve();
    assertActive(signal);
    this.createCalls.push({
      ...request,
      appProperties: { ...request.appProperties },
    });
    const id = `created-drive-file-${String(this.#nextId)}`;
    this.#nextId += 1;
    const sharedDriveId = this.#files.get(request.parentId)?.sharedDriveId;
    const metadata: DriveFileSnapshot = {
      id,
      name: request.name,
      mimeType: 'text/markdown',
      parents: [request.parentId],
      ...(sharedDriveId === undefined ? {} : { sharedDriveId }),
      createdTime: '2042-01-04T05:06:07.000Z',
      modifiedTime: '2042-01-04T05:06:07.000Z',
      version: '1',
      headRevisionId: 'revision-1',
      trashed: false,
      size: String(new TextEncoder().encode(request.content).byteLength),
      appProperties: { ...request.appProperties },
    };
    this.#files.set(id, cloneFile(metadata));
    this.#contents.set(id, bytes(request.content));
    if (
      this.#options.unknownOperationHashes?.includes(
        request.appProperties['sim_g_operation'] ?? '',
      ) === true
    ) {
      throw new DriveClientFailure('outcome_unknown');
    }
    return cloneFile(metadata);
  }

  async updateTextFile(
    request: DriveUpdateRequest,
    signal: AbortSignal,
  ): Promise<DriveFileSnapshot> {
    await Promise.resolve();
    assertActive(signal);
    this.updateCalls.push({
      ...request,
      appProperties: { ...request.appProperties },
    });
    const current = this.#files.get(request.fileId);
    if (current === undefined || current.trashed) {
      throw new DriveClientFailure('not_found');
    }
    const version = String(Number.parseInt(current.version, 10) + 1);
    const content =
      request.content === undefined
        ? this.#contents.get(request.fileId)
        : bytes(request.content);
    const updated: DriveFileSnapshot = {
      ...current,
      ...(request.name === undefined ? {} : { name: request.name }),
      modifiedTime: '2042-01-04T05:06:08.000Z',
      version,
      headRevisionId: `revision-${version}`,
      ...(content === undefined ? {} : { size: String(content.byteLength) }),
      appProperties: { ...request.appProperties },
    };
    this.#files.set(request.fileId, cloneFile(updated));
    if (content !== undefined) this.#contents.set(request.fileId, content);
    if (
      this.#options.unknownOperationHashes?.includes(
        request.appProperties['sim_g_operation'] ?? '',
      ) === true
    ) {
      throw new DriveClientFailure('outcome_unknown');
    }
    return cloneFile(updated);
  }

  async trashFile(
    request: DriveTrashRequest,
    signal: AbortSignal,
  ): Promise<DriveFileSnapshot> {
    await Promise.resolve();
    assertActive(signal);
    this.trashCalls.push({
      ...request,
      appProperties: { ...request.appProperties },
    });
    const current = this.#files.get(request.fileId);
    if (current === undefined) throw new DriveClientFailure('not_found');
    const version = String(Number.parseInt(current.version, 10) + 1);
    const trashed: DriveFileSnapshot = {
      ...current,
      modifiedTime: '2042-01-04T05:06:09.000Z',
      version,
      trashed: true,
      appProperties: { ...request.appProperties },
    };
    this.#files.set(request.fileId, cloneFile(trashed));
    if (
      this.#options.unknownOperationHashes?.includes(
        request.appProperties['sim_g_operation'] ?? '',
      ) === true
    ) {
      throw new DriveClientFailure('outcome_unknown');
    }
    return cloneFile(trashed);
  }

  private children(
    parentId: string,
    sharedDriveId: string | undefined,
  ): DriveFileSnapshot[] {
    return [...this.#files.values()].filter(
      (entry) =>
        entry.parents.includes(parentId) &&
        entry.sharedDriveId === sharedDriveId,
    );
  }

  private paged(
    values: readonly DriveFileSnapshot[],
    request: { readonly pageSize: number; readonly pageToken?: string },
  ): DriveFilePage {
    const result = page(
      values,
      request.pageSize,
      request.pageToken,
      this.#options.pageSizeCap ?? Number.POSITIVE_INFINITY,
    );
    return {
      files: result.values.map(cloneFile),
      ...(result.nextPageToken === undefined
        ? {}
        : { nextPageToken: result.nextPageToken }),
    };
  }
}
