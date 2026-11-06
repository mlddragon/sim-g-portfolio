import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { crc32c } from '../../../src/adapters/secrets/google-secret-manager-provider.js';
import { GoogleOidcIdentityProvider } from '../../../src/adapters/identity/google-oidc-identity-provider.js';
import {
  createDatabasePool,
  createIdentityProvider,
  createSecretProvider,
  loadEnvironmentConfig,
  loadVerifiedPolicyBundle,
  resolveDatabaseUrl,
} from '../../../src/runtime/configuration.js';
import { syntheticConfigDocument } from '../../support/environment-fixtures.js';

const databaseUrl =
  'postgresql://gateway:synthetic-password@10.0.0.5:5432/family_brain';
const loopbackDatabaseUrl =
  'postgresql://gateway:synthetic-password@127.0.0.1:5432/family_brain';

const configDocument = syntheticConfigDocument;

const reader =
  (files: Record<string, string>) =>
  (path: string): Promise<string> =>
    path in files
      ? Promise.resolve(files[path] ?? '')
      : Promise.reject(
          Object.assign(new Error(`ENOENT: no such file ${path}`), {
            code: 'ENOENT',
          }),
        );

const live = () => new AbortController().signal;

describe('loadEnvironmentConfig', () => {
  it('loads and validates a configuration file', async () => {
    const config = await loadEnvironmentConfig(
      '/etc/gateway/config.json',
      reader({ '/etc/gateway/config.json': JSON.stringify(configDocument()) }),
    );

    expect(config.environment).toBe('development');
  });

  it('accepts a document with a leading byte-order mark', async () => {
    const config = await loadEnvironmentConfig(
      'config.json',
      reader({ 'config.json': `\uFEFF${JSON.stringify(configDocument())}` }),
    );

    expect(config.environment).toBe('development');
  });

  it.each([
    ['a missing file', {}, 'environment_configuration_unreadable'],
    [
      'malformed JSON',
      { 'config.json': '{"environment":' },
      'environment_configuration_malformed',
    ],
    [
      'an oversized but otherwise valid file',
      {
        'config.json': `${JSON.stringify(configDocument())}${' '.repeat(70_000)}`,
      },
      'environment_configuration_too_large',
    ],
  ])(
    'fails closed on %s with a fixed reason and no echo',
    async (_, files, reason) => {
      const error = await loadEnvironmentConfig(
        'config.json',
        reader(files as Record<string, string>),
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'invalid_request',
        retryable: false,
        details: { reason },
      });
      expect(JSON.stringify(error)).not.toContain('config.json');
      expect(String(error)).not.toContain('ENOENT');
    },
  );

  it('rejects an invalid shape through the schema without echoing values', async () => {
    const error = await loadEnvironmentConfig(
      'config.json',
      reader({ 'config.json': '{"environment":"staging"}' }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('invalid_environment_configuration');
    expect(JSON.stringify(error)).not.toContain('staging');
  });
});

describe('createSecretProvider', () => {
  it('resolves a development handle from the bound environment variable only', async () => {
    const config = await loadEnvironmentConfig(
      'config.json',
      reader({ 'config.json': JSON.stringify(configDocument()) }),
    );
    const secrets = createSecretProvider(config, {
      environmentValues: { DATABASE_URL: databaseUrl, OTHER: 'ignored' },
    });

    await expect(
      secrets.get(
        { environment: 'development', name: 'database_development' },
        live(),
      ),
    ).resolves.toMatchObject({ value: databaseUrl });
    await expect(
      secrets.get(
        { environment: 'production', name: 'database_development' },
        live(),
      ),
    ).rejects.toMatchObject({ code: 'environment_boundary_violation' });
  });

  it('uses Google Secret Manager for production with the configured project', async () => {
    const config = await loadEnvironmentConfig(
      'config.json',
      reader({ 'config.json': JSON.stringify(configDocument('production')) }),
    );
    const names: string[] = [];
    const secrets = createSecretProvider(config, {
      secretManagerClient: {
        accessSecretVersion: (request) => {
          names.push(request.name);
          const data = Buffer.from(databaseUrl, 'utf8');
          return Promise.resolve([
            {
              name: 'projects/123456789012/secrets/gateway-database-url/versions/3',
              payload: { data, dataCrc32c: String(crc32c(data)) },
            },
          ] as const);
        },
      },
    });

    await expect(
      secrets.get(
        { environment: 'production', name: 'database_production' },
        live(),
      ),
    ).resolves.toEqual({ value: databaseUrl, version: '3' });
    expect(names).toEqual([
      'projects/123456789012/secrets/gateway-database-url/versions/latest',
    ]);
  });
});

describe('resolveDatabaseUrl', () => {
  it('returns a PostgreSQL connection URL from the configured handle', async () => {
    const config = await loadEnvironmentConfig(
      'config.json',
      reader({ 'config.json': JSON.stringify(configDocument()) }),
    );
    const secrets = createSecretProvider(config, {
      environmentValues: { DATABASE_URL: loopbackDatabaseUrl },
    });

    await expect(resolveDatabaseUrl(config, secrets, live())).resolves.toBe(
      loopbackDatabaseUrl,
    );
  });

  async function resolve(
    value: string,
    environment: 'development' | 'production' = 'development',
  ) {
    const config = await loadEnvironmentConfig(
      'config.json',
      reader({ 'config.json': JSON.stringify(configDocument(environment)) }),
    );
    const secrets =
      environment === 'production'
        ? createSecretProvider(config, {
            secretManagerClient: {
              accessSecretVersion: () => {
                const data = Buffer.from(value, 'utf8');
                return Promise.resolve([
                  {
                    name: 'projects/123456789012/secrets/gateway-database-url/versions/1',
                    payload: { data, dataCrc32c: String(crc32c(data)) },
                  },
                ] as const);
              },
            },
          })
        : createSecretProvider(config, {
            environmentValues: { DATABASE_URL: value },
          });
    return resolveDatabaseUrl(config, secrets, live());
  }

  it.each([
    [
      'a development loopback TCP URL without TLS',
      'postgresql://gateway:synthetic-password@127.0.0.1:5432/family_brain',
      'development',
    ],
    [
      'a development remote TCP URL with verified TLS',
      `${databaseUrl}?sslmode=verify-full`,
      'development',
    ],
    [
      'a production TCP URL with verified TLS',
      `${databaseUrl}?sslmode=verify-full`,
      'production',
    ],
    [
      'the local PostgreSQL socket in production',
      'postgresql://gateway_runtime:synthetic-password@/family_brain?host=/run/postgresql',
      'production',
    ],
    [
      'the local PostgreSQL socket in development',
      'postgresql://gateway_runtime:synthetic-password@/family_brain?host=/run/postgresql',
      'development',
    ],
  ] as const)('accepts %s', async (_, value, environment) => {
    await expect(resolve(value, environment)).resolves.toBe(value);
  });

  it.each([
    [
      'another scheme',
      'mysql://gateway:synthetic-password@10.0.0.5/family_brain',
      'development',
    ],
    ['a non-URL', 'not a url synthetic-password', 'development'],
    ['no host', 'postgresql://', 'development'],
    ['surrounding whitespace', ` ${databaseUrl}`, 'development'],
    [
      'another socket directory',
      'postgresql://x:synthetic-password@/family_brain?host=/tmp',
      'development',
    ],
    [
      'a directory beneath the socket directory',
      'postgresql://x:synthetic-password@/family_brain?host=/run/postgresql/other',
      'production',
    ],
    [
      'a traversal out of the socket directory',
      'postgresql://x:synthetic-password@/family_brain?host=/run/postgresql/../tmp',
      'production',
    ],
    [
      'the retired Cloud SQL socket form',
      'postgresql://gateway:synthetic-password@/family_brain?host=/cloudsql/example-dev:us-central1:gateway',
      'production',
    ],
    [
      'a socket parameter with a TCP host',
      'postgresql://x:synthetic-password@db/family_brain?host=/run/postgresql',
      'development',
    ],
    [
      'a production socket without a password',
      'postgresql://gateway_runtime@/family_brain?host=/run/postgresql',
      'production',
    ],
    [
      'a socket with a hostaddr that steers to TCP',
      'postgresql://x:synthetic-password@/family_brain?host=/run/postgresql&hostaddr=10.0.0.5',
      'production',
    ],
    [
      'a socket with a TLS mode it cannot use',
      'postgresql://x:synthetic-password@/family_brain?host=/run/postgresql&sslmode=require',
      'production',
    ],
    [
      'a socket without a database',
      'postgresql://x:synthetic-password@/?host=/run/postgresql',
      'production',
    ],
    [
      'a certificate file parameter',
      `${databaseUrl}?sslrootcert=/etc/passwd`,
      'development',
    ],
    ['production TCP without TLS', databaseUrl, 'production'],
    ['development remote TCP without TLS', databaseUrl, 'development'],
    [
      'a duplicated TLS mode (the client reads the last)',
      `${databaseUrl}?sslmode=verify-full&sslmode=disable`,
      'production',
    ],
    [
      'a duplicated TLS mode disabling verification',
      `${databaseUrl}?sslmode=verify-full&sslmode=no-verify`,
      'production',
    ],
    [
      'an encoded hostname naming a socket directory',
      'postgresql://u:synthetic-password@%2Ftmp/family_brain',
      'development',
    ],
    [
      'an encoded hostname aliasing the retired Cloud SQL socket',
      'postgresql://u:synthetic-password@%2Fcloudsql%2Fx/family_brain?sslmode=verify-full',
      'production',
    ],
    [
      'unverified TLS through libpq compatibility',
      `${databaseUrl}?sslmode=require&uselibpqcompat=true`,
      'production',
    ],
    [
      'production TLS without hostname verification (require)',
      `${databaseUrl}?sslmode=require`,
      'production',
    ],
    [
      'production TLS without hostname verification (verify-ca)',
      `${databaseUrl}?sslmode=verify-ca`,
      'production',
    ],
    [
      'an ssl parameter overriding the TLS mode',
      `${databaseUrl}?sslmode=verify-full&ssl=false`,
      'production',
    ],
    [
      'a malformed escape the client re-encodes',
      'postgresql://u%zz:synthetic-password@/family_brain?host=%2Frun/postgresql',
      'production',
    ],
    [
      'a socket user override after the username check',
      'postgresql://gateway_runtime:synthetic-password@/family_brain?host=/run/postgresql&user=postgres',
      'production',
    ],
    [
      'a socket session option',
      'postgresql://gateway_runtime:synthetic-password@/family_brain?host=/run/postgresql&options=-csearch_path%3Devil',
      'production',
    ],
    [
      'a socket replication connection',
      'postgresql://gateway_runtime:synthetic-password@/family_brain?host=/run/postgresql&replication=database',
      'production',
    ],
    [
      'a duplicated socket host',
      'postgresql://gateway_runtime:synthetic-password@/family_brain?host=/run/postgresql&host=/tmp',
      'production',
    ],
    [
      'a production socket with a password but no username',
      'postgresql://:synthetic-password@/family_brain?host=/run/postgresql',
      'production',
    ],
    [
      'whitespace inside the URL',
      'postgresql://u:synthetic password@127.0.0.1/family_brain',
      'development',
    ],
    [
      'production TCP with TLS disabled',
      `${databaseUrl}?sslmode=disable`,
      'production',
    ],
    [
      'production TCP with optional TLS',
      `${databaseUrl}?sslmode=prefer`,
      'production',
    ],
  ] as const)(
    'refuses %s without echoing it',
    async (_, value, environment) => {
      const error = await resolve(value, environment).catch(
        (caught: unknown) => caught,
      );

      expect(error).toMatchObject({
        code: 'invalid_request',
        details: { reason: 'invalid_database_connection_secret' },
      });
      expect(JSON.stringify(error)).not.toContain('synthetic-password');
    },
  );
});

describe('refusal before the client parses', () => {
  it.each([
    [
      'a certificate file the client would read',
      '?sslrootcert=/nonexistent/synthetic.crt',
    ],
    [
      'an invalid negotiation mode the client would throw on',
      '?sslnegotiation=bogus',
    ],
  ])('refuses %s with the fixed reason', async (_, query) => {
    const config = await loadEnvironmentConfig(
      'config.json',
      reader({ 'config.json': JSON.stringify(configDocument()) }),
    );
    const secrets = createSecretProvider(config, {
      environmentValues: {
        DATABASE_URL: `postgresql://gateway:synthetic-password@127.0.0.1:5432/family_brain${query}`,
      },
    });

    await expect(
      resolveDatabaseUrl(config, secrets, live()),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'invalid_database_connection_secret' },
    });
  });
});

