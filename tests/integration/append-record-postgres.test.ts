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
import type { MutableKnowledgeProvider } from '../../src/ports/knowledge-provider.js';
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
const target = {
  ...brainReadRecord(
    brainReadSummary('notion', 'postgres-append'),
    'Synthetic original list.',
  ),
  canonicalLocation: {
    provider: 'notion' as const,
    containerRef: 'notion.family_shared',
  },
};
const appended = '\n- Synthetic durable appended item';
const principal = brainReadPrincipal();
const context = {
  requestId: requestId('req_postgres_append'),
  receivedAt: brainReadNow,
  clientId: 'synthetic-test-client',
};
const request = {
  operationId: operationId('op_postgres_append'),
  requestId: context.requestId,
  principalId: principal.principal.id,
  clientId: context.clientId,
  brainRecordId: brainRecordId('brn_postgres_append_target'),
  content: appended,
};

describe('append_to_record PostgreSQL persistence', () => {
  let pool: Pool = createTestPool(connectionString);
  let notion: FakeMutableKnowledgeProvider;
  let appends = 0;
  const clock = { now: () => brainReadNow };

  const countingNotion = (): MutableKnowledgeProvider => ({
    provider: 'notion',
    search: (searchRequest, signal) => notion.search(searchRequest, signal),
    fetch: (fetchRequest, signal) => notion.fetch(fetchRequest, signal),
    create: (createRequest, signal) => notion.create(createRequest, signal),
    update: (updateRequest, signal) => notion.update(updateRequest, signal),
    append: (appendRequest, signal) => {
      appends += 1;
      return notion.append(appendRequest, signal);
    },
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
    notion = new FakeMutableKnowledgeProvider('notion', [target], {
      configuredAccess: {
        brainScopes: ['family_shared'],
        rootRefs: ['notion.family_shared'],
      },
      now: () => brainReadNow,
      ...(unknown
        ? { unknownOperationIds: [operationId('op_postgres_append')] }
        : {}),
    });
  };

  const restart = async () => {
    await pool.end();
    pool = createTestPool(connectionString);
  };

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    appends = 0;
    setNotion();
    await resetOperationalState(pool);
    await new PostgresOperationalStateStore(pool).ensureBrainRecordAlias({
      brainRecordId: brainRecordId('brn_postgres_append_target'),
      provider: 'notion',
      providerRecordId: target.provenance.providerRecordId,
      canonicalLocation: target.canonicalLocation,
      createdAt: brainReadNow,
      updatedAt: brainReadNow,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('replays a completed append after restart and stores no appended body', async () => {
    const first = await buildService().appendToRecord(
      principal,
      context,
      request,
      new AbortController().signal,
    );
    expect(first).toMatchObject({ state: 'completed' });

    await restart();
    const replay = await buildService().appendToRecord(
      principal,
      context,
      { ...request, operationId: operationId('op_ignored_after_restart') },
      new AbortController().signal,
    );

    expect(replay).toEqual(first);
    expect(appends).toBe(1);
    const dump = await pool.query<{ readonly dump: string }>(
      `SELECT concat_ws('|',
         (SELECT string_agg(row_to_json(o)::text, '|') FROM operations o),
         (SELECT string_agg(event::text, '|') FROM audit_outbox)
       ) AS dump`,
    );
    expect(dump.rows[0]?.dump).not.toContain(appended.trim());
  });

  it('reconciles an uncertain append after restart without appending twice', async () => {
    setNotion(true);
    await expect(
      buildService().appendToRecord(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });

    await restart();
    await expect(
      buildService().appendToRecord(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(appends).toBe(1);
  });
});
