import pg, { type Pool } from 'pg';

import { runMigrations } from './adapters/state/postgres/migrate.js';
import { createPostgresPool } from './adapters/state/postgres/pool.js';
import { DomainError } from './domain/errors.js';

/** Everything the migration command touches outside the process, injectable for tests. */
export interface MigrationDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly stdout: { write(line: string): unknown };
  readonly stderr: { write(line: string): unknown };
  readonly createPool?: (connectionString: string) => Pool;
  readonly migrate?: (pool: Pool) => Promise<void>;
}

class MigrationFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const localSocketDirectory = '/run/postgresql';
const loopbackHosts: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);
const socketParameters: ReadonlySet<string> = new Set(['host']);
const tcpParameters: ReadonlySet<string> = new Set(['sslmode']);
const malformedEscape = /%(?![0-9A-Fa-f]{2})/u;
const emptyHost = /^(postgres(?:ql)?:\/\/(?:[^@/?#]*@)?)\//u;
const safeReason = /^[a-z][a-z0-9_]{0,95}$/u;
const sqlState = /^[0-9A-Z]{5}$/u;
// libpq-style variables would let the launcher's environment change the role,
// session options or TLS behind the validated URL.
const postgresEnvironment = /^PG[A-Z]/u;

function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/u.test(character)) return true;
  }
  return false;
}

/**
 * Migrations run on the VM itself, next to PostgreSQL: only the local socket
 * (peer or password authentication) or a loopback TCP host is accepted, never
 * a remote database. The URL is checked against what node-postgres will use.
 */
function migrationConnectionString(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new MigrationFailure('migration_database_url_required');
  }
  const invalid = () => new MigrationFailure('invalid_migration_database_url');
  if (malformedEscape.test(value) || hasUnsafeCharacter(value)) throw invalid();
  const socketForm = emptyHost.test(value);
  let url: URL;
  try {
    url = new URL(
      socketForm ? value.replace(emptyHost, '$1socket.invalid/') : value,
    );
  } catch {
    throw invalid();
  }
  const parameters = url.searchParams;
  const keys = [...parameters.keys()];
  const socket = parameters.has('host');
  if (
    (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') ||
    new Set(keys).size !== keys.length ||
    url.pathname.length <= 1 ||
    url.hash.length > 0 ||
    keys.some((key) => !(socket ? socketParameters : tcpParameters).has(key))
  ) {
    throw invalid();
  }
  if (url.username.length === 0) throw invalid();
  let host: string;
  let ssl: unknown;
  try {
    const client = new pg.Client({ connectionString: value });
    host = client.host;
    ssl = client.ssl;
  } catch {
    throw invalid();
  }
  if (socket) {
    if (
      Boolean(ssl) ||
      !socketForm ||
      parameters.get('host') !== localSocketDirectory ||
      host !== localSocketDirectory
    ) {
      throw invalid();
    }
    return value;
  }
  const hostname = url.hostname.toLowerCase();
  if (
    socketForm ||
    url.hostname.includes('%') ||
    !loopbackHosts.has(hostname) ||
    host.toLowerCase() !== hostname
  ) {
    throw invalid();
  }
  return value;
}

function failureReason(error: unknown): string {
  if (error instanceof MigrationFailure) return error.reason;
  // A PostgreSQL error's five-character SQLSTATE is safe to report; its
  // message is not.
  const code: unknown =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof code === 'string' && sqlState.test(code)) {
    return `sqlstate_${code.toLowerCase()}`;
  }
  if (error instanceof DomainError) {
    const reason: unknown = error.details['reason'];
    return typeof reason === 'string' && safeReason.test(reason)
      ? reason
      : error.code;
  }
  return 'unexpected_migration_failure';
}

/**
 * Applies the SQL migrations shipped in the image with one connection, as the
 * migration role, and resolves the exit code. It never echoes the URL, a
 * message or a cause; failures report one fixed reason.
 */
export async function runMigrationCommand(
  dependencies: MigrationDependencies,
): Promise<number> {
  let pool: Pool | undefined;
  try {
    if (dependencies.argv.length > 0) {
      throw new MigrationFailure('unsupported_migration_argument');
    }
    if (
      Object.entries(dependencies.env).some(
        ([name, value]) =>
          postgresEnvironment.test(name) && value !== undefined,
      )
    ) {
      throw new MigrationFailure('postgres_environment_override_refused');
    }
    const connectionString = migrationConnectionString(
      dependencies.env['GATEWAY_MIGRATION_DATABASE_URL'],
    );
    pool = (
      dependencies.createPool ??
      ((url: string) =>
        createPostgresPool({
          connectionString: url,
          applicationName: 'family-brain-gateway-migrations',
          maximumConnections: 1,
        }))
    )(connectionString);
    await (dependencies.migrate ?? ((target) => runMigrations(target)))(pool);
    dependencies.stdout.write(
      `${JSON.stringify({ severity: 'INFO', msg: 'migrations_completed' })}\n`,
    );
    return 0;
  } catch (error) {
    dependencies.stderr.write(
      `${JSON.stringify({
        severity: 'ERROR',
        msg: 'migration_failed',
        reason: failureReason(error),
      })}\n`,
    );
    return 1;
  } finally {
    await pool?.end().catch(() => undefined);
  }
}
