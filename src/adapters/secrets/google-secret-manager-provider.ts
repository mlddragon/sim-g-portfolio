import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

import type { EnvironmentName } from '../../config/environment.js';
import { DomainError } from '../../domain/errors.js';
import type { Clock } from '../../ports/clock.js';
import type {
  SecretProvider,
  SecretReference,
  SecretValue,
} from '../../ports/secret-provider.js';

/** The fields of an AccessSecretVersion response this adapter relies on. */
export interface SecretVersionAccessResponse {
  readonly name?: string | null;
  readonly payload?: {
    readonly data?: Uint8Array | string | null;
    /** int64 on the wire; the client may surface a number, string or Long. */
    readonly dataCrc32c?: number | string | { toString(): string } | null;
  } | null;
}

/** The single Secret Manager call this adapter may make. */
export interface SecretVersionAccessClient {
  accessSecretVersion(
    request: { name: string },
    options?: { timeout?: number },
  ): Promise<readonly [SecretVersionAccessResponse, ...unknown[]]>;
}

export interface GoogleSecretManagerProviderOptions {
  /** A deployed environment; local and test runs use the environment adapter. */
  readonly environment: EnvironmentName;
  /**
   * Numeric project number. Secret Manager reports accessed versions under the
   * project number, so the returned resource identity can be verified exactly.
   */
  readonly projectNumber: string;
  /** Trusted composition-time allowlist: logical name -> secret ID. */
  readonly bindings: Readonly<Record<string, string>>;
  readonly client?: SecretVersionAccessClient;
  readonly clock?: Clock;
  readonly cacheTtlMs?: number;
  readonly maximumCacheEntries?: number;
  readonly requestTimeoutMs?: number;
}

const logicalSecretName = /^[a-z][a-z0-9_-]{0,127}$/u;
const secretId = /^[A-Za-z0-9_-]{1,255}$/u;
const projectNumber = /^[1-9][0-9]{0,19}$/u;
const numericVersion = /^[1-9][0-9]{0,18}$/u;
// Secret Manager's own payload limit.
const maximumSecretBytes = 64 * 1024;
const defaultCacheTtlMs = 5 * 60_000;
const maximumCacheTtlMs = 60 * 60_000;
const defaultMaximumCacheEntries = 32;
const defaultRequestTimeoutMs = 10_000;

const grpcNotFound = 5;
const grpcPermissionDenied = 7;
const grpcInvalidArgument = 3;
const grpcFailedPrecondition = 9;
const grpcOutOfRange = 11;
const grpcUnauthenticated = 16;

interface CacheEntry {
  readonly value: SecretValue;
  readonly fetchedAt: number;
  readonly expiresAt: number;
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownData(record: unknown, key: string): unknown {
  if (!isRecord(record)) throw new TypeError('invalid_secret_input');
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError('invalid_secret_input');
  }
  return descriptor?.value as unknown;
}

function invalidConfiguration(): DomainError {
  return new DomainError('invalid_request', false, {
    reason: 'invalid_google_secret_configuration',
  });
}

function invalidReference(): DomainError {
  return new DomainError('invalid_request', false, {
    reason: 'invalid_google_secret_reference',
  });
}

function forbiddenEnvironment(): DomainError {
  return new DomainError('environment_boundary_violation', false, {
    reason: 'google_secret_environment_mismatch',
  });
}

function unavailable(reason: string, retryable = true): DomainError {
  return new DomainError('provider_unavailable', retryable, { reason });
}

function cancelled(): DOMException {
  return new DOMException('Secret resolution cancelled', 'AbortError');
}

function isCancelled(signal: AbortSignal): boolean {
  // The signal can abort while a call is pending; always reread the live state.
  return signal.aborted;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidConfiguration();
  }
  return value;
}

const crc32cTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

/** CRC32C (Castagnoli), as Secret Manager computes for payload integrity. */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc32cTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function declaredChecksum(value: unknown): bigint | undefined {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return undefined;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else if (isRecord(value)) {
    // A protobuf Long renders its decimal value through toString().
    try {
      const render: unknown = Reflect.get(value, 'toString');
      if (typeof render !== 'function') return undefined;
      const rendered: unknown = Reflect.apply(render, value, []);
      if (typeof rendered !== 'string') return undefined;
      text = rendered;
    } catch {
      return undefined;
    }
  } else {
    return undefined;
  }
  return /^(?:0|[1-9][0-9]{0,19})$/u.test(text) ? BigInt(text) : undefined;
}

function grpcCode(error: unknown): unknown {
  try {
    return isRecord(error) ? ownData(error, 'code') : undefined;
  } catch {
    return undefined;
  }
}

