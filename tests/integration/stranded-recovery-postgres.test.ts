import { readFileSync } from 'node:fs';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MutationService } from '../../src/application/mutation-service.js';
import { operationFingerprint } from '../../src/application/operation-fingerprint.js';
import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { PostgresOperationalStateStore } from '../../src/adapters/state/postgres/postgres-operational-state-store.js';
import { AuthorizationEngine } from '../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../src/domain/authorization/destructive-classifier.js';
import {
  brainRecordId,
  operationId,
  principalId,
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
const target = {
  ...brainReadRecord(brainReadSummary('notion', 'postgres-stranded')),
  canonicalLocation: {
    provider: 'notion' as const,
    containerRef: 'notion.family_shared',
  },
};
const operator = brainReadPrincipal();
const staleAfterMs = 15 * 60_000;
const strandedTitle = 'Synthetic stranded durable title';
const strandedMutation = {
  mode: 'patch' as const,
  patch: { title: strandedTitle },
};
const strandedFingerprint = operationFingerprint('update_record', {
  brainRecordId: brainRecordId('brn_postgres_stranded_target'),
  mutation: strandedMutation,
});

describe('stranded execution recovery with PostgreSQL', () => {
  let pool: Pool = createTestPool(connectionString);
  let notion: FakeMutableKnowledgeProvider;
  let updates = 0;
  let now = brainReadNow;
  const clock = { now: () => now };

  const buildService = () =>
    new MutationService(
      new AuthorizationEngine(policy, clock),
      new DestructiveClassifier(),
      new CanonicalRouter(policy),
      new PostgresOperationalStateStore(pool),
      [
        {
          provider: 'notion',
          search: (r, s) => notion.search(r, s),
          fetch: (r, s) => notion.fetch(r, s),
          create: (r, s) => notion.create(r, s),
          update: (r, s) => {
            updates += 1;
            return notion.update(r, s);
          },
          append: (r, s) => notion.append(r, s),
          trash: (r, s) => notion.trash(r, s),
          reconcile: (r, s) => notion.reconcile(r, s),
        },
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

  /** Simulate a process that claimed EXECUTING, optionally wrote, then crashed. */
  async function strand(withWrite: boolean) {
    const store = new PostgresOperationalStateStore(pool);
    await store.openOperation({
      operationId: operationId('op_postgres_stranded'),
      requestId: requestId('req_postgres_stranded'),
      principalId: operator.principal.id,
      clientId: 'synthetic-test-client',
      operation: 'update_record',
      requestFingerprint: strandedFingerprint,
      mutationPayload: { mode: 'patch', patch: { title: strandedTitle } },
      targetBrainRecordId: brainRecordId('brn_postgres_stranded_target'),
      createdAt: brainReadNow,
    });
    await store.transitionOperationWithAudit(
      {
        operationId: operationId('op_postgres_stranded'),
        expectedStates: ['RECEIVED'],
        nextState: 'EXECUTING',
        provider: 'notion',
        providerRecordId: target.provenance.providerRecordId,
        policyVersion: policy.version,
        transitionedAt: brainReadNow,
      },
      {
        eventType: 'brain.mutation.transitioned',
        reasonCode: 'routine_authorized',
      },
    );
    if (withWrite) {
      await notion.update(
        {
          operationId: operationId('op_postgres_stranded'),
          access: {
            brainScopes: ['family_shared'],
            rootRefs: ['notion.family_shared'],
          },
          providerRecordId: target.provenance.providerRecordId,
          mutation: { mode: 'patch', patch: { title: strandedTitle } },
        },
        new AbortController().signal,
      );
    }
    await pool.end();
    pool = createTestPool(connectionString);
    now = new Date(brainReadNow.getTime() + staleAfterMs);
  }

  const recover = () =>
    buildService().recoverStrandedExecution(
      operator,
      {
        requestId: requestId('req_postgres_recover'),
        receivedAt: now,
        clientId: 'synthetic-operator',
      },
      { operationId: operationId('op_postgres_stranded'), staleAfterMs },
      new AbortController().signal,
    );

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    updates = 0;
    now = brainReadNow;
    notion = new FakeMutableKnowledgeProvider('notion', [target], {
      configuredAccess: {
        brainScopes: ['family_shared'],
        rootRefs: ['notion.family_shared'],
      },
      now: () => now,
    });
    await resetOperationalState(pool);
    await new PostgresOperationalStateStore(pool).ensureBrainRecordAlias({
      brainRecordId: brainRecordId('brn_postgres_stranded_target'),
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

  it('finalizes a write proven by its marker after restart and clears the payload', async () => {
    await strand(true);

    await expect(recover()).resolves.toMatchObject({
      disposition: 'completed',
      state: 'COMPLETED',
    });
    expect(updates).toBe(0);
    const rows = await pool.query<{
      readonly state: string;
      readonly payload: unknown;
    }>(
      `SELECT state, mutation_payload AS payload FROM operations
       WHERE id = 'op_postgres_stranded'`,
    );
    expect(rows.rows).toEqual([{ state: 'COMPLETED', payload: null }]);
  });

  it('records an operator-visible unknown without a marker and never writes', async () => {
    await strand(false);

    await expect(recover()).resolves.toMatchObject({
      disposition: 'outcome_unknown',
      reasonCode: 'recovery_provider_marker_not_found',
    });
    await expect(recover()).resolves.toMatchObject({
      disposition: 'not_executing',
      state: 'OUTCOME_UNKNOWN',
    });
    expect(updates).toBe(0);
    const rows = await pool.query<{
      readonly state: string;
      readonly reason: string | null;
      readonly payload: unknown;
    }>(
      `SELECT state, result_metadata->>'recoveryReason' AS reason,
              mutation_payload AS payload
       FROM operations WHERE id = 'op_postgres_stranded'`,
    );
    expect(rows.rows).toEqual([
      {
        state: 'OUTCOME_UNKNOWN',
        reason: 'recovery_provider_marker_not_found',
        payload: { mode: 'patch', patch: { title: strandedTitle } },
      },
    ]);
    const attempts = await pool.query<{ readonly outcome: string }>(
      'SELECT outcome FROM reconciliation_attempts',
    );
    expect(attempts.rows).toEqual([{ outcome: 'not_found' }]);
    const audit = await new PostgresOperationalStateStore(
      pool,
    ).listPendingAuditEvents(10);
    expect(
      audit.filter(
        ({ event }) => event.eventType === 'brain.operation.recovery',
      ),
    ).toMatchObject([
      {
        event: {
          principalId: principalId('prn_operator'),
          outcome: 'OUTCOME_UNKNOWN',
          reasonCode: 'recovery_provider_marker_not_found',
        },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain(strandedTitle);
  });

  it('reconciles a late provider write on client replay without a duplicate', async () => {
    await strand(false);
    await recover();
    await notion.update(
      {
        operationId: operationId('op_postgres_stranded'),
        access: {
          brainScopes: ['family_shared'],
          rootRefs: ['notion.family_shared'],
        },
        providerRecordId: target.provenance.providerRecordId,
        mutation: { mode: 'patch', patch: { title: strandedTitle } },
      },
      new AbortController().signal,
    );

    await expect(
      buildService().updateRecord(
        operator,
        {
          requestId: requestId('req_postgres_stranded'),
          receivedAt: now,
          clientId: 'synthetic-test-client',
        },
        {
          operationId: operationId('op_postgres_stranded'),
          requestId: requestId('req_postgres_stranded'),
          principalId: operator.principal.id,
          clientId: 'synthetic-test-client',
          brainRecordId: brainRecordId('brn_postgres_stranded_target'),
          mutation: { mode: 'patch', patch: { title: strandedTitle } },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(updates).toBe(0);
    const rows = await pool.query<{ readonly state: string }>(
      `SELECT state FROM operations WHERE id = 'op_postgres_stranded'`,
    );
    expect(rows.rows).toEqual([{ state: 'COMPLETED' }]);
  });
});
