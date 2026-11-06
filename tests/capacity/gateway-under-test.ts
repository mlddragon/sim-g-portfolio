/**
 * Capacity entry point: the real gateway process (`main`) with only its
 * outbound edges replaced by synthetic stand-ins, for e2-micro capacity
 * measurement (F13b). Never part of the production image.
 *
 * Real: configuration and policy loading, the environment secret provider,
 * the PostgreSQL pool and store, Google OIDC verification (RS256 against a
 * locally generated synthetic key), authorization, routing, the audited
 * operations, Fastify, Cloud Logging audit/telemetry output and the
 * in-process audit delivery loop.
 *
 * Synthetic: Notion/Drive/GitHub providers (in-memory, with provider-like
 * latency), the approval projection, and an audit sink that can be switched
 * off to build an outbox backlog.
 */
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { importJWK, type JWK } from 'jose';
import pg from 'pg';

import { CloudLoggingAuditSink } from '../../src/adapters/audit/cloud-logging-audit-sink.js';
import { GoogleOidcIdentityProvider } from '../../src/adapters/identity/google-oidc-identity-provider.js';
import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { AuditOutboxService } from '../../src/application/audit-outbox-service.js';
import { DomainError } from '../../src/domain/errors.js';
import { providerRecordId } from '../../src/domain/identifiers.js';
import type { AuditSink } from '../../src/ports/audit-sink.js';
import { main } from '../../src/main.js';
import type { RuntimeProviders } from '../../src/runtime/providers.js';
import {
  FakeFetchableKnowledgeProvider,
  FakeMutableKnowledgeProvider,
} from '../support/fake-knowledge-providers.js';
import { syntheticCorpus } from './synthetic-corpus.js';

const env = process.env;
const controlDirectory = env['CAPACITY_CONTROL_DIR'] ?? '/run/capacity';
const providerLatencyMs = Number(env['CAPACITY_PROVIDER_LATENCY_MS'] ?? '150');
const recordsPerProvider = Number(env['CAPACITY_RECORDS'] ?? '500');
const issuer = 'https://accounts.google.com';
// `raised` lifts the per-minute limits to measure the stack itself, since the
// load generator's synthetic users all share one source address. Production
// limits stay the default.
const raisedLimits = env['CAPACITY_RATE_LIMITS'] === 'raised';

function required(name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new TypeError(`capacity_${name.toLowerCase()}_required`);
  }
  return value;
}

/** Provider-like latency (±50 %) that still honours cancellation. */
function withLatency<T extends object>(provider: T): T {
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const signal = args[1] instanceof AbortSignal ? args[1] : undefined;
        const jitter = 0.5 + Math.random();
        await delay(Math.round(providerLatencyMs * jitter), undefined, {
          signal,
        });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** The real Cloud Logging sink, unless the control file marks it down. */
class SwitchableAuditSink implements AuditSink {
  readonly #sink = new CloudLoggingAuditSink();

  emit(...args: Parameters<AuditSink['emit']>) {
    if (existsSync(`${controlDirectory}/audit-sink-down`)) {
      return Promise.reject(
        new DomainError('provider_unavailable', true, {
          reason: 'audit_sink_unavailable',
        }),
      );
    }
    return this.#sink.emit(...args);
  }
}

async function prepareDatabase(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO identity_bindings (id, principal_id, issuer, external_subject, email)
       VALUES
         ('idb_capacity_operator', 'prn_operator', $1, 'synthetic-subject-operator', 'operator@example.invalid'),
         ('idb_capacity_steward', 'prn_steward', $1, 'synthetic-subject-steward', 'steward@example.invalid'),
         ('idb_capacity_participant', 'prn_participant', $1, 'synthetic-subject-participant', 'participant@example.invalid')
       ON CONFLICT (id) DO NOTHING`,
      [issuer],
    );
  } finally {
    await pool.end();
  }
}

async function run(): Promise<number> {
  const databaseUrl = required('DATABASE_URL');
  // The public half of the run's synthetic signing key; not a secret.
  const publicJwk = JSON.parse(required('CAPACITY_PUBLIC_JWK')) as JWK;
  const key = await importJWK(publicJwk, 'RS256');
  await prepareDatabase(databaseUrl);

  return main({
    env,
    ...(raisedLimits
      ? {
          rateLimits: {
            perIpPerMinute: 1_000_000,
            perPrincipalPerMinute: 1_000_000,
            mutationsPerPrincipalPerMinute: 1_000_000,
            perClientPerMinute: 1_000_000,
          },
        }
      : {}),
    createIdentity: (config) =>
      new GoogleOidcIdentityProvider({
        ...config.identity,
        keyResolver: () => Promise.resolve(key),
      }),
    // Synthetic providers need no Drive credential.
    createDriveAuth: () => Promise.resolve({} as never),
    createProviders: ({ policy }): Promise<RuntimeProviders> => {
      const roots = policy.routing.containers;
      const notionAccess = {
        brainScopes: ['family_shared', 'parent_and_stewardship', 'legal'],
        rootRefs: Object.values(roots.notion),
      } as const;
      const driveAccess = {
        brainScopes: ['family_shared', 'parent_and_stewardship', 'legal'],
        rootRefs: Object.values(roots.drive),
      } as const;
      return Promise.resolve({
        providers: {
          notion: withLatency(
            new FakeMutableKnowledgeProvider(
              'notion',
              syntheticCorpus('notion', roots.notion, recordsPerProvider),
              { configuredAccess: notionAccess },
            ),
          ),
          drive: withLatency(
            new FakeMutableKnowledgeProvider(
              'drive',
              syntheticCorpus('drive', roots.drive, recordsPerProvider),
              { configuredAccess: driveAccess },
            ),
          ),
          github: withLatency(
            new FakeFetchableKnowledgeProvider('github', [], {
              configuredAccess: { brainScopes: [], rootRefs: [] },
            }),
          ),
        },
        surfaces: (['notion', 'drive'] as const).flatMap((provider) =>
          Object.entries(roots[provider]).map(([container, containerKey]) => ({
            provider,
            containerKey,
            scope:
              container === 'protected'
                ? ('legal' as const)
                : (container as 'family_shared' | 'parent_and_stewardship'),
          })),
        ),
        approvalProjection: {
          findByApprovalRequestId: () => Promise.resolve(null),
          create: () =>
            Promise.resolve({
              providerRecordId: providerRecordId(
                '40000000-0000-4000-8000-000000000091',
              ),
            }),
          update: () => Promise.resolve(),
        },
      });
    },
    auditOutbox: (store) =>
      new AuditOutboxService(store, new SwitchableAuditSink()),
  });
}

run().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const reason =
      error instanceof TypeError && /^[a-z_]{1,96}$/u.test(error.message)
        ? error.message
        : 'capacity_harness_failed';
    process.stderr.write(
      `${JSON.stringify({ severity: 'ERROR', msg: 'capacity_harness_failed', reason })}\n`,
    );
    process.exitCode = 1;
  },
);
