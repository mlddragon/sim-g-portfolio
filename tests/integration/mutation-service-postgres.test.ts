import { readFileSync } from 'node:fs';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MutationService } from '../../src/application/mutation-service.js';
import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { PostgresOperationalStateStore } from '../../src/adapters/state/postgres/postgres-operational-state-store.js';
import { AuthorizationEngine } from '../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../src/domain/authorization/destructive-classifier.js';
import {
  brainRecordId,
  operationId,
  requestId,
} from '../../src/domain/identifiers.js';
import { loadExecutablePolicy } from '../../src/domain/policy/policy-loader.js';
import { CanonicalRouter } from '../../src/domain/routing/canonical-router.js';
import { FakeMutableKnowledgeProvider } from '../support/fake-knowledge-providers.js';
import {
  brainReadNow,
  brainReadPrincipal,
  brainReadRecord,
  brainReadSummary,
} from '../support/brain-read-fixtures.js';
import {
  createTestPool,
  requireTestDatabaseUrl,
  resetOperationalState,
} from '../support/postgres.js';

const connectionString = requireTestDatabaseUrl();
const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);
const roots = {
  notion: 'notion.family_shared',
  drive: 'drive.family_shared',
} as const;
const target = {
  ...brainReadRecord(brainReadSummary('drive', 'postgres-mutation')),
  brainRecordId: brainRecordId('brn_provider_postgres_mutation'),
  canonicalLocation: {
    provider: 'drive' as const,
    containerRef: roots.drive,
  },
};

describe('MutationService PostgreSQL persistence', () => {
  let pool: Pool = createTestPool(connectionString);
  const provider = new FakeMutableKnowledgeProvider('drive', [target], {
    configuredAccess: {
      brainScopes: ['family_shared'],
      rootRefs: [roots.drive],
    },
    now: () => brainReadNow,
  });
  const notion = new FakeMutableKnowledgeProvider('notion', [], {
    configuredAccess: {
      brainScopes: ['family_shared'],
      rootRefs: [roots.notion],
    },
  });
  const clock = { now: () => brainReadNow };

  const buildService = (store: PostgresOperationalStateStore) =>
    new MutationService(
      new AuthorizationEngine(policy, clock),
      new DestructiveClassifier(),
      new CanonicalRouter(policy),
      store,
      [notion, provider],
      [
        {
          provider: 'notion',
          containerKey: roots.notion,
          scope: 'family_shared',
        },
        {
          provider: 'drive',
          containerKey: roots.drive,
          scope: 'family_shared',
        },
      ],
      clock,
    );

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await resetOperationalState(pool);
    await new PostgresOperationalStateStore(pool).ensureBrainRecordAlias({
      brainRecordId: brainRecordId('brn_postgres_mutation_target'),
      provider: 'drive',
      providerRecordId: target.provenance.providerRecordId,
      canonicalLocation: target.canonicalLocation,
      createdAt: brainReadNow,
      updatedAt: brainReadNow,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('replays the terminal result after replacing both the pool and service', async () => {
    const principal = brainReadPrincipal();
    const context = {
      requestId: requestId('req_postgres_mutation'),
      receivedAt: brainReadNow,
      clientId: 'synthetic-test-client',
    };
    const request = {
      operationId: operationId('op_postgres_mutation'),
      requestId: context.requestId,
      principalId: principal.principal.id,
      clientId: context.clientId,
      brainRecordId: brainRecordId('brn_postgres_mutation_target'),
      mutation: {
        mode: 'patch' as const,
        patch: { title: 'Synthetic durable title' },
      },
    };
    const first = await buildService(
      new PostgresOperationalStateStore(pool),
    ).updateRecord(principal, context, request, new AbortController().signal);

    await pool.end();
    pool = createTestPool(connectionString);
    const replay = await buildService(
      new PostgresOperationalStateStore(pool),
    ).updateRecord(
      principal,
      context,
      { ...request, operationId: operationId('op_ignored_after_restart') },
      new AbortController().signal,
    );

    expect(replay).toEqual(first);
    expect(replay).toMatchObject({ state: 'completed' });
    const rows = await pool.query<{ state: string }>(
      `SELECT state FROM operations WHERE id = 'op_postgres_mutation'`,
    );
    expect(rows.rows).toEqual([{ state: 'COMPLETED' }]);
    expect(
      await new PostgresOperationalStateStore(pool).listPendingAuditEvents(10),
    ).toHaveLength(2);
  });
});
