import { readFileSync } from 'node:fs';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApprovalRequestCoordinator } from '../../src/application/approval-service.js';
import { MutationService } from '../../src/application/mutation-service.js';
import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { PostgresOperationalStateStore } from '../../src/adapters/state/postgres/postgres-operational-state-store.js';
import { AuthorizationEngine } from '../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../src/domain/authorization/destructive-classifier.js';
import {
  brainRecordId,
  operationId,
  providerRecordId,
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
  ...brainReadRecord(brainReadSummary('notion', 'postgres-delete')),
  canonicalLocation: {
    provider: 'notion' as const,
    containerRef: 'notion.family_shared',
  },
};

function request(authenticated = brainReadPrincipal()) {
  return {
    operationId: operationId(
      `op_postgres_delete_${authenticated.principal.key}`,
    ),
    requestId: requestId(`req_postgres_delete_${authenticated.principal.key}`),
    principalId: authenticated.principal.id,
    clientId: 'synthetic-test-client',
    brainRecordId: brainRecordId('brn_postgres_delete_target'),
    explicitIntent: true as const,
  };
}

function context(authenticated = brainReadPrincipal()) {
  return {
    requestId: requestId(`req_postgres_delete_${authenticated.principal.key}`),
    receivedAt: brainReadNow,
    clientId: 'synthetic-test-client',
  };
}

describe('delete_record PostgreSQL persistence', () => {
  let pool: Pool = createTestPool(connectionString);
  let notion: FakeMutableKnowledgeProvider;
  let trashes = 0;
  const clock = { now: () => brainReadNow };

  const countingNotion = (): MutableKnowledgeProvider => ({
    provider: 'notion',
    search: (searchRequest, signal) => notion.search(searchRequest, signal),
    fetch: (fetchRequest, signal) => notion.fetch(fetchRequest, signal),
    create: (createRequest, signal) => notion.create(createRequest, signal),
    update: (updateRequest, signal) => notion.update(updateRequest, signal),
    append: (appendRequest, signal) => notion.append(appendRequest, signal),
    trash: (trashRequest, signal) => {
      trashes += 1;
      return notion.trash(trashRequest, signal);
    },
    reconcile: (reconcileRequest, signal) =>
      notion.reconcile(reconcileRequest, signal),
  });

  const buildService = () => {
    const store = new PostgresOperationalStateStore(pool);
    return new MutationService(
      new AuthorizationEngine(policy, clock),
      new DestructiveClassifier(),
      new CanonicalRouter(policy),
      store,
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
      new ApprovalRequestCoordinator(
        store,
        {
          findByApprovalRequestId: () => Promise.resolve(null),
          create: () =>
            Promise.resolve({
              providerRecordId: providerRecordId(
                '40000000-0000-4000-8000-000000000041',
              ),
            }),
          update: () => Promise.resolve(),
        },
        clock,
      ),
    );
  };

  const setNotion = (unknownFor?: string) => {
    notion = new FakeMutableKnowledgeProvider('notion', [target], {
      configuredAccess: {
        brainScopes: ['family_shared'],
        rootRefs: ['notion.family_shared'],
      },
      now: () => brainReadNow,
      ...(unknownFor === undefined
        ? {}
        : { unknownOperationIds: [operationId(unknownFor)] }),
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
    trashes = 0;
    setNotion();
    await resetOperationalState(pool);
    await new PostgresOperationalStateStore(pool).ensureBrainRecordAlias({
      brainRecordId: brainRecordId('brn_postgres_delete_target'),
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

  it('replays a completed trash after restart without trashing twice', async () => {
    const first = await buildService().deleteRecord(
      brainReadPrincipal(),
      context(),
      request(),
      new AbortController().signal,
    );
    expect(first).toMatchObject({ state: 'completed' });

    await restart();
    await expect(
      buildService().deleteRecord(
        brainReadPrincipal(),
        context(),
        request(),
        new AbortController().signal,
      ),
    ).resolves.toEqual(first);
    expect(trashes).toBe(1);
    const rows = await pool.query<{ readonly payload: unknown }>(
      `SELECT mutation_payload AS payload FROM operations`,
    );
    expect(rows.rows).toEqual([{ payload: null }]);
  });

  it('reconciles an uncertain trash after restart although the target is gone', async () => {
    setNotion('op_postgres_delete_operator');
    await expect(
      buildService().deleteRecord(
        brainReadPrincipal(),
        context(),
        request(),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });

    await restart();
    await expect(
      buildService().deleteRecord(
        brainReadPrincipal(),
        context(),
        request(),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(trashes).toBe(1);
    const attempts = await pool.query<{ readonly outcome: string }>(
      'SELECT outcome FROM reconciliation_attempts',
    );
    expect(attempts.rows).toEqual([{ outcome: 'completed' }]);
  });

  it('persists a non-expiring parent approval for an Participant delete across restart', async () => {
    const participant = brainReadPrincipal('family_participant');
    await expect(
      buildService().deleteRecord(
        participant,
        context(participant),
        request(participant),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'approval_required' });

    await restart();
    const approvals = await new PostgresOperationalStateStore(
      pool,
    ).listPendingApprovals();
    expect(approvals).toMatchObject([
      {
        operationId: operationId('op_postgres_delete_participant'),
        summary: { action: 'Move one Family Shared record to trash' },
      },
    ]);
    expect(trashes).toBe(0);
  });
});
