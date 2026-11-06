import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { main, type MainDependencies } from '../../../src/main.js';
import type { RuntimeProviders } from '../../../src/runtime/providers.js';
import { syntheticConfigDocument } from '../../support/environment-fixtures.js';
import {
  FakeFetchableKnowledgeProvider,
  FakeMutableKnowledgeProvider,
} from '../../support/fake-knowledge-providers.js';

const databaseUrl =
  'postgresql://gateway:synthetic-password@127.0.0.1:5432/family_brain';
const notionToken = 'synthetic-notion-integration-token';

class FakeProcess extends EventEmitter {}

function harness(overrides: Partial<MainDependencies> = {}) {
  const errors: string[] = [];
  const poolEnds: number[] = [];
  const signals = new FakeProcess();
  const listening: string[] = [];
  const access = { brainScopes: ['family_shared' as const], rootRefs: [] };
  const runtime: RuntimeProviders = {
    providers: {
      notion: new FakeMutableKnowledgeProvider('notion', [], {
        configuredAccess: access,
      }),
      drive: new FakeMutableKnowledgeProvider('drive', [], {
        configuredAccess: access,
      }),
      github: new FakeFetchableKnowledgeProvider('github', [], {
        configuredAccess: { brainScopes: [], rootRefs: [] },
      }),
    },
    surfaces: [],
    approvalProjection: {
      findByApprovalRequestId: () => Promise.resolve(null),
      create: () => Promise.reject(new Error('unused')),
      update: () => Promise.resolve(),
    },
  };
  const dependencies: MainDependencies = {
    env: {
      GATEWAY_CONFIG_PATH: '/etc/gateway/config.json',
      PORT: '0',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_TRUSTED_PROXY_HOPS: '0',
      DATABASE_URL: databaseUrl,
      NOTION_TOKEN: notionToken,
      GITHUB_APP_PRIVATE_KEY: 'synthetic-github-key',
    },
    readFile: (path) =>
      path === '/etc/gateway/config.json'
        ? Promise.resolve(JSON.stringify(syntheticConfigDocument()))
        : Promise.reject(new Error(`ENOENT ${path}`)),
    policyDirectory: new URL('../../../config/policy/', import.meta.url),
    createPool: () =>
      ({
        end: () => {
          poolEnds.push(1);
          return Promise.resolve();
        },
      }) as never,
    createDriveAuth: () => Promise.resolve({} as never),
    createProviders: () => Promise.resolve(runtime),
    auditOutbox: () => ({
      flush: () =>
        Promise.resolve({ claimed: 0, delivered: 0, failed: 0, lostClaims: 0 }),
    }),
    signals,
    stderr: { write: (line: string) => errors.push(line) },
    logStream: new PassThrough(),
    onListening: (url) => listening.push(url),
    ...overrides,
  };
  return { dependencies, errors, poolEnds, signals, listening };
}

