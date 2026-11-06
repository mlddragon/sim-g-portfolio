import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import type { Pool, PoolClient } from 'pg';

import { DomainError } from '../../../domain/errors.js';

const migrationFilePattern = /^(\d{6})_[a-z0-9_]+\.sql$/u;
const migrationLockKey = '7420116918755271';
const defaultMigrationDirectory = new URL(
  '../../../../migrations/',
  import.meta.url,
);

export interface RunMigrationsOptions {
  readonly directory?: URL;
}

interface AppliedMigrationRow {
  readonly version: string;
  readonly filename: string;
  readonly content_hash: string;
}

async function migrationFiles(directory: URL): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name);
  const versions = new Set<string>();

  for (const filename of sqlFiles) {
    const match = migrationFilePattern.exec(filename);
    const version = match?.[1];
    if (version === undefined) {
      throw new DomainError('policy_drift', false, {
        artifact: 'database_migration',
        reason: 'invalid_migration_filename',
      });
    }
    if (versions.has(version)) {
      throw new DomainError('policy_drift', false, {
        artifact: 'database_migration',
        reason: 'duplicate_migration_version',
        version,
      });
    }
    versions.add(version);
  }

  return sqlFiles.sort();
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
      version text PRIMARY KEY,
      filename text NOT NULL UNIQUE,
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations(
  pool: Pool,
  options: RunMigrationsOptions = {},
): Promise<void> {
  const directory = options.directory ?? defaultMigrationDirectory;
  const files = await migrationFiles(directory);
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [
      migrationLockKey,
    ]);
    await ensureMigrationTable(client);

    const applied = await client.query<AppliedMigrationRow>(
      'SELECT version, filename, content_hash FROM gateway_schema_migrations',
    );
    const appliedByVersion = new Map(
      applied.rows.map((row) => [
        row.version,
        { filename: row.filename, contentHash: row.content_hash },
      ]),
    );

    for (const filename of files) {
      const match = migrationFilePattern.exec(filename);
      if (match === null) {
        continue;
      }
      const version = match[1];
      if (version === undefined) {
        throw new DomainError('internal_error', false, {
          reason: 'invalid_migration_filename',
        });
      }

      const content = await readFile(new URL(filename, directory), 'utf8');
      const hash = contentHash(content);
      const previous = appliedByVersion.get(version);
      if (previous !== undefined) {
        if (previous.filename !== filename || previous.contentHash !== hash) {
          throw new DomainError('policy_drift', false, {
            artifact: 'database_migration',
            version,
          });
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(content);
        await client.query(
          `INSERT INTO gateway_schema_migrations
            (version, filename, content_hash)
           VALUES ($1, $2, $3)`,
          [version, filename, hash],
        );
        await client.query('COMMIT');
        appliedByVersion.set(version, { filename, contentHash: hash });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [
        migrationLockKey,
      ]);
    } finally {
      client.release();
    }
  }
}