describe('resolveDatabaseUrl with the socket-only deployment transport', () => {
  // The e2-micro VM (owner decision 2026-10-27, Option A): the deployment
  // requires the local socket even where the general rules allow TLS TCP.
  async function resolveSocketOnly(
    value: string,
    environment: 'development' | 'production',
  ) {
    const config = await loadEnvironmentConfig(
      'config.json',
      reader({ 'config.json': JSON.stringify(configDocument(environment)) }),
    );
    const secrets =
      environment === 'production'
        ? createSecretProvider(config, {
            secretManagerClient: {
              accessSecretVersion: () => {
                const data = Buffer.from(value, 'utf8');
                return Promise.resolve([
                  {
                    name: 'projects/123456789012/secrets/gateway-database-url/versions/1',
                    payload: { data, dataCrc32c: String(crc32c(data)) },
                  },
                ] as const);
              },
            },
          })
        : createSecretProvider(config, {
            environmentValues: { DATABASE_URL: value },
          });
    return resolveDatabaseUrl(config, secrets, live(), {
      transport: 'unix_socket',
    });
  }

  it.each(['development', 'production'] as const)(
    'accepts the local socket in %s',
    async (environment) => {
      const value =
        'postgresql://gateway_runtime:synthetic-password@/family_brain?host=/run/postgresql';
      await expect(resolveSocketOnly(value, environment)).resolves.toBe(value);
    },
  );

  it.each([
    [
      'production TCP with verified TLS',
      `${databaseUrl}?sslmode=verify-full`,
      'production',
    ],
    [
      'development TCP with verified TLS',
      `${databaseUrl}?sslmode=verify-full`,
      'development',
    ],
    [
      'development loopback TCP',
      'postgresql://gateway:synthetic-password@127.0.0.1:5432/family_brain',
      'development',
    ],
  ] as const)(
    'refuses %s with a fixed reason',
    async (_, value, environment) => {
      await expect(resolveSocketOnly(value, environment)).rejects.toMatchObject(
        {
          code: 'invalid_request',
          details: { reason: 'database_socket_required' },
        },
      );
    },
  );

  it('still applies the general rules to a socket URL', async () => {
    await expect(
      resolveSocketOnly(
        'postgresql://gateway_runtime:synthetic-password@/family_brain?host=/tmp',
        'production',
      ),
    ).rejects.toMatchObject({
      details: { reason: 'invalid_database_connection_secret' },
    });
  });
});