function abandon(pending: unknown): void {
  // A gax call is cancellable; stop the RPC rather than wait for its timeout.
  try {
    const cancel: unknown = Reflect.get(pending as object, 'cancel');
    if (typeof cancel === 'function') Reflect.apply(cancel, pending, []);
  } catch {
    // Best effort; the call is still bounded by its timeout.
  }
}

/**
 * Google Secret Manager adapter for deployed environments. Only allowlisted
 * logical names resolve, each to one explicit secret resource in one project.
 * Values are cached in memory for a bounded time and entry count, so rotation
 * and revocation become visible within the configured TTL. A failed fetch
 * evicts the secret, and no fetch begun before it can repopulate the cache.
 */
export class GoogleSecretManagerProvider implements SecretProvider {
  readonly #environment: EnvironmentName;
  readonly #resources: ReadonlyMap<string, string>;
  readonly #client: SecretVersionAccessClient;
  readonly #clock: Clock;
  readonly #cacheTtlMs: number;
  readonly #maximumCacheEntries: number;
  readonly #requestTimeoutMs: number;
  readonly #cache = new Map<string, CacheEntry>();
  // Bumped on every failure so a fetch begun earlier cannot repopulate the
  // cache afterwards. Bounded by the allowlist.
  readonly #failures = new Map<string, number>();

