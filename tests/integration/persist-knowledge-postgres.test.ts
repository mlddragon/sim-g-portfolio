import { readFileSync } from 'node:fs';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MutationService } from '../../src/application/mutation-service.js';
import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { PostgresOperationalStateStore } from '../../src/adapters/state/postgres/postgres-operational-state-store.js';
import { AuthorizationEngine } from '../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../src/domain/authorization/destructive-classifier.js';
import { operationId, requestId } from '../../src/domain/identifiers.js';
import { loadExecutablePolicy } from '../../src/domain/policy/policy-loader.js';
import { CanonicalRouter } from '../../src/domain/routing/canonical-router.js';
import type { MutableKnowledgeProvider } from '../../src/ports/knowledge-provider.js';
import { FakeMutableKnowledgeProvider } from '../support/fake-knowledge-providers.js';
import {
  brainReadNow,
  brainReadPrincipal,
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
const principal = brainReadPrincipal();
const context = {
  requestId: requestId('req_postgres_persist'),
  receivedAt: brainReadNow,
  clientId: 'synthetic-test-client',
};
const persistedBody = 'Synthetic durable persisted procedure body';
const request = {
  operationId: operationId('op_postgres_persist'),
  requestId: context.requestId,
  principalId: principal.principal.id,
  clientId: context.clientId,
  title: 'Synthetic durable procedure',
  content: persistedBody,
  semanticMetadata: {
    recordType: 'procedure',
    durability: 'durable',
    sensitivity: 'family_shared' as const,
  },
};

describe('persist_knowledge PostgreSQL persistence', () => {
  let pool: Pool = createTestPool(connectionString);
  let notion: FakeMutableKnowledgeProvider;
  let creates = 0;
  const clock = { now: () => brainReadNow };

  const countingNotion = (): MutableKnowledgeProvider => ({
    provider: 'notion',
    search: (searchRequest, signal) => notion.search(searchRequest, signal),
    fetch: (fetchRequest, signal) => notion.fetch(fetchRequest, signal),
    create: (createRequest, signal) => {
      creates += 1;
      return notion.create(createRequest, signal);
    },
    update: (updateRequest, signal) => notion.update(updateRequest, signal),
    append: (appendRequest, signal) => notion.append(appendRequest, signal),
    trash: (trashRequest, signal) => notion.trash(trashRequest, signal),
    reconcile: (reconcileRequest, signal) =>
      notion.reconcile(reconcileRequest, signal),
  });

  const buildService = () =>
    new MutationService(
      new AuthorizationEngine(policy, clock),
      new DestructiveClassifier(),
      new CanonicalRouter(policy),
      new PostgresOperationalStateStore(pool),
      [
        countingNotion(),
        new FakeMutableKnowledgeProvider('drive', [], {
          configuredAccess: {
            brainScopes: ['family_shared'],
            rootRefs: ['drive.family_shared'],
          },
        }),
      ],
      [
        {
          provider: 'notion',
          containerKey: 'notion.family_shared',
          scope: 'family_shared',
        },
        {
          provider: 'drive',
          containerKey: 'drive.family_shared',
          scope: 'family_shared',
        },
      ],
      clock,
    );

  const setNotion = (unknown = false) => {
    notion = new FakeMutableKnowledgeProvider('notion', [], {
      configuredAccess: {
        brainScopes: ['family_shared'],
        rootRefs: ['notion.family_shared'],
      },
      now: () => brainReadNow,
      ...(unknown
        ? { unknownOperationIds: [operationId('op_postgres_persist')] }
        : {}),
    });
  };

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    creates = 0;
    setNotion();
    await resetOperationalState(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('replays the created record and its alias after replacing pool and service', async () => {
    const first = await buildService().persistKnowledge(
      principal,
      context,
      request,
      new AbortController().signal,
    );
    expect(first).toMatchObject({ state: 'completed' });

    await pool.end();
    pool = createTestPool(connectionString);
    const replay = await buildService().persistKnowledge(
      principal,
      context,
      { ...request, operationId: operationId('op_ignored_after_restart') },
      new AbortController().signal,
    );

    expect(replay).toEqual(first);
    expect(creates).toBe(1);
    const aliases = await pool.query<{ readonly brain_record_id: string }>(
      'SELECT brain_record_id FROM brain_record_aliases',
    );
    expect(aliases.rows).toEqual([{ brain_record_id: first.brainRecordId }]);
    const stored = await pool.query<{
      readonly payload: unknown;
      readonly creator: string | null;
    }>(
      `SELECT o.mutation_payload AS payload, a.creator_principal_id AS creator
       FROM operations o CROSS JOIN brain_record_aliases a`,
    );
    expect(stored.rows).toEqual([
      { payload: null, creator: principal.principal.id },
    ]);
    const operationsDump = await pool.query<{ readonly dump: string }>(
      `SELECT string_agg(row_to_json(o)::text, '|') AS dump FROM operations o`,
    );
    expect(operationsDump.rows[0]?.dump).not.toContain(persistedBody);
    const audit = await new PostgresOperationalStateStore(
      pool,
    ).listPendingAuditEvents(10);
    expect(audit.map(({ event }) => event.outcome)).toEqual([
      'EXECUTING',
      'COMPLETED',
    ]);
    expect(JSON.stringify(audit)).not.toContain(persistedBody);
  });

  it('reconciles an uncertain create after restart without creating twice', async () => {
    setNotion(true);
    await expect(
      buildService().persistKnowledge(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });

    await pool.end();
    pool = createTestPool(connectionString);
    const reconciled = await buildService().persistKnowledge(
      principal,
      context,
      request,
      new AbortController().signal,
    );

    expect(reconciled).toMatchObject({ state: 'completed' });
    expect(reconciled.brainRecordId).toMatch(/^brn_notion_/u);
    expect(creates).toBe(1);
    const attempts = await pool.query<{ readonly outcome: string }>(
      'SELECT outcome FROM reconciliation_attempts',
    );
    expect(attempts.rows).toEqual([{ outcome: 'completed' }]);
  });

  it('creates once when two service instances race the same request', async () => {
    const outcomes = await Promise.allSettled([
      buildService().persistKnowledge(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
      buildService().persistKnowledge(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
    ]);

    expect(creates).toBe(1);
    expect(
      outcomes.some(
        (outcome) =>
          outcome.status === 'fulfilled' && outcome.value.state === 'completed',
      ),
    ).toBe(true);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({
          code: 'provider_unavailable',
          details: { reason: 'operation_in_progress' },
        });
      }
    }
  });
});