describe('resolveDatabaseUrl before the client parses', () => {
  it.each(['require', 'verify-ca', 'prefer', 'no-verify', 'disable'])(
    'refuses sslmode=%s without a client security warning',
    async (mode) => {
      const config = await loadEnvironmentConfig(
        'config.json',
        reader({ 'config.json': JSON.stringify(configDocument()) }),
      );
      const secrets = createSecretProvider(config, {
        environmentValues: {
          DATABASE_URL: `postgresql://gateway:synthetic-password@db.example.test:5432/family_brain?sslmode=${mode}`,
        },
      });
      const emitted = vi
        .spyOn(process, 'emitWarning')
        .mockImplementation(() => undefined);
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
        /* captured */
      });
      try {
        await expect(
          resolveDatabaseUrl(config, secrets, live()),
        ).rejects.toMatchObject({
          details: { reason: 'invalid_database_connection_secret' },
        });
        expect(emitted).not.toHaveBeenCalled();
        expect(warned).not.toHaveBeenCalled();
      } finally {
        emitted.mockRestore();
        warned.mockRestore();
      }
    },
  );
});

describe('what the PostgreSQL client uses for accepted URLs', () => {
  it.each([
    [
      'postgresql://gateway_runtime:synthetic-password@/family_brain?host=/run/postgresql',
      '/run/postgresql',
      false,
    ],
    [
      'postgresql://gateway:synthetic-password@10.0.0.5:5432/family_brain?sslmode=verify-full',
      '10.0.0.5',
      true,
    ],
    [
      'postgresql://gateway:synthetic-password@127.0.0.1:5432/family_brain',
      '127.0.0.1',
      false,
    ],
  ] as const)('%s', (connectionString, host, verified) => {
    const client = new pg.Client({ connectionString });

    expect(client.host).toBe(host);
    if (verified) {
      expect(client.ssl).toMatchObject({});
      expect(
        (client.ssl as unknown as { rejectUnauthorized?: unknown })
          .rejectUnauthorized,
      ).not.toBe(false);
    } else {
      expect(client.ssl).toBe(false);
    }
  });
});

