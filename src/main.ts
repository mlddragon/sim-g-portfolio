import { readFile as readFileFromDisk } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import type { Pool } from 'pg';

import { PostgresOperationalStateStore } from './adapters/state/postgres/postgres-operational-state-store.js';
import { CloudLoggingAuditSink } from './adapters/audit/cloud-logging-audit-sink.js';
import { CloudLoggingTelemetrySink } from './adapters/telemetry/cloud-logging-telemetry-sink.js';
import {
  AuditOutboxService,
  defaultAuditBatchSize,
} from './application/audit-outbox-service.js';
import type { ApiOptions } from './api/build-app.js';
import { composeGateway } from './bootstrap.js';
import type { EnvironmentConfig } from './config/environment.js';
import type { IdentityProvider } from './ports/identity-provider.js';
import type { TelemetrySink } from './ports/telemetry-sink.js';
import { AuditDeliveryLoop } from './runtime/audit-delivery.js';
import { DomainError } from './domain/errors.js';
import type { Clock } from './ports/clock.js';
import {
  createDatabasePool,
  createIdentityProvider,
  createSecretProvider,
  loadEnvironmentConfig,
  loadVerifiedPolicyBundle,
  resolveDatabaseUrl,
} from './runtime/configuration.js';
import { createDriveWorkloadAuth } from './runtime/drive-auth.js';
import {
  createRuntimeProviders,
  type RuntimeProviderOptions,
  type RuntimeProviders,
} from './runtime/providers.js';
import { startServer, type SignalSource } from './server.js';

/** Everything `main` touches outside the process, injectable for tests. */
export interface MainDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile?: (path: string) => Promise<string>;
  /** The governed policy files; defaults to `config/policy/` in the working directory. */
  readonly policyDirectory?: URL;
  readonly createPool?: (connectionString: string) => Pool;
  readonly createDriveAuth?: typeof createDriveWorkloadAuth;
  readonly createProviders?: (
    options: RuntimeProviderOptions,
  ) => Promise<RuntimeProviders>;
  readonly signals?: SignalSource;
  readonly stderr?: { write(line: string): unknown };
  readonly logStream?: Writable;
  readonly clock?: Clock;
  readonly onListening?: (url: string) => void;
  readonly startupTimeoutMs?: number;
  readonly telemetry?: TelemetrySink;
  readonly createIdentity?: (config: EnvironmentConfig) => IdentityProvider;
  readonly auditOutbox?: (
    store: PostgresOperationalStateStore,
  ) => Pick<AuditOutboxService, 'flush'>;
  readonly auditDeliveryIntervalMs?: number;
  /** Overrides the API's per-minute limits; production uses the defaults. */
  readonly rateLimits?: ApiOptions['rateLimits'];
}

const startupTimeoutMs = 30_000;
const safeReason = /^[a-z][a-z0-9_]{0,95}$/u;

class StartupFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** A fixed reason for any startup failure; never a message, path or secret. */
function failureReason(error: unknown): string {
  if (error instanceof StartupFailure) return error.reason;
  if (error instanceof DomainError) {
    const reason: unknown = error.details['reason'];
    return typeof reason === 'string' && safeReason.test(reason)
      ? reason
      : error.code;
  }
  if (error instanceof TypeError && safeReason.test(error.message)) {
    return error.message;
  }
  return 'unexpected_startup_failure';
}

function integerFrom(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  reason: string,
): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]{1,5}$/u.test(value)) throw new StartupFailure(reason);
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) throw new StartupFailure(reason);
  return parsed;
}

interface Prepared {
  readonly app: Awaited<ReturnType<typeof composeGateway>>;
  readonly pool: Pool;
  readonly store: PostgresOperationalStateStore;
  readonly port: number;
}

const defaultAuditDeliveryIntervalMs = 5_000;

