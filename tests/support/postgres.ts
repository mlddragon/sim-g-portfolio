import type { QueryResultRow } from 'pg';
import { Pool } from 'pg';

const allowedTestHosts = new Set(['127.0.0.1', 'localhost', '::1']);

export function requireTestDatabaseUrl(): string {
  const value = process.env['TEST_DATABASE_URL'];
  if (value === undefined || value.length === 0) {
    throw new Error('TEST_DATABASE_URL is required for PostgreSQL tests');
  }

  const parsed = new URL(value);
  const databaseName = parsed.pathname.slice(1);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('TEST_DATABASE_URL must use PostgreSQL');
  }
  if (!allowedTestHosts.has(parsed.hostname)) {
    throw new Error('PostgreSQL tests require a loopback database');
  }
  if (!databaseName.endsWith('_test')) {
    throw new Error('PostgreSQL tests require a database ending in _test');
  }

  return value;
}

export function createTestPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
  });
}

export async function resetOperationalState(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      audit_outbox,
      reconciliation_attempts,
      project_registry_versions,
      policy_versions,
      brain_record_aliases,
      elevation_challenges,
      approval_requests,
      operations,
      identity_bindings
    RESTART IDENTITY CASCADE
  `);
}

export async function queryRows<Row extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly Row[]> {
  const result = await pool.query<Row>(text, [...values]);
  return result.rows;
}