describe('the accepted socket form', () => {
  it('is read by the PostgreSQL client as the local socket and database', () => {
    const client = new pg.Client({
      connectionString:
        'postgresql://gateway_runtime:synthetic-password@/family_brain?host=/run/postgresql',
    });

    expect(client.host).toBe('/run/postgresql');
    expect(client.database).toBe('family_brain');
    expect(client.user).toBe('gateway_runtime');
    expect(client.ssl).toBe(false);
  });
});

describe('createDatabasePool', () => {
  it('creates a bounded pool without connecting', async () => {
    const pool = createDatabasePool(databaseUrl);

    expect(pool.options).toMatchObject({
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
    expect(pool.totalCount).toBe(0);
    await pool.end();
  });
});

describe('loadVerifiedPolicyBundle', () => {
  const directory = new URL('../../../config/policy/', import.meta.url);

  it('loads the governed policy bundle from its directory', async () => {
    const bundle = await loadVerifiedPolicyBundle(directory);

    expect(bundle.policy.version).toBe('family-brain-v1.2.0');
  });

  it('refuses a directory URL without a trailing slash', async () => {
    await expect(
      loadVerifiedPolicyBundle(
        new URL('../../../config/policy', import.meta.url),
      ),
    ).rejects.toThrow('invalid_policy_directory');
  });

  it('refuses a tampered policy as drift', async () => {
    const original = await readFile(
      new URL('family-brain-v1.yaml', directory),
      'utf8',
    );

    await expect(
      loadVerifiedPolicyBundle(directory, (url) =>
        url.href.endsWith('family-brain-v1.yaml')
          ? Promise.resolve(`${original}\n# tampered\n`)
          : readFile(url, 'utf8'),
      ),
    ).rejects.toMatchObject({ code: 'policy_drift' });
  });
});

describe('createIdentityProvider', () => {
  it('builds the Google OIDC provider from the configured identity', async () => {
    const config = await loadEnvironmentConfig(
      'config.json',
      reader({ 'config.json': JSON.stringify(configDocument()) }),
    );

    expect(createIdentityProvider(config)).toBeInstanceOf(
      GoogleOidcIdentityProvider,
    );
  });
});

describe('database pool errors', () => {
  it('handles an idle client error without crashing or echoing it', () => {
    const lines: string[] = [];
    const pool = createDatabasePool(databaseUrl, (line) => lines.push(line));

    expect(() =>
      pool.emit(
        'error',
        new Error(`terminating connection ${databaseUrl}`),
        {},
      ),
    ).not.toThrow();
    expect(lines).toEqual([
      '{"severity":"WARNING","msg":"database_idle_client_error"}\n',
    ]);
    void pool.end();
  });
});
