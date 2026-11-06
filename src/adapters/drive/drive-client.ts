import { drive, type MethodOptions, type drive_v3 } from '@googleapis/drive';

export const DRIVE_API_VERSION = 'v3' as const;
export const DRIVE_CLIENT_TIMEOUT_MS = 5_000;
export const DRIVE_MAX_CONTENT_BYTES = 5 * 1024 * 1024;
export const DRIVE_FOLDER_MIME_TYPE =
  'application/vnd.google-apps.folder' as const;
export const DRIVE_GOOGLE_DOC_MIME_TYPE =
  'application/vnd.google-apps.document' as const;

const fileFields = [
  'id',
  'name',
  'mimeType',
  'parents',
  'driveId',
  'createdTime',
  'modifiedTime',
  'version',
  'headRevisionId',
  'trashed',
  'size',
  'sha256Checksum',
  'description',
  'appProperties',
].join(',');
const listFields = `nextPageToken,files(${fileFields})`;

type DriveAuth = Exclude<drive_v3.Options['auth'], string | undefined>;

export interface CreateOfficialDriveSdkClientOptions {
  readonly auth: DriveAuth;
  /** Test/composition seam; production normally uses the SDK's global fetch. */
  readonly fetchImplementation?: typeof fetch;
}

interface DriveSdkResponse {
  readonly data: unknown;
}

type DriveSdkMethod<Params> = (
  params: Params,
  options?: MethodOptions,
) => Promise<DriveSdkResponse>;

export interface DriveSdkClient {
  readonly apiVersion: typeof DRIVE_API_VERSION;
  readonly files: {
    readonly list: DriveSdkMethod<drive_v3.Params$Resource$Files$List>;
    readonly get: DriveSdkMethod<drive_v3.Params$Resource$Files$Get>;
    readonly export: DriveSdkMethod<drive_v3.Params$Resource$Files$Export>;
    readonly create: DriveSdkMethod<drive_v3.Params$Resource$Files$Create>;
    readonly update: DriveSdkMethod<drive_v3.Params$Resource$Files$Update>;
  };
}

export interface DriveFileSnapshot {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly parents: readonly string[];
  readonly sharedDriveId?: string;
  readonly createdTime: string;
  readonly modifiedTime: string;
  readonly version: string;
  readonly headRevisionId?: string;
  readonly trashed: boolean;
  readonly size?: string;
  readonly sha256Checksum?: string;
  readonly description?: string;
  readonly appProperties: Readonly<Record<string, string>>;
}

export interface DriveFilePage {
  readonly files: readonly DriveFileSnapshot[];
  readonly nextPageToken?: string;
}

interface DriveFolderBoundRequest {
  readonly parentId: string;
  readonly sharedDriveId?: string;
  readonly pageSize: number;
  readonly pageToken?: string;
}

export type DriveFolderListRequest = DriveFolderBoundRequest;

export interface DriveSearchListRequest extends DriveFolderBoundRequest {
  readonly query: string;
}

export interface DriveOperationListRequest extends DriveFolderBoundRequest {
  readonly operationHash: string;
}

export interface DriveCreateRequest {
  readonly parentId: string;
  readonly name: string;
  readonly content: string;
  readonly appProperties: Readonly<Record<string, string>>;
}

export interface DriveUpdateRequest {
  readonly fileId: string;
  readonly name?: string;
  readonly content?: string;
  readonly mimeType: 'text/plain' | 'text/markdown';
  readonly appProperties: Readonly<Record<string, string>>;
}

export interface DriveTrashRequest {
  readonly fileId: string;
  readonly appProperties: Readonly<Record<string, string>>;
}

