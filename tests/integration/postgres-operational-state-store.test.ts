import type { QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe } from 'vitest';

import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { PostgresOperationalStateStore } from '../../src/adapters/state/postgres/postgres-operational-state-store.js';
import { operationalStateStoreContract } from '../contract/operational-state-store.contract.js';
import {
  createTestPool,
  queryRows,
  requireTestDatabaseUrl,
  resetOperationalState,
} from '../support/postgres.js';

const connectionString = requireTestDatabaseUrl();

describe('PostgresOperationalStateStore', () => {
  let pool = createTestPool(connectionString);

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await resetOperationalState(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  operationalStateStoreContract({
    getStore: () => new PostgresOperationalStateStore(pool),
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ) => queryRows<Row & QueryResultRow>(pool, text, values),
    restart: async () => {
      await pool.end();
      pool = createTestPool(connectionString);
      await pool.query('SELECT 1');
    },
  });
});