/** Everything before listening; the pool lands in `holder` as soon as it exists. */
async function prepare(
  dependencies: MainDependencies,
  holder: { pool?: Pool },
  signal: AbortSignal,
  stderr: { write(line: string): unknown },
): Promise<Prepared> {
  const { env } = dependencies;
  const configPath = env['GATEWAY_CONFIG_PATH'];
  if (configPath === undefined || configPath.length === 0) {
    throw new StartupFailure('gateway_config_path_required');
  }
  const config = await loadEnvironmentConfig(
    configPath,
    dependencies.readFile ?? ((path) => readFileFromDisk(path, 'utf8')),
  );
  // Cloud Run provides PORT and fronts the service with one proxy hop. Outside
  // production the hop count must be explicit, so a direct run never trusts a
  // client-supplied X-Forwarded-For by default.
  const port = integerFrom(
    env['PORT'],
    config.server.port,
    0,
    65_535,
    'invalid_port',
  );
  if (
    config.environment !== 'production' &&
    env['GATEWAY_TRUSTED_PROXY_HOPS'] === undefined
  ) {
    throw new StartupFailure('trusted_proxy_hops_required');
  }
  const trustedProxyHops = integerFrom(
    env['GATEWAY_TRUSTED_PROXY_HOPS'],
    1,
    0,
    2,
    'invalid_trusted_proxy_hops',
  );
  const bundle = await loadVerifiedPolicyBundle(
    dependencies.policyDirectory ??
      pathToFileURL(`${process.cwd()}/config/policy/`),
  );
  const secrets = createSecretProvider(
    config,
    config.secrets.provider === 'environment' ? { environmentValues: env } : {},
  );
  // The client reads PG* variables for anything the URL leaves out (port,
  // user, session options), behind the validated URL; refuse them, as the
  // migration command does.
  if (
    Object.entries(env).some(
      ([name, value]) => /^PG[A-Z]/u.test(name) && value !== undefined,
    )
  ) {
    throw new StartupFailure('postgres_environment_override_refused');
  }
  // The e2-micro host sets `unix_socket`, so the VM refuses any TCP database
  // URL, whatever the configuration's secret holds.
  const transport = env['GATEWAY_DATABASE_TRANSPORT'];
  if (transport !== undefined && transport !== 'unix_socket') {
    throw new StartupFailure('invalid_database_transport');
  }
  const databaseUrl = await resolveDatabaseUrl(
    config,
    secrets,
    signal,
    transport === undefined ? {} : { transport },
  );
  const pool = (
    dependencies.createPool ??
    ((url: string) =>
      createDatabasePool(url, (line) => {
        stderr.write(line);
      }))
  )(databaseUrl);
  holder.pool = pool;
  const driveAuth = await (
    dependencies.createDriveAuth ?? createDriveWorkloadAuth
  )(config);
  const runtime = await (
    dependencies.createProviders ?? createRuntimeProviders
  )({ config, policy: bundle.policy, secrets, signal, driveAuth });
  const store = new PostgresOperationalStateStore(pool);
  const app = await composeGateway(
    {
      store,
      identity: (dependencies.createIdentity ?? createIdentityProvider)(config),
      telemetry: dependencies.telemetry ?? new CloudLoggingTelemetrySink(),
      providers: runtime.providers,
      surfaces: runtime.surfaces,
      approvalProjection: runtime.approvalProjection,
      policy: bundle.policy,
      clock: dependencies.clock ?? { now: () => new Date() },
    },
    {
      trustedProxyHops,
      ...(dependencies.rateLimits === undefined
        ? {}
        : { rateLimits: dependencies.rateLimits }),
      ...(dependencies.logStream === undefined
        ? {}
        : { logStream: dependencies.logStream }),
    },
  );
  return { app, pool, store, port };
}

/**
 * The gateway process: load and verify configuration and policy, resolve
 * credentials only through the configured secret provider, build the governed
 * adapters, compose the audited gateway and serve until a shutdown signal.
 * Every startup step runs under one deadline. Resolves the process exit code.
 */
export async function main(dependencies: MainDependencies): Promise<number> {
  const stderr = dependencies.stderr ?? process.stderr;
  const holder: { pool?: Pool } = {};
  let poolClosed = false;
  const closePool = async (): Promise<void> => {
    if (poolClosed || holder.pool === undefined) return;
    poolClosed = true;
    await holder.pool.end().catch(() => undefined);
  };
  const deadline = AbortSignal.timeout(
    dependencies.startupTimeoutMs ?? startupTimeoutMs,
  );
  let onDeadline: (() => void) | undefined;
  const expiry = new Promise<never>((_, reject) => {
    onDeadline = () => {
      reject(new StartupFailure('startup_timeout'));
    };
    deadline.addEventListener('abort', onDeadline, { once: true });
  });
  const preparing = prepare(dependencies, holder, deadline, stderr);
  try {
    let prepared: Prepared;
    try {
      prepared = await Promise.race([preparing, expiry]);
    } finally {
      if (onDeadline !== undefined) {
        deadline.removeEventListener('abort', onDeadline);
      }
    }
    const { app, pool, store, port } = prepared;
    // Audit events reach Cloud Logging from the durable outbox; the loop stops
    // before the pool closes, and anything undelivered stays queued.
    const delivery = new AuditDeliveryLoop(
      (
        dependencies.auditOutbox ??
        ((outboxStore) =>
          new AuditOutboxService(outboxStore, new CloudLoggingAuditSink()))
      )(store),
      {
        batchSize: defaultAuditBatchSize,
        intervalMs:
          dependencies.auditDeliveryIntervalMs ??
          defaultAuditDeliveryIntervalMs,
        log: (line) => {
          stderr.write(line);
        },
      },
    );
    const server = await startServer(app, {
      port,
      host: dependencies.env['GATEWAY_HOST'] ?? '0.0.0.0',
      resources: [
        {
          name: 'database',
          close: async () => {
            await delivery.close();
            await pool.end();
          },
        },
      ],
      ...(dependencies.signals === undefined
        ? {}
        : { signals: dependencies.signals }),
    });
    // The server owns the pool from here; shutdown closes it.
    poolClosed = true;
    delivery.start();
    dependencies.onListening?.(server.url);
    await server.closed;
    return 0;
  } catch (error) {
    stderr.write(
      `${JSON.stringify({
        severity: 'ERROR',
        msg: 'startup_failed',
        reason: failureReason(error),
      })}\n`,
    );
    await closePool();
    // A startup that finishes after the deadline still has its pool closed.
    void preparing.then(closePool, closePool);
    return 1;
  }
}