  constructor(options: GoogleSecretManagerProviderOptions) {
    let client: unknown;
    try {
      const environment = ownData(options, 'environment');
      if (environment !== 'development' && environment !== 'production') {
        throw invalidConfiguration();
      }
      this.#environment = environment;
      const project = ownData(options, 'projectNumber');
      if (typeof project !== 'string' || !projectNumber.test(project)) {
        throw invalidConfiguration();
      }
      const bindings = ownData(options, 'bindings');
      if (!isRecord(bindings)) throw invalidConfiguration();
      const prototype: unknown = Object.getPrototypeOf(bindings);
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalidConfiguration();
      }
      const resources = new Map<string, string>();
      for (const name of Object.getOwnPropertyNames(bindings)) {
        const id = ownData(bindings, name);
        if (
          !logicalSecretName.test(name) ||
          typeof id !== 'string' ||
          !secretId.test(id)
        ) {
          throw invalidConfiguration();
        }
        resources.set(name, `projects/${project}/secrets/${id}`);
      }
      if (resources.size === 0) throw invalidConfiguration();
      this.#resources = resources;
      this.#cacheTtlMs = boundedInteger(
        ownData(options, 'cacheTtlMs'),
        defaultCacheTtlMs,
        1_000,
        maximumCacheTtlMs,
      );
      this.#maximumCacheEntries = boundedInteger(
        ownData(options, 'maximumCacheEntries'),
        defaultMaximumCacheEntries,
        1,
        256,
      );
      this.#requestTimeoutMs = boundedInteger(
        ownData(options, 'requestTimeoutMs'),
        defaultRequestTimeoutMs,
        100,
        60_000,
      );
      const clock = ownData(options, 'clock');
      this.#clock =
        clock === undefined ? { now: () => new Date() } : (clock as Clock);
      client = ownData(options, 'client');
    } catch {
      // Never echo configuration or errors from accessors/proxies.
      throw invalidConfiguration();
    }
    // The official client authenticates lazily with the runtime identity.
    this.#client =
      client === undefined
        ? new SecretManagerServiceClient()
        : (client as SecretVersionAccessClient);
  }

  async get(
    reference: SecretReference,
    signal: AbortSignal,
  ): Promise<SecretValue> {
    if (signal.aborted) throw cancelled();
    let environment: unknown;
    let name: unknown;
    let version: unknown;
    try {
      environment = ownData(reference, 'environment');
      name = ownData(reference, 'name');
      version = ownData(reference, 'version');
    } catch {
      throw invalidReference();
    }
    if (
      typeof name !== 'string' ||
      !logicalSecretName.test(name) ||
      (version !== undefined &&
        (typeof version !== 'string' || !numericVersion.test(version)))
    ) {
      throw invalidReference();
    }
    if (environment !== this.#environment) throw forbiddenEnvironment();
    const resource = this.#resources.get(name);
    if (resource === undefined) {
      throw new DomainError('not_found', false, {
        reason: 'secret_not_configured',
      });
    }
    const requested = version ?? 'latest';
    const key = `${name}@${requested}`;
    const now = this.#now();
    const cached = this.#cache.get(key);
    if (
      cached !== undefined &&
      cached.expiresAt > now &&
      cached.fetchedAt <= now
    ) {
      // Reinsert so eviction drops the least recently read entry.
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached.value;
    }
    this.#cache.delete(key);

    const fetchedAt = now;
    const failures = this.#failures.get(name) ?? 0;
    let value: SecretValue;
    try {
      const response = await this.#access(
        `${resource}/versions/${requested}`,
        signal,
      );
      value = this.#verify(response, resource, requested);
    } catch (error) {
      // Cancellation is not a provider failure. Any other failure revokes every
      // cached version of this secret, including fetches still in flight.
      if (!(error instanceof DOMException)) this.#evict(name);
      throw error;
    }
    if ((this.#failures.get(name) ?? 0) === failures) {
      this.#remember(key, value, fetchedAt);
    }
    if (isCancelled(signal)) throw cancelled();
    return value;
  }

  #now(): number {
    const now = this.#clock.now().getTime();
    if (!Number.isFinite(now)) throw unavailable('secret_clock_unavailable');
    return now;
  }

  async #access(
    name: string,
    signal: AbortSignal,
  ): Promise<SecretVersionAccessResponse> {
    let pending: Promise<readonly [SecretVersionAccessResponse, ...unknown[]]>;
    try {
      pending = this.#client.accessSecretVersion(
        { name },
        { timeout: this.#requestTimeoutMs },
      );
    } catch (error) {
      throw this.#failure(error);
    }
    return await new Promise<SecretVersionAccessResponse>((resolve, reject) => {
      const abort = (): void => {
        abandon(pending);
        reject(cancelled());
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(pending).then(
        (result) => {
          signal.removeEventListener('abort', abort);
          try {
            // Verification rejects anything that is not a response object.
            resolve(result[0]);
          } catch {
            reject(unavailable('secret_response_invalid'));
          }
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(signal.aborted ? cancelled() : this.#failure(error));
        },
      );
    });
  }

  #failure(error: unknown): DomainError {
    // Only the status code is read; messages and metadata may carry details.
    switch (grpcCode(error)) {
      case grpcNotFound:
        return new DomainError('not_found', false, {
          reason: 'secret_version_not_found',
        });
      case grpcFailedPrecondition:
        return new DomainError('not_found', false, {
          reason: 'secret_version_unavailable',
        });
      case grpcPermissionDenied:
      case grpcUnauthenticated:
        return unavailable('secret_access_denied', false);
      case grpcInvalidArgument:
      case grpcOutOfRange:
        return unavailable('secret_request_rejected', false);
      default:
        return unavailable('secret_access_failed');
    }
  }

  #verify(
    response: SecretVersionAccessResponse,
    resource: string,
    requested: string,
  ): SecretValue {
    let name: unknown;
    let data: unknown;
    let checksum: unknown;
    try {
      name = ownData(response, 'name');
      const payload = ownData(response, 'payload');
      data = ownData(payload, 'data');
      checksum = ownData(payload, 'dataCrc32c');
    } catch {
      throw unavailable('secret_response_invalid');
    }
    const prefix = `${resource}/versions/`;
    const resolved =
      typeof name === 'string' && name.startsWith(prefix)
        ? name.slice(prefix.length)
        : undefined;
    if (
      resolved === undefined ||
      !numericVersion.test(resolved) ||
      (requested !== 'latest' && resolved !== requested)
    ) {
      throw unavailable('secret_identity_mismatch', false);
    }
    const bytes =
      data instanceof Uint8Array
        ? data
        : typeof data === 'string'
          ? Buffer.from(data, 'base64')
          : undefined;
    if (
      bytes === undefined ||
      bytes.length === 0 ||
      bytes.length > maximumSecretBytes
    ) {
      throw unavailable('secret_response_invalid');
    }
    const expected = declaredChecksum(checksum);
    if (expected === undefined || expected !== BigInt(crc32c(bytes))) {
      throw unavailable('secret_integrity_failed');
    }
    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw unavailable('secret_response_invalid', false);
    }
    if (value.trim().length === 0) {
      throw unavailable('secret_response_invalid', false);
    }
    return Object.freeze({ value, version: resolved });
  }

  #remember(key: string, value: SecretValue, fetchedAt: number): void {
    const existing = this.#cache.get(key);
    // An older overlapping fetch must never replace a newer one.
    if (existing !== undefined && existing.fetchedAt > fetchedAt) return;
    this.#cache.delete(key);
    this.#cache.set(key, {
      value,
      fetchedAt,
      expiresAt: fetchedAt + this.#cacheTtlMs,
    });
    while (this.#cache.size > this.#maximumCacheEntries) {
      const oldest = this.#cache.keys().next();
      if (oldest.done === true) return;
      this.#cache.delete(oldest.value);
    }
  }

  #evict(name: string): void {
    this.#failures.set(name, (this.#failures.get(name) ?? 0) + 1);
    for (const key of [...this.#cache.keys()]) {
      if (key.startsWith(`${name}@`)) this.#cache.delete(key);
    }
  }
}