export interface DriveClient {
  listChildFolders(
    request: DriveFolderListRequest,
    signal: AbortSignal,
  ): Promise<DriveFilePage>;
  searchChildFiles(
    request: DriveSearchListRequest,
    signal: AbortSignal,
  ): Promise<DriveFilePage>;
  findChildFilesByOperation(
    request: DriveOperationListRequest,
    signal: AbortSignal,
  ): Promise<DriveFilePage>;
  getFile(fileId: string, signal: AbortSignal): Promise<DriveFileSnapshot>;
  downloadFile(
    fileId: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  exportGoogleDocument(
    fileId: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  createMarkdown(
    request: DriveCreateRequest,
    signal: AbortSignal,
  ): Promise<DriveFileSnapshot>;
  updateTextFile(
    request: DriveUpdateRequest,
    signal: AbortSignal,
  ): Promise<DriveFileSnapshot>;
  trashFile(
    request: DriveTrashRequest,
    signal: AbortSignal,
  ): Promise<DriveFileSnapshot>;
}

export type DriveClientFailureKind =
  | 'not_found'
  | 'version_conflict'
  | 'too_large'
  | 'unavailable'
  | 'outcome_unknown';

export class DriveClientFailure extends Error {
  readonly kind: DriveClientFailureKind;

  constructor(kind: DriveClientFailureKind) {
    super('drive_client_failure');
    this.name = 'DriveClientFailure';
    this.kind = kind;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, maxLength = 1_024): value is string {
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

function optionalSafeString(
  value: unknown,
  maxLength = 1_024,
): value is string | undefined {
  return value === undefined || value === null || safeString(value, maxLength);
}

function optionalStringArray(
  value: unknown,
): value is readonly string[] | undefined | null {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) &&
      value.length <= 2 &&
      value.every((item: unknown) => safeString(item, 512)))
  );
}

function copyAppProperties(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return Object.freeze({});
  if (!isRecord(value) || Object.keys(value).length > 30) {
    throw new DriveClientFailure('unavailable');
  }
  const result: Record<string, string> = {};
  for (const [key, property] of Object.entries(value)) {
    if (!safeString(key, 64) || !safeString(property, 512)) {
      throw new DriveClientFailure('unavailable');
    }
    result[key] = property;
  }
  return Object.freeze(result);
}

function projectFile(value: unknown): DriveFileSnapshot {
  if (
    !isRecord(value) ||
    !safeString(value['id'], 512) ||
    !safeString(value['name'], 1_024) ||
    !safeString(value['mimeType'], 255) ||
    !optionalStringArray(value['parents']) ||
    !optionalSafeString(value['driveId'], 512) ||
    !safeString(value['createdTime'], 64) ||
    !safeString(value['modifiedTime'], 64) ||
    !safeString(value['version'], 64) ||
    !optionalSafeString(value['headRevisionId'], 512) ||
    typeof value['trashed'] !== 'boolean' ||
    !optionalSafeString(value['size'], 32) ||
    !optionalSafeString(value['sha256Checksum'], 128) ||
    !optionalSafeString(value['description'], 4_096)
  ) {
    throw new DriveClientFailure('unavailable');
  }
  if (
    !Number.isFinite(new Date(value['createdTime']).getTime()) ||
    !Number.isFinite(new Date(value['modifiedTime']).getTime()) ||
    !/^\d+$/u.test(value['version']) ||
    (typeof value['size'] === 'string' && !/^\d+$/u.test(value['size']))
  ) {
    throw new DriveClientFailure('unavailable');
  }
  const rawParents: unknown = value['parents'];
  const parents = Array.isArray(rawParents)
    ? rawParents.map((parent: unknown) => {
        if (typeof parent !== 'string') {
          throw new DriveClientFailure('unavailable');
        }
        return parent;
      })
    : [];

  return Object.freeze({
    id: value['id'],
    name: value['name'],
    mimeType: value['mimeType'],
    parents: Object.freeze(parents),
    ...(typeof value['driveId'] === 'string'
      ? { sharedDriveId: value['driveId'] }
      : {}),
    createdTime: value['createdTime'],
    modifiedTime: value['modifiedTime'],
    version: value['version'],
    ...(typeof value['headRevisionId'] === 'string'
      ? { headRevisionId: value['headRevisionId'] }
      : {}),
    trashed: value['trashed'],
    ...(typeof value['size'] === 'string' ? { size: value['size'] } : {}),
    ...(typeof value['sha256Checksum'] === 'string'
      ? { sha256Checksum: value['sha256Checksum'] }
      : {}),
    ...(typeof value['description'] === 'string'
      ? { description: value['description'] }
      : {}),
    appProperties: copyAppProperties(value['appProperties']),
  });
}

function projectPage(value: unknown): DriveFilePage {
  if (
    !isRecord(value) ||
    (value['files'] !== undefined &&
      value['files'] !== null &&
      !Array.isArray(value['files']))
  ) {
    throw new DriveClientFailure('unavailable');
  }
  const next = value['nextPageToken'];
  if (!optionalSafeString(next, 2_048)) {
    throw new DriveClientFailure('unavailable');
  }
  return Object.freeze({
    files: Object.freeze(
      Array.isArray(value['files']) ? value['files'].map(projectFile) : [],
    ),
    ...(typeof next === 'string' ? { nextPageToken: next } : {}),
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

function statusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error['status'] === 'number') return error['status'];
  const response = error['response'];
  return isRecord(response) && typeof response['status'] === 'number'
    ? response['status']
    : undefined;
}

function mapReadFailure(error: unknown): unknown {
  if (isAbortError(error)) return cancellation();
  if (error instanceof DriveClientFailure) return error;
  const status = statusCode(error);
  if (status === 404) return new DriveClientFailure('not_found');
  if (status === 413) return new DriveClientFailure('too_large');
  return new DriveClientFailure('unavailable');
}

function mapMutationFailure(error: unknown): unknown {
  if (isAbortError(error)) return cancellation();
  if (error instanceof DriveClientFailure) return error;
  const status = statusCode(error);
  if (status === 404) return new DriveClientFailure('not_found');
  if (status === 409 || status === 412) {
    return new DriveClientFailure('version_conflict');
  }
  return new DriveClientFailure('outcome_unknown');
}

function escapeQueryValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function validateBoundRequest(request: DriveFolderBoundRequest): void {
  if (
    !safeString(request.parentId, 512) ||
    !optionalSafeString(request.sharedDriveId, 512) ||
    !Number.isInteger(request.pageSize) ||
    request.pageSize < 1 ||
    request.pageSize > 1_000 ||
    !optionalSafeString(request.pageToken, 2_048)
  ) {
    throw new DriveClientFailure('unavailable');
  }
}

// Drive rejects orderBy on fullText queries; they return in relevance order.
function listParams(
  request: DriveFolderBoundRequest,
  query: string,
  ordered = true,
): drive_v3.Params$Resource$Files$List {
  validateBoundRequest(request);
  return {
    q: query,
    spaces: 'drive',
    corpora: request.sharedDriveId === undefined ? 'user' : 'drive',
    ...(request.sharedDriveId === undefined
      ? {}
      : { driveId: request.sharedDriveId }),
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: request.pageSize,
    ...(request.pageToken === undefined
      ? {}
      : { pageToken: request.pageToken }),
    ...(ordered ? { orderBy: 'name_natural' } : {}),
    fields: listFields,
  };
}

function toBytes(value: unknown, maxBytes: number): Uint8Array {
  let result: Uint8Array;
  if (typeof value === 'string') {
    result = new TextEncoder().encode(value);
  } else if (value instanceof ArrayBuffer) {
    result = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    result = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new DriveClientFailure('unavailable');
  }
  if (result.byteLength > maxBytes) throw new DriveClientFailure('too_large');
  return new Uint8Array(result);
}

/** Constructs only the official Drive methods required by the governed adapter. */
export function createOfficialDriveSdkClient(
  options: CreateOfficialDriveSdkClientOptions,
): DriveSdkClient {
  const candidate: unknown = options;
  if (
    !isRecord(candidate) ||
    !isRecord(candidate['auth']) ||
    (candidate['fetchImplementation'] !== undefined &&
      typeof candidate['fetchImplementation'] !== 'function')
  ) {
    throw new TypeError('invalid_drive_client_configuration');
  }
  const client = drive({
    version: DRIVE_API_VERSION,
    auth: options.auth,
    timeout: DRIVE_CLIENT_TIMEOUT_MS,
    retry: false,
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation }),
  });

