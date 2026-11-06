import { describe, expect, it } from 'vitest';

import {
  crc32c,
  GoogleSecretManagerProvider,
  type GoogleSecretManagerProviderOptions,
  type SecretVersionAccessClient,
  type SecretVersionAccessResponse,
} from '../../../src/adapters/secrets/google-secret-manager-provider.js';
import { DomainError } from '../../../src/domain/errors.js';
import type { SecretReference } from '../../../src/ports/secret-provider.js';

const project = '123456789012';
const resource = `projects/${project}/secrets/notion-dev-token`;
const syntheticValue = 'synthetic-notion-machine-token-v1';

function response(
  value: string,
  version: string,
  overrides: Partial<{
    name: string | null;
    data: Uint8Array | string | null;
    dataCrc32c: SecretVersionAccessResponse extends {
      payload?: infer P;
    }
      ? P extends { dataCrc32c?: infer C }
        ? C
        : never
      : never;
  }> = {},
): SecretVersionAccessResponse {
  const data = Buffer.from(value, 'utf8');
  return {
    name:
      'name' in overrides ? overrides.name : `${resource}/versions/${version}`,
    payload: {
      data: 'data' in overrides ? overrides.data : data,
      dataCrc32c:
        'dataCrc32c' in overrides ? overrides.dataCrc32c : String(crc32c(data)),
    },
  };
}

class FakeClient implements SecretVersionAccessClient {
  readonly calls: { name: string; timeout?: number }[] = [];
  readonly versions = new Map<string, string>([['1', syntheticValue]]);
  latest = '1';
  next: (() => Promise<readonly [SecretVersionAccessResponse]>) | undefined;

  accessSecretVersion(
    request: { name: string },
    options?: { timeout?: number },
  ): Promise<readonly [SecretVersionAccessResponse]> {
    this.calls.push({ name: request.name, ...options });
    const override = this.next;
    if (override !== undefined) {
      this.next = undefined;
      return override();
    }
    const requested = request.name.slice(`${resource}/versions/`.length);
    const version = requested === 'latest' ? this.latest : requested;
    const value = this.versions.get(version);
    if (value === undefined) {
      return Promise.reject(
        Object.assign(new Error(`synthetic missing ${request.name}`), {
          code: 9,
        }),
      );
    }
    return Promise.resolve([response(value, version)]);
  }
}

class ManualClock {
  constructor(public at = Date.parse('2044-01-02T03:04:05.000Z')) {}
  now(): Date {
    return new Date(this.at);
  }
}

function provider(overrides: Partial<GoogleSecretManagerProviderOptions> = {}) {
  const client = new FakeClient();
  const clock = new ManualClock();
  return {
    client,
    clock,
    secrets: new GoogleSecretManagerProvider({
      environment: 'development',
      projectNumber: project,
      bindings: { notion_token: 'notion-dev-token' },
      client,
      clock,
      cacheTtlMs: 60_000,
      ...overrides,
    }),
  };
}

const reference: SecretReference = {
  environment: 'development',
  name: 'notion_token',
};
const live = () => new AbortController().signal;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('crc32c', () => {
  it('matches the Castagnoli check value', () => {
    expect(crc32c(Buffer.from('123456789', 'ascii'))).toBe(0xe3069283);
    expect(crc32c(new Uint8Array())).toBe(0);
  });
});

