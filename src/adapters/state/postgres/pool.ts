import { Pool } from 'pg';

export interface PostgresPoolConfig {
  readonly connectionString: string;
  readonly applicationName: string;
  readonly maximumConnections?: number;
  readonly connectionTimeoutMilliseconds?: number;
  readonly idleTimeoutMilliseconds?: number;
  readonly statementTimeoutMilliseconds?: number;
  readonly ssl?: boolean;
  /** Receives one fixed line when an idle client fails; never the error. */
  readonly onIdleClientError?: (line: string) => void;
}

const idleClientErrorLine = `${JSON.stringify({
  severity: 'WARNING',
  msg: 'database_idle_client_error',
})}\n`;

export function createPostgresPool(config: PostgresPoolConfig): Pool {
  const pool = new Pool({
    application_name: config.applicationName,
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMilliseconds ?? 5_000,
    idleTimeoutMillis: config.idleTimeoutMilliseconds ?? 30_000,
    max: config.maximumConnections ?? 10,
    ssl: config.ssl,
    statement_timeout: config.statementTimeoutMilliseconds ?? 15_000,
  });
  // An idle client dropped by the server (failover, maintenance) must not
  // become an unhandled 'error' event that crashes the process; the pool
  // replaces the client on next use.
  const report =
    config.onIdleClientError ??
    ((line: string) => {
      process.stderr.write(line);
    });
  pool.on('error', () => {
    report(idleClientErrorLine);
  });
  return pool;
}
