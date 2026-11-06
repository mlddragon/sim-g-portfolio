import { runMigrations } from '../src/adapters/state/postgres/migrate.js';
import { createPostgresPool } from '../src/adapters/state/postgres/pool.js';

const testHosts = new Set(['127.0.0.1', 'localhost', '::1']);

function requiredConnectionString(environmentVariable: string): string {
  const value = process.env[environmentVariable];
  if (value === undefined || value.length === 0) {
    throw new Error(`${environmentVariable} is required`);
  }
  return value;
}

function assertPostgresUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Database connection string must be a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('Database connection string must use PostgreSQL');
  }
  return parsed;
}

function assertIsolatedTestDatabase(parsed: URL): void {
  if (!testHosts.has(parsed.hostname)) {
    throw new Error('Test migrations require a loopback PostgreSQL host');
  }
  if (!parsed.pathname.slice(1).endsWith('_test')) {
    throw new Error('Test migrations require a database ending in _test');
  }
  if (parsed.username !== 'gateway_test') {
    throw new Error('Test migrations require the gateway_test role');
  }
}

async function main(): Promise<void> {
  const argumentsSet = new Set(process.argv.slice(2));
  const testMode = argumentsSet.delete('--test');
  if (argumentsSet.size > 0) {
    throw new Error('Unsupported migration command argument');
  }

  const environmentVariable = testMode ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  const connectionString = requiredConnectionString(environmentVariable);
  const parsed = assertPostgresUrl(connectionString);
  if (testMode) {
    assertIsolatedTestDatabase(parsed);
  }

  const pool = createPostgresPool({
    connectionString,
    applicationName: testMode
      ? 'family-brain-gateway-test-migrations'
      : 'family-brain-gateway-migrations',
    maximumConnections: 1,
  });
  try {
    await runMigrations(pool);
    process.stdout.write('Database migrations completed successfully.\n');
  } finally {
    await pool.end();
  }
}

await main();