describe('GoogleSecretManagerProvider', () => {
  it('resolves an allowlisted name to its explicit resource and version', async () => {
    const { client, secrets } = provider({ requestTimeoutMs: 2_500 });

    await expect(secrets.get(reference, live())).resolves.toEqual({
      value: syntheticValue,
      version: '1',
    });
    await expect(
      secrets.get({ ...reference, version: '1' }, live()),
    ).resolves.toEqual({ value: syntheticValue, version: '1' });
    expect(client.calls).toEqual([
      { name: `${resource}/versions/latest`, timeout: 2_500 },
      { name: `${resource}/versions/1`, timeout: 2_500 },
    ]);
  });

  it('refuses names that are not configured without calling Secret Manager', async () => {
    const { client, secrets } = provider();

    await expect(
      secrets.get({ ...reference, name: 'github_token' }, live()),
    ).rejects.toMatchObject({
      code: 'not_found',
      details: { reason: 'secret_not_configured' },
    });
    await expect(
      secrets.get({ ...reference, name: 'notion-dev-token' }, live()),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(client.calls).toEqual([]);
  });

  it('refuses another environment and the local test environment', async () => {
    const { client, secrets } = provider({ environment: 'production' });

    await expect(secrets.get(reference, live())).rejects.toMatchObject({
      code: 'environment_boundary_violation',
    });
    expect(client.calls).toEqual([]);
    expect(() => provider({ environment: 'test' })).toThrow(
      expect.objectContaining({
        code: 'invalid_request',
        details: { reason: 'invalid_google_secret_configuration' },
      }),
    );
  });

  it.each([
    ['a path-shaped name', { ...reference, name: '../other' }],
    ['a non-numeric version', { ...reference, version: 'latest' }],
    ['a version alias', { ...reference, version: 'prod' }],
    ['a zero version', { ...reference, version: '0' }],
    ['a resource-path version', { ...reference, version: '1/../2' }],
    ['a non-object reference', null],
  ])('rejects %s before any call', async (_, candidate) => {
    const { client, secrets } = provider();

    await expect(
      secrets.get(candidate as unknown as SecretReference, live()),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'invalid_google_secret_reference' },
    });
    expect(client.calls).toEqual([]);
  });

  it.each([
    ['a project ID instead of a number', { projectNumber: 'example-dev' }],
    ['an empty allowlist', { bindings: {} }],
    ['a path-shaped secret ID', { bindings: { notion_token: 'a/b' } }],
    ['an invalid logical name', { bindings: { 'Notion Token': 'notion' } }],
    ['an unbounded TTL', { cacheTtlMs: 24 * 60 * 60_000 }],
    ['a zero cache size', { maximumCacheEntries: 0 }],
    ['an oversized cache', { maximumCacheEntries: 10_000 }],
    ['a fractional timeout', { requestTimeoutMs: 1.5 }],
  ])('rejects %s at construction', (_, overrides) => {
    expect(() =>
      provider(overrides as Partial<GoogleSecretManagerProviderOptions>),
    ).toThrow(
      expect.objectContaining({
        code: 'invalid_request',
        details: { reason: 'invalid_google_secret_configuration' },
      }),
    );
  });

  it('never invokes a binding getter or echoes configuration', () => {
    let invoked = false;
    const bindings = {};
    Object.defineProperty(bindings, 'notion_token', {
      enumerable: true,
      get: () => {
        invoked = true;
        return 'notion-dev-token';
      },
    });

    const error = (() => {
      try {
        provider({ bindings });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(invoked).toBe(false);
    expect(error).toBeInstanceOf(DomainError);
    expect(JSON.stringify(error)).not.toContain('notion-dev-token');
  });

  it('serves a cached value only until its TTL expires', async () => {
    const { client, clock, secrets } = provider();

    await secrets.get(reference, live());
    clock.at += 59_999;
    await secrets.get(reference, live());
    expect(client.calls).toHaveLength(1);
    clock.at += 1;
    await secrets.get(reference, live());
    expect(client.calls).toHaveLength(2);
  });

  it('makes rotation observable through the returned version after expiry', async () => {
    const { client, clock, secrets } = provider();
    await expect(secrets.get(reference, live())).resolves.toMatchObject({
      version: '1',
    });

    client.versions.set('2', 'synthetic-notion-machine-token-v2');
    client.latest = '2';
    clock.at += 60_000;

    await expect(secrets.get(reference, live())).resolves.toEqual({
      value: 'synthetic-notion-machine-token-v2',
      version: '2',
    });
    await expect(
      secrets.get({ ...reference, version: '1' }, live()),
    ).resolves.toEqual({ value: syntheticValue, version: '1' });
  });

  it('fails closed after revocation and never serves a stale value', async () => {
    const { client, clock, secrets } = provider();
    await secrets.get({ ...reference, version: '1' }, live());
    await secrets.get(reference, live());

    client.versions.delete('1');
    clock.at += 60_000;

    await expect(secrets.get(reference, live())).rejects.toMatchObject({
      code: 'not_found',
      retryable: false,
      details: { reason: 'secret_version_unavailable' },
    });
    // The failed refresh evicted every cached version of the secret.
    await expect(
      secrets.get({ ...reference, version: '1' }, live()),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(client.calls).toHaveLength(4);
  });

  it('never serves a stale value when a refresh fails transiently', async () => {
    const { client, clock, secrets } = provider();
    await secrets.get(reference, live());
    clock.at += 60_000;
    client.next = () =>
      Promise.reject(
        Object.assign(new Error('synthetic outage'), { code: 14 }),
      );

    await expect(secrets.get(reference, live())).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'secret_access_failed' },
    });
    await expect(secrets.get(reference, live())).resolves.toMatchObject({
      version: '1',
    });
  });

  it('refetches rather than trusting a cache entry after the clock moves back', async () => {
    const { client, clock, secrets } = provider();
    await secrets.get(reference, live());
    clock.at -= 1_000;

    await secrets.get(reference, live());
    expect(client.calls).toHaveLength(2);
  });

  it('bounds the cache by entry count, evicting the least recent', async () => {
    const { client, secrets } = provider({ maximumCacheEntries: 2 });
    for (const version of ['2', '3']) {
      client.versions.set(version, `synthetic-token-v${version}`);
    }

    for (const version of ['1', '2', '3']) {
      await secrets.get({ ...reference, version }, live());
    }
    await secrets.get({ ...reference, version: '3' }, live());
    await secrets.get({ ...reference, version: '2' }, live());
    expect(client.calls).toHaveLength(3);
    await secrets.get({ ...reference, version: '1' }, live());
    expect(client.calls).toHaveLength(4);
  });

  it('keeps a recently read entry when the cache must evict', async () => {
    const { client, secrets } = provider({ maximumCacheEntries: 2 });
    client.versions.set('2', 'synthetic-token-v2');
    client.versions.set('3', 'synthetic-token-v3');

    await secrets.get({ ...reference, version: '1' }, live());
    await secrets.get({ ...reference, version: '2' }, live());
    await secrets.get({ ...reference, version: '1' }, live());
    await secrets.get({ ...reference, version: '3' }, live());
    expect(client.calls).toHaveLength(3);
    await secrets.get({ ...reference, version: '1' }, live());
    expect(client.calls).toHaveLength(3);
    await secrets.get({ ...reference, version: '2' }, live());
    expect(client.calls).toHaveLength(4);
  });

  it('never lets an older overlapping fetch replace a newer cached version', async () => {
    const { client, clock, secrets } = provider();
    let releaseOld: (() => void) | undefined;
    client.next = () =>
      new Promise((resolve) => {
        releaseOld = () => {
          resolve([response(syntheticValue, '1')]);
        };
      });
    const older = secrets.get(reference, live());

    clock.at += 10;
    client.versions.set('2', 'synthetic-notion-machine-token-v2');
    client.latest = '2';
    await expect(secrets.get(reference, live())).resolves.toMatchObject({
      version: '2',
    });
    releaseOld?.();
    await expect(older).resolves.toMatchObject({ version: '1' });

    await expect(secrets.get(reference, live())).resolves.toMatchObject({
      version: '2',
    });
    expect(client.calls).toHaveLength(2);
  });

  it('never lets a fetch started before a failure repopulate the cache', async () => {
    const { client, clock, secrets } = provider();
    let releaseOld: (() => void) | undefined;
    client.next = () =>
      new Promise((resolve) => {
        releaseOld = () => {
          resolve([response(syntheticValue, '1')]);
        };
      });
    const older = secrets.get(reference, live());

    clock.at += 1;
    client.versions.delete('1');
    await expect(secrets.get(reference, live())).rejects.toMatchObject({
      details: { reason: 'secret_version_unavailable' },
    });
    releaseOld?.();
    await expect(older).resolves.toMatchObject({ version: '1' });

    clock.at += 1_000;
    await expect(secrets.get(reference, live())).rejects.toMatchObject({
      details: { reason: 'secret_version_unavailable' },
    });
    expect(client.calls).toHaveLength(3);
  });

  it('keeps cached versions when a caller cancels', async () => {
    const { client, clock, secrets } = provider();
    await secrets.get(reference, live());
    clock.at += 30_000;
    await secrets.get({ ...reference, version: '1' }, live());
    clock.at += 30_000;
    const controller = new AbortController();
    client.next = () => new Promise(() => undefined);
    const pending = secrets.get(reference, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // Cancellation is not a provider failure, so the pinned entry stays cached.
    await secrets.get({ ...reference, version: '1' }, live());
    expect(client.calls).toHaveLength(3);
  });

  it('cancels the underlying call when the caller aborts', async () => {
    const { client, secrets } = provider();
    let cancelled = 0;
    client.next = () =>
      Object.assign(new Promise<never>(() => undefined), {
        cancel: () => {
          cancelled += 1;
        },
      });
    const controller = new AbortController();
    const pending = secrets.get(reference, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(1);
  });

  it('settles with a safe error when a hostile error or response throws', async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    // Typed as an Error only so it can be thrown; every trap on it throws.
    const hostile = revoked.proxy as unknown as Error;
    const cases: (() => Promise<readonly [SecretVersionAccessResponse]>)[] = [
      () => Promise.reject(hostile),
      () => {
        throw hostile;
      },
      () =>
        Promise.resolve(
          revoked.proxy as unknown as readonly [SecretVersionAccessResponse],
        ),
      () =>
        Promise.resolve(
          42 as unknown as readonly [SecretVersionAccessResponse],
        ),
    ];
    for (const next of cases) {
      const { client, secrets } = provider();
      client.next = next;
      await expect(secrets.get(reference, live())).rejects.toBeInstanceOf(
        DomainError,
      );
    }
  });

  it.each([
    [
      'another secret',
      { name: 'projects/123456789012/secrets/github/versions/1' },
    ],
    [
      'another project',
      { name: 'projects/999/secrets/notion-dev-token/versions/1' },
    ],
    [
      'a project ID',
      { name: 'projects/example-dev/secrets/notion-dev-token/versions/1' },
    ],
    ['an alias version', { name: `${resource}/versions/latest` }],
    ['a nested path', { name: `${resource}/versions/1/extra` }],
    ['no name', { name: null }],
  ])('rejects a response naming %s', async (_, overrides) => {
    const { client, secrets } = provider();
    client.next = () =>
      Promise.resolve([response(syntheticValue, '1', overrides)]);

    await expect(secrets.get(reference, live())).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: false,
      details: { reason: 'secret_identity_mismatch' },
    });
  });

  it('rejects a pinned request answered with a different version', async () => {
    const { client, secrets } = provider();
    client.next = () => Promise.resolve([response(syntheticValue, '2')]);

    await expect(
      secrets.get({ ...reference, version: '1' }, live()),
    ).rejects.toMatchObject({
      details: { reason: 'secret_identity_mismatch' },
    });
  });

  it.each([
    ['a mismatched checksum', { dataCrc32c: '1' }],
    ['a missing checksum', { dataCrc32c: null }],
    ['a negative checksum', { dataCrc32c: -1 }],
    ['a non-decimal checksum', { dataCrc32c: '0x1' }],
  ])('rejects %s as an integrity failure', async (_, overrides) => {
    const { client, secrets } = provider();
    client.next = () =>
      Promise.resolve([
        response(
          syntheticValue,
          '1',
          overrides as Parameters<typeof response>[2],
        ),
      ]);

    await expect(secrets.get(reference, live())).rejects.toMatchObject({
      code: 'provider_unavailable',
      details: { reason: 'secret_integrity_failed' },
    });
  });

  it('accepts the checksum as a number or a Long-like object', async () => {
    const bytes = Buffer.from(syntheticValue, 'utf8');
    const checksum = crc32c(bytes);
    for (const dataCrc32c of [checksum, { toString: () => String(checksum) }]) {
      const { client, secrets } = provider();
      client.next = () =>
        Promise.resolve([response(syntheticValue, '1', { dataCrc32c })]);
      await expect(secrets.get(reference, live())).resolves.toMatchObject({
        value: syntheticValue,
      });
    }
  });

  it.each([
    ['an empty payload', ''],
    ['a blank payload', '   '],
  ])('rejects %s', async (_, value) => {
    const { client, secrets } = provider();
    client.next = () => Promise.resolve([response(value, '1')]);

    await expect(secrets.get(reference, live())).rejects.toMatchObject({
      code: 'provider_unavailable',
      details: { reason: 'secret_response_invalid' },
    });
  });

  it('rejects an oversized or non-UTF-8 payload', async () => {
    for (const bytes of [
      new Uint8Array(64 * 1024 + 1).fill(0x61),
      Uint8Array.from([0xff, 0xfe]),
    ]) {
      const { client, secrets } = provider();
      client.next = () =>
        Promise.resolve([
          {
            name: `${resource}/versions/1`,
            payload: { data: bytes, dataCrc32c: String(crc32c(bytes)) },
          },
        ]);
      await expect(secrets.get(reference, live())).rejects.toMatchObject({
        details: { reason: 'secret_response_invalid' },
      });
    }
  });

  it.each([
    [5, 'not_found', false, 'secret_version_not_found'],
    [9, 'not_found', false, 'secret_version_unavailable'],
    [7, 'provider_unavailable', false, 'secret_access_denied'],
    [16, 'provider_unavailable', false, 'secret_access_denied'],
    [3, 'provider_unavailable', false, 'secret_request_rejected'],
    [11, 'provider_unavailable', false, 'secret_request_rejected'],
    [14, 'provider_unavailable', true, 'secret_access_failed'],
    [undefined, 'provider_unavailable', true, 'secret_access_failed'],
  ] as const)(
    'maps status %s to a safe error without its message',
    async (code, expected, retryable, reason) => {
      const { client, secrets } = provider();
      const raw = Object.assign(
        new Error(`synthetic failure for ${resource} ${syntheticValue}`),
        { code, details: syntheticValue },
      );
      client.next = () => Promise.reject(raw);

      const error = await rejection(secrets.get(reference, live()));
      expect(error).toMatchObject({
        code: expected,
        retryable,
        details: { reason },
      });
      expect(JSON.stringify(error)).not.toContain(resource);
      expect(JSON.stringify(error)).not.toContain(syntheticValue);
      expect(String(error)).not.toContain(syntheticValue);
    },
  );

  it('converts a synchronous client throw into a safe error', async () => {
    const { client, secrets } = provider();
    client.next = () => {
      throw new Error(syntheticValue);
    };

    await expect(secrets.get(reference, live())).rejects.toMatchObject({
      code: 'provider_unavailable',
      details: { reason: 'secret_access_failed' },
    });
  });

  it('rejects promptly with a fresh AbortError and caches nothing', async () => {
    const { client, secrets } = provider();
    const preAborted = new AbortController();
    preAborted.abort(new Error(syntheticValue));
    const before = await rejection(secrets.get(reference, preAborted.signal));
    expect(before).toBeInstanceOf(DOMException);
    expect((before as DOMException).name).toBe('AbortError');
    expect(client.calls).toEqual([]);

    const controller = new AbortController();
    client.next = () => new Promise(() => undefined);
    const pending = secrets.get(reference, controller.signal);
    controller.abort(new Error(syntheticValue));
    const during = await rejection(pending);
    expect((during as DOMException).name).toBe('AbortError');
    expect(String(during)).not.toContain(syntheticValue);

    await secrets.get(reference, live());
    expect(client.calls).toHaveLength(2);
  });

  it('never exposes cached values through serialization or enumeration', async () => {
    const { secrets } = provider();
    await secrets.get(reference, live());

    expect(JSON.stringify(secrets)).not.toContain(syntheticValue);
    expect(Object.keys(secrets)).toEqual([]);
  });

  it('returns a frozen value the caller cannot mutate into the cache', async () => {
    const { secrets } = provider();
    const first = await secrets.get(reference, live());

    expect(Object.isFrozen(first)).toBe(true);
    await expect(secrets.get(reference, live())).resolves.toEqual({
      value: syntheticValue,
      version: '1',
    });
  });
});