async function waitFor(listening: readonly string[]) {
  while (listening.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function lastError(errors: readonly string[]) {
  return JSON.parse(errors.at(-1) ?? '{}') as Record<string, unknown>;
}

describe('main', () => {
  it('starts the composed gateway and exits 0 after a graceful SIGTERM', async () => {
    const { dependencies, signals, poolEnds, listening } = harness();

    const running = main(dependencies);
    await new Promise<void>((resolve) => {
      const wait = () => {
        if (listening.length > 0) resolve();
        else setTimeout(wait, 10);
      };
      wait();
    });
    const health = await fetch(`${listening[0] ?? ''}/healthz`);
    expect(health.status).toBe(200);
    signals.emit('SIGTERM');

    await expect(running).resolves.toBe(0);
    expect(poolEnds).toEqual([1]);
  });

  it('wires telemetry into the composed services', async () => {
    const observations: string[] = [];
    const { dependencies, signals, listening } = harness({
      telemetry: {
        observe: (observation) => {
          observations.push(observation.name);
          return Promise.resolve();
        },
      },
      createIdentity: () => ({
        verify: () =>
          Promise.resolve({
            issuer: 'https://accounts.google.com',
            externalSubject: 'synthetic-subject-operator',
            email: 'operator@example.invalid',
            authenticatedAt: new Date(),
          }),
      }),
      createPool: () =>
        ({
          // Just enough PostgreSQL for one authenticated, audited search.
          query: (sql: string, values: readonly unknown[] = []) =>
            Promise.resolve({
              rows: sql.includes('INSERT INTO audit_outbox')
                ? [
                    {
                      id: '1',
                      event: JSON.parse(String(values[0])) as unknown,
                      attempts: 0,
                      available_at: new Date(),
                      delivered_at: null,
                      last_error_code: null,
                    },
                  ]
                : [
                    {
                      principal_id: 'prn_operator',
                      issuer: 'https://accounts.google.com',
                      external_subject: 'synthetic-subject-operator',
                      email: 'operator@example.invalid',
                      enabled: true,
                      principal_key: 'operator',
                      display_name: 'Operator',
                      role: 'owner_operator',
                      status: 'active',
                    },
                  ],
            }),
          end: () => Promise.resolve(),
        }) as never,
      auditOutbox: () => ({
        flush: () =>
          Promise.resolve({
            claimed: 0,
            delivered: 0,
            failed: 0,
            lostClaims: 0,
          }),
      }),
    });

    const running = main(dependencies);
    await waitFor(listening);
    const response = await fetch(
      `${listening[0] ?? ''}/v1/operations/search_brain`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic.token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: 'Synthetic', limit: 1 }),
      },
    );
    expect(response.status).toBe(200);
    signals.emit('SIGTERM');
    await running;

    expect(observations).toContain('request.total');
  });

  it('passes injected rate limits to the composed API', async () => {
    const { dependencies, signals, listening } = harness({
      rateLimits: { perIpPerMinute: 1 },
    });

    const running = main(dependencies);
    await waitFor(listening);
    const call = () =>
      fetch(`${listening[0] ?? ''}/v1/operations/search_brain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'Synthetic', limit: 1 }),
      });
    const first = await call();
    const second = await call();
    signals.emit('SIGTERM');
    await running;

    expect(first.status).toBe(401);
    expect(second.status).toBe(429);
  });

  it('runs audit delivery and stops it before closing the pool', async () => {
    const order: string[] = [];
    let flushes = 0;
    const { dependencies, signals, listening } = harness({
      createPool: () =>
        ({
          end: () => {
            order.push('pool_end');
            return Promise.resolve();
          },
        }) as never,
      auditOutbox: () => ({
        flush: (signal) => {
          flushes += 1;
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              order.push('delivery_stopped');
              reject(new DOMException('cancelled', 'AbortError'));
            });
          });
        },
      }),
    });

    const running = main(dependencies);
    await waitFor(listening);
    await new Promise((resolve) => setTimeout(resolve, 20));
    signals.emit('SIGTERM');

    await expect(running).resolves.toBe(0);
    expect(flushes).toBe(1);
    expect(order).toEqual(['delivery_stopped', 'pool_end']);
  });

  it('passes only the environment provider the process environment', async () => {
    const seen: unknown[] = [];
    const { dependencies, signals, listening } = harness({
      createProviders: async (options) => {
        seen.push(
          await options.secrets.get(
            { environment: 'development', name: 'notion_development' },
            options.signal,
          ),
        );
        return harness().dependencies.createProviders?.(options) as never;
      },
    });

    const running = main(dependencies);
    await new Promise<void>((resolve) => {
      const wait = () => {
        if (listening.length > 0) resolve();
        else setTimeout(wait, 10);
      };
      wait();
    });
    signals.emit('SIGTERM');
    await running;

    expect(seen).toEqual([{ value: notionToken, version: 'environment' }]);
  });

  it.each([
    [
      'a missing configuration path',
      { env: { PORT: '0' } },
      'gateway_config_path_required',
    ],
    [
      'an invalid port',
      {
        env: { GATEWAY_CONFIG_PATH: '/etc/gateway/config.json', PORT: '99999' },
      },
      'invalid_port',
    ],
    [
      'an unreadable configuration file',
      {
        readFile: () =>
          Promise.reject(new Error('ENOENT /etc/gateway/config.json')),
      },
      'environment_configuration_unreadable',
    ],
    [
      'an invalid proxy hop count',
      {
        env: {
          GATEWAY_CONFIG_PATH: '/etc/gateway/config.json',
          PORT: '0',
          GATEWAY_TRUSTED_PROXY_HOPS: 'many',
        },
      },
      'invalid_trusted_proxy_hops',
    ],
  ] as const)(
    'exits 1 on %s with a fixed, path-free reason',
    async (_, overrides, reason) => {
      const { dependencies, errors, listening } = harness(overrides);

      await expect(main(dependencies)).resolves.toBe(1);
      expect(lastError(errors)).toEqual({
        severity: 'ERROR',
        msg: 'startup_failed',
        reason,
      });
      expect(errors.join('')).not.toContain('/etc/gateway');
      expect(listening).toEqual([]);
    },
  );

  it('refuses a TCP database URL when the deployment requires the socket', async () => {
    const { dependencies, errors, listening } = harness();

    await expect(
      main({
        ...dependencies,
        env: { ...dependencies.env, GATEWAY_DATABASE_TRANSPORT: 'unix_socket' },
      }),
    ).resolves.toBe(1);
    expect(lastError(errors)).toMatchObject({
      reason: 'database_socket_required',
    });
    expect(listening).toEqual([]);
  });

  it('starts with the socket when the deployment requires it', async () => {
    const { dependencies, signals, listening } = harness();
    const pools: string[] = [];
    const createPool = dependencies.createPool;
    if (createPool === undefined) throw new Error('harness pool missing');
    const running = main({
      ...dependencies,
      env: {
        ...dependencies.env,
        GATEWAY_DATABASE_TRANSPORT: 'unix_socket',
        DATABASE_URL:
          'postgresql://gateway_runtime:synthetic-password@/family_brain?host=/run/postgresql',
      },
      createPool: (url) => {
        pools.push(url);
        return createPool(url);
      },
      onListening: (url) => {
        listening.push(url);
        signals.emit('SIGTERM');
      },
    });

    await expect(running).resolves.toBe(0);
    expect(pools).toEqual([
      'postgresql://gateway_runtime:synthetic-password@/family_brain?host=/run/postgresql',
    ]);
  });

  it.each(['', 'tcp', 'UNIX_SOCKET', 'unix_socket '])(
    'refuses the database transport setting %j',
    async (value) => {
      const { dependencies, errors } = harness();

      await expect(
        main({
          ...dependencies,
          env: { ...dependencies.env, GATEWAY_DATABASE_TRANSPORT: value },
        }),
      ).resolves.toBe(1);
      expect(lastError(errors)).toMatchObject({
        reason: 'invalid_database_transport',
      });
    },
  );

  it.each(['PGOPTIONS', 'PGPORT', 'PGUSER', 'PGHOST', 'PGSSLMODE'])(
    'refuses %s, which the client would read behind the validated URL',
    async (name) => {
      const { dependencies, errors, listening } = harness();

      await expect(
        main({
          ...dependencies,
          env: { ...dependencies.env, [name]: 'synthetic' },
        }),
      ).resolves.toBe(1);
      expect(lastError(errors)).toMatchObject({
        reason: 'postgres_environment_override_refused',
      });
      expect(listening).toEqual([]);
    },
  );

  it('requires an explicit proxy hop count outside production', async () => {
    const { dependencies, errors } = harness();
    const { GATEWAY_TRUSTED_PROXY_HOPS: _hops, ...env } = dependencies.env;

    await expect(main({ ...dependencies, env })).resolves.toBe(1);
    expect(lastError(errors)).toMatchObject({
      reason: 'trusted_proxy_hops_required',
    });
  });

  it('bounds every startup step by one deadline and closes the pool', async () => {
    const { dependencies, errors, poolEnds } = harness({
      createProviders: () => new Promise(() => undefined),
      startupTimeoutMs: 50,
    });

    await expect(main(dependencies)).resolves.toBe(1);
    expect(lastError(errors)).toMatchObject({ reason: 'startup_timeout' });
    expect(poolEnds).toEqual([1]);
  });

  it('closes the pool and never echoes secrets when startup fails after connecting', async () => {
    const { dependencies, errors, poolEnds } = harness({
      createProviders: () =>
        Promise.reject(
          new Error(`provider failure ${notionToken} ${databaseUrl}`),
        ),
    });

    await expect(main(dependencies)).resolves.toBe(1);
    expect(poolEnds).toEqual([1]);
    expect(lastError(errors)).toEqual({
      severity: 'ERROR',
      msg: 'startup_failed',
      reason: 'unexpected_startup_failure',
    });
    expect(errors.join('')).not.toContain(notionToken);
    expect(errors.join('')).not.toContain('synthetic-password');
  });

  it('reports a domain failure by its safe reason only', async () => {
    const { dependencies, errors } = harness({
      env: {
        GATEWAY_CONFIG_PATH: '/etc/gateway/config.json',
        PORT: '0',
        GATEWAY_TRUSTED_PROXY_HOPS: '0',
        DATABASE_URL: 'mysql://gateway:synthetic-password@db/family_brain',
        NOTION_TOKEN: notionToken,
        GITHUB_APP_PRIVATE_KEY: 'synthetic-github-key',
      },
    });

    await expect(main(dependencies)).resolves.toBe(1);
    expect(lastError(errors)).toEqual({
      severity: 'ERROR',
      msg: 'startup_failed',
      reason: 'invalid_database_connection_secret',
    });
    expect(errors.join('')).not.toContain('synthetic-password');
  });
});