  return Object.freeze({
    apiVersion: DRIVE_API_VERSION,
    files: Object.freeze({
      list: async (
        params: drive_v3.Params$Resource$Files$List,
        methodOptions?: MethodOptions,
      ) => (await client.files.list(params, methodOptions)) as DriveSdkResponse,
      get: async (
        params: drive_v3.Params$Resource$Files$Get,
        methodOptions?: MethodOptions,
      ) => (await client.files.get(params, methodOptions)) as DriveSdkResponse,
      export: async (
        params: drive_v3.Params$Resource$Files$Export,
        methodOptions?: MethodOptions,
      ) =>
        (await client.files.export(params, methodOptions)) as DriveSdkResponse,
      create: async (
        params: drive_v3.Params$Resource$Files$Create,
        methodOptions?: MethodOptions,
      ) =>
        (await client.files.create(params, methodOptions)) as DriveSdkResponse,
      update: async (
        params: drive_v3.Params$Resource$Files$Update,
        methodOptions?: MethodOptions,
      ) =>
        (await client.files.update(params, methodOptions)) as DriveSdkResponse,
    }),
  });
}

export class OfficialDriveClient implements DriveClient {
  readonly #sdk: DriveSdkClient;

  constructor(sdk: DriveSdkClient) {
    const candidate = sdk as unknown as { readonly apiVersion?: unknown };
    if (candidate.apiVersion !== DRIVE_API_VERSION) {
      throw new TypeError('invalid_drive_client_configuration');
    }
    this.#sdk = sdk;
  }

