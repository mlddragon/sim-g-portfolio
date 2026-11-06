import { describe, expect, it } from 'vitest';

import { runMigrationCommand } from '../../src/migration-main.js';
import { requireTestDatabaseUrl } from '../support/postgres.js';

const connectionString = requireTestDatabaseUrl();

describe('the compiled migration command over PostgreSQL', () => {
  it('applies the shipped migrations over loopback and is idempotent', async () => {
    const run = async () => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runMigrationCommand({
        env: { GATEWAY_MIGRATION_DATABASE_URL: connectionString },
        argv: [],
        stdout: { write: (line: string) => out.push(line) },
        stderr: { write: (line: string) => err.push(line) },
      });
      return { code, out, err };
    };

    const first = await run();
    const second = await run();

    expect(first).toEqual({
      code: 0,
      out: ['{"severity":"INFO","msg":"migrations_completed"}\n'],
      err: [],
    });
    expect(second.code).toBe(0);
  });
});
