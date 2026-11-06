import { describe, expect, it } from 'vitest';

import { DomainError } from '../../../src/domain/errors.js';
import {
  runMigrationCommand,
  type MigrationDependencies,
} from '../../../src/migration-main.js';

const socketUrl =
  'postgresql://gateway_migrator@/family_brain_gateway?host=/run/postgresql';

function harness(overrides: Partial<MigrationDependencies> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const pools: { connectionString: string; ended: boolean }[] = [];
  const migrated: unknown[] = [];
  const dependencies: MigrationDependencies = {
    env: { GATEWAY_MIGRATION_DATABASE_URL: socketUrl },
    argv: [],
    stdout: { write: (line) => out.push(line) },
    stderr: { write: (line) => err.push(line) },
    createPool: (connectionString) => {
      const pool = { connectionString, ended: false };
      pools.push(pool);
      return {
        end: () => {
          pool.ended = true;
          return Promise.resolve();
        },
      } as never;
    },
    migrate: (pool) => {
      migrated.push(pool);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { dependencies, out, err, pools, migrated };
}

const lines = (written: string[]) =>
  written.map((line) => JSON.parse(line) as Record<string, unknown>);

describe('runMigrationCommand', () => {
  it.each([
    ['the local socket with peer authentication', socketUrl],
    [
      'the local socket with a password',
      'postgresql://gateway_migrator:synthetic-password@/family_brain_gateway?host=/run/postgresql',
    ],
    [
      'loopback TCP for development and CI',
      'postgresql://gateway_test:synthetic-password@127.0.0.1:5432/family_brain_gateway_test',
    ],
  ])(
    'migrates over %s with one connection, then closes the pool',
    async (_, url) => {
      const run = harness({ env: { GATEWAY_MIGRATION_DATABASE_URL: url } });

      await expect(runMigrationCommand(run.dependencies)).resolves.toBe(0);

      expect(run.migrated).toHaveLength(1);
      expect(run.pools).toEqual([{ connectionString: url, ended: true }]);
      expect(lines(run.out)).toEqual([
        { severity: 'INFO', msg: 'migrations_completed' },
      ]);
      expect(run.err).toEqual([]);
    },
  );

  it.each([
    [
      'a remote host, even with verified TLS',
      'postgresql://m:synthetic-password@db.example.invalid/fb?sslmode=verify-full',
    ],
    [
      'another socket directory',
      'postgresql://m:synthetic-password@/fb?host=/tmp',
    ],
    [
      'the retired Cloud SQL socket',
      'postgresql://m:synthetic-password@/fb?host=/cloudsql/p:r:i',
    ],
    ['an encoded hostname', 'postgresql://m:synthetic-password@%2Ftmp/fb'],
    [
      'a repeated key',
      'postgresql://m:synthetic-password@/fb?host=/run/postgresql&host=/tmp',
    ],
    [
      'a role override',
      'postgresql://m:synthetic-password@/fb?host=/run/postgresql&user=postgres',
    ],
    [
      'a session option',
      'postgresql://m:synthetic-password@127.0.0.1/fb?options=-csearch_path%3Devil',
    ],
    ['no database', 'postgresql://m:synthetic-password@/?host=/run/postgresql'],
    ['another scheme', 'mysql://m:synthetic-password@127.0.0.1/fb'],
    ['a non-URL', 'synthetic-password not a url'],
  ])('refuses %s without echoing it or connecting', async (_, url) => {
    const run = harness({ env: { GATEWAY_MIGRATION_DATABASE_URL: url } });

    await expect(runMigrationCommand(run.dependencies)).resolves.toBe(1);

    expect(lines(run.err)).toEqual([
      {
        severity: 'ERROR',
        msg: 'migration_failed',
        reason: 'invalid_migration_database_url',
      },
    ]);
    expect(run.err.join('')).not.toContain('synthetic-password');
    expect(run.pools).toEqual([]);
  });

  it.each([
    [
      'no role name',
      'postgresql://@/family_brain_gateway?host=/run/postgresql',
    ],
    [
      'IPv6 loopback, which the client keeps bracketed',
      'postgresql://m:synthetic-password@[::1]/fb',
    ],
    [
      'a trailing-dot loopback name',
      'postgresql://m:synthetic-password@localhost./fb',
    ],
    [
      'a backslash userinfo trick',
      'postgresql://m:synthetic-password@127.0.0.1\\@evil/fb',
    ],
  ])('refuses %s', async (_, url) => {
    const run = harness({ env: { GATEWAY_MIGRATION_DATABASE_URL: url } });
    await expect(runMigrationCommand(run.dependencies)).resolves.toBe(1);
    expect(lines(run.err)[0]).toMatchObject({
      reason: 'invalid_migration_database_url',
    });
    expect(run.pools).toEqual([]);
  });

  it.each(['PGOPTIONS', 'PGUSER', 'PGSSLMODE', 'PGHOST', 'PGREPLICATION'])(
    'refuses to run with %s inherited from the environment',
    async (name) => {
      const run = harness({
        env: {
          GATEWAY_MIGRATION_DATABASE_URL: socketUrl,
          [name]: 'synthetic-override',
        },
      });
      await expect(runMigrationCommand(run.dependencies)).resolves.toBe(1);
      expect(lines(run.err)[0]).toMatchObject({
        reason: 'postgres_environment_override_refused',
      });
      expect(run.pools).toEqual([]);
    },
  );

  it('reports a database failure by its SQLSTATE class only', async () => {
    const run = harness({
      migrate: () =>
        Promise.reject(
          Object.assign(
            new Error('canceling statement due to statement timeout'),
            {
              code: '57014',
            },
          ),
        ),
    });
    await expect(runMigrationCommand(run.dependencies)).resolves.toBe(1);
    expect(lines(run.err)).toEqual([
      { severity: 'ERROR', msg: 'migration_failed', reason: 'sqlstate_57014' },
    ]);
    expect(run.err.join('')).not.toContain('statement timeout');
  });

  it('requires the migration URL and refuses unknown arguments', async () => {
    const missing = harness({ env: {} });
    await expect(runMigrationCommand(missing.dependencies)).resolves.toBe(1);
    expect(lines(missing.err)[0]).toMatchObject({
      reason: 'migration_database_url_required',
    });

    const extra = harness({ argv: ['--force'] });
    await expect(runMigrationCommand(extra.dependencies)).resolves.toBe(1);
    expect(lines(extra.err)[0]).toMatchObject({
      reason: 'unsupported_migration_argument',
    });
    expect(extra.pools).toEqual([]);
  });

  it('reports a migration failure by its fixed reason and still closes the pool', async () => {
    const drift = harness({
      migrate: () =>
        Promise.reject(
          new DomainError('policy_drift', false, {
            reason: 'migration_content_changed',
          }),
        ),
    });
    await expect(runMigrationCommand(drift.dependencies)).resolves.toBe(1);
    expect(lines(drift.err)).toEqual([
      {
        severity: 'ERROR',
        msg: 'migration_failed',
        reason: 'migration_content_changed',
      },
    ]);
    expect(drift.pools[0]?.ended).toBe(true);

    const raw = harness({
      migrate: () =>
        Promise.reject(new Error('synthetic connection refused at host:5432')),
    });
    await expect(runMigrationCommand(raw.dependencies)).resolves.toBe(1);
    expect(lines(raw.err)[0]).toMatchObject({
      reason: 'unexpected_migration_failure',
    });
    expect(raw.err.join('')).not.toContain('5432');
    expect(raw.pools[0]?.ended).toBe(true);
  });
});