  listChildFolders(
    request: DriveFolderListRequest,
    signal: AbortSignal,
  ): Promise<DriveFilePage> {
    const parent = escapeQueryValue(request.parentId);
    return this.list(
      listParams(
        request,
        `'${parent}' in parents and trashed = false and mimeType = '${DRIVE_FOLDER_MIME_TYPE}'`,
      ),
      signal,
    );
  }

  searchChildFiles(
    request: DriveSearchListRequest,
    signal: AbortSignal,
  ): Promise<DriveFilePage> {
    if (!safeString(request.query, 512)) {
      return Promise.reject(new DriveClientFailure('unavailable'));
    }
    const parent = escapeQueryValue(request.parentId);
    const query = escapeQueryValue(request.query);
    return this.list(
      listParams(
        request,
        `'${parent}' in parents and trashed = false and mimeType != '${DRIVE_FOLDER_MIME_TYPE}' and (name contains '${query}' or fullText contains '${query}')`,
        false,
      ),
      signal,
    );
  }

  findChildFilesByOperation(
    request: DriveOperationListRequest,
    signal: AbortSignal,
  ): Promise<DriveFilePage> {
    if (!/^[a-f0-9]{64}$/u.test(request.operationHash)) {
      return Promise.reject(new DriveClientFailure('unavailable'));
    }
    const parent = escapeQueryValue(request.parentId);
    return this.list(
      listParams(
        request,
        `'${parent}' in parents and trashed = false and mimeType != '${DRIVE_FOLDER_MIME_TYPE}' and appProperties has { key='sim_g_operation' and value='${request.operationHash}' }`,
      ),
      signal,
    );
  }

