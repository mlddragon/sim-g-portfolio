import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueryResultRow } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { DomainError } from '../../src/domain/errors.js';
import {
  createTestPool,
  queryRows,
  requireTestDatabaseUrl,
} from '../support/postgres.js';

interface CountRow extends QueryResultRow {
  readonly count: string;
}

interface RoleRow extends QueryResultRow {
  readonly current_user: string;
  readonly rolsuper: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolreplication: boolean;
}

interface TableRow extends QueryResultRow {
  readonly table_name: string;
}

const connectionString = requireTestDatabaseUrl();
const pool = createTestPool(connectionString);
const temporaryDirectories: string[] = [];

async function temporaryMigrationDirectory(): Promise<URL> {
  const directory = await mkdtemp(join(tmpdir(), 'sim-g-migrations-'));
  temporaryDirectories.push(directory);
  return new URL(`file://${directory}/`);
}

describe('PostgreSQL migrations', () => {
  beforeAll(async () => {
    await runMigrations(pool);
  });

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('is repeatable and records the immutable migration hashes', async () => {
    await runMigrations(pool);
    const rows = await queryRows<CountRow>(
      pool,
      'SELECT count(*)::text AS count FROM gateway_schema_migrations',
    );
    expect(rows[0]?.count).toBe('6');
  });

  it('runs through a non-superuser role without database administration rights', async () => {
    const rows = await queryRows<RoleRow>(
      pool,
      `SELECT
         current_user,
         rolsuper,
         rolcreatedb,
         rolcreaterole,
         rolreplication
       FROM pg_roles
       WHERE rolname = current_user`,
    );
    expect(rows).toEqual([
      {
        current_user: 'gateway_test',
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
      },
    ]);
  });

  it('creates only the approved operational tables and no Brain content mirror', async () => {
    const rows = await queryRows<TableRow>(
      pool,
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      'approval_requests',
      'audit_outbox',
      'brain_record_aliases',
      'elevation_challenges',
      'gateway_schema_migrations',
      'identity_bindings',
      'operations',
      'policy_versions',
      'principals',
      'project_registry_versions',
      'reconciliation_attempts',
    ]);
  });

  it('rejects a renamed applied migration even when its content is unchanged', async () => {
    const directory = await temporaryMigrationDirectory();
    const content = await readFile(
      new URL('../../migrations/000001_operational_state.sql', import.meta.url),
      'utf8',
    );
    await writeFile(new URL('000001_renamed.sql', directory), content, 'utf8');

    await expect(runMigrations(pool, { directory })).rejects.toMatchObject<
      Partial<DomainError>
    >({
      code: 'policy_drift',
      retryable: false,
    });
  });

  it('rejects duplicate migration versions before applying either file', async () => {
    const directory = await temporaryMigrationDirectory();
    await writeFile(new URL('990001_first.sql', directory), 'SELECT 1;\n');
    await writeFile(new URL('990001_second.sql', directory), 'SELECT 2;\n');

    try {
      await expect(runMigrations(pool, { directory })).rejects.toMatchObject<
        Partial<DomainError>
      >({
        code: 'policy_drift',
        retryable: false,
      });
      const rows = await queryRows<CountRow>(
        pool,
        `SELECT count(*)::text AS count
         FROM gateway_schema_migrations
         WHERE version = '990001'`,
      );
      expect(rows[0]?.count).toBe('0');
    } finally {
      await pool.query(
        "DELETE FROM gateway_schema_migrations WHERE version = '990001'",
      );
    }
  });
});