  async getFile(
    fileId: string,
    signal: AbortSignal,
  ): Promise<DriveFileSnapshot> {
    try {
      assertActive(signal);
      const response = await this.#sdk.files.get(
        { fileId, supportsAllDrives: true, fields: fileFields },
        { signal },
      );
      assertActive(signal);
      return projectFile(response.data);
    } catch (error) {
      throw mapReadFailure(error);
    }
  }

  downloadFile(
    fileId: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return this.readBytes(
      () =>
        this.#sdk.files.get(
          { fileId, supportsAllDrives: true, alt: 'media' },
          { responseType: 'arraybuffer', maxContentLength: maxBytes, signal },
        ),
      maxBytes,
      signal,
    );
  }

  exportGoogleDocument(
    fileId: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return this.readBytes(
      () =>
        this.#sdk.files.export(
          { fileId, mimeType: 'text/plain' },
          { responseType: 'arraybuffer', maxContentLength: maxBytes, signal },
        ),
      maxBytes,
      signal,
    );
  }

  createMarkdown(
    request: DriveCreateRequest,
    signal: AbortSignal,
  ): Promise<DriveFileSnapshot> {
    return this.mutate(
      () =>
        this.#sdk.files.create(
          {
            supportsAllDrives: true,
            useContentAsIndexableText: true,
            fields: fileFields,
            requestBody: {
              name: request.name,
              mimeType: 'text/markdown',
              parents: [request.parentId],
              appProperties: { ...request.appProperties },
            },
            media: { mimeType: 'text/markdown', body: request.content },
          },
          { signal },
        ),
      signal,
    );
  }

  updateTextFile(
    request: DriveUpdateRequest,
    signal: AbortSignal,
  ): Promise<DriveFileSnapshot> {
    return this.mutate(
      () =>
        this.#sdk.files.update(
          {
            fileId: request.fileId,
            supportsAllDrives: true,
            ...(request.content === undefined
              ? {}
              : { useContentAsIndexableText: true }),
            fields: fileFields,
            requestBody: {
              ...(request.name === undefined ? {} : { name: request.name }),
              appProperties: { ...request.appProperties },
            },
            ...(request.content === undefined
              ? {}
              : {
                  media: {
                    mimeType: request.mimeType,
                    body: request.content,
                  },
                }),
          },
          { signal },
        ),
      signal,
    );
  }

  trashFile(
    request: DriveTrashRequest,
    signal: AbortSignal,
  ): Promise<DriveFileSnapshot> {
    return this.mutate(
      () =>
        this.#sdk.files.update(
          {
            fileId: request.fileId,
            supportsAllDrives: true,
            fields: fileFields,
            requestBody: {
              trashed: true,
              appProperties: { ...request.appProperties },
            },
          },
          { signal },
        ),
      signal,
    );
  }

  private async list(
    params: drive_v3.Params$Resource$Files$List,
    signal: AbortSignal,
  ): Promise<DriveFilePage> {
    try {
      assertActive(signal);
      const response = await this.#sdk.files.list(params, { signal });
      assertActive(signal);
      return projectPage(response.data);
    } catch (error) {
      throw mapReadFailure(error);
    }
  }

  private async readBytes(
    run: () => Promise<DriveSdkResponse>,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      assertActive(signal);
      if (!Number.isInteger(maxBytes) || maxBytes < 1) {
        throw new DriveClientFailure('unavailable');
      }
      const response = await run();
      assertActive(signal);
      return toBytes(response.data, maxBytes);
    } catch (error) {
      throw mapReadFailure(error);
    }
  }

  private async mutate(
    run: () => Promise<DriveSdkResponse>,
    signal: AbortSignal,
  ): Promise<DriveFileSnapshot> {
    let response: DriveSdkResponse;
    try {
      assertActive(signal);
      response = await run();
      assertActive(signal);
    } catch (error) {
      throw mapMutationFailure(error);
    }
    try {
      return projectFile(response.data);
    } catch (error) {
      if (isAbortError(error)) throw cancellation();
      throw new DriveClientFailure('outcome_unknown');
    }
  }
}
