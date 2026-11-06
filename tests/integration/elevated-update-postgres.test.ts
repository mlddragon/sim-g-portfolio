import { readFileSync } from 'node:fs';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ElevationService } from '../../src/application/elevation-service.js';
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
import type { MutationResponse } from '../../src/domain/operations.js';
import { loadExecutablePolicy } from '../../src/domain/policy/policy-loader.js';
import type { BrainRecord } from '../../src/domain/records.js';
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
const roots = {
  notion: 'notion.family_shared',
  drive: 'drive.family_shared',
} as const;
const base = brainReadRecord(brainReadSummary('drive', 'postgres-elevated'));
const target: BrainRecord = {
  ...base,
  brainRecordId: brainRecordId('brn_provider_postgres_elevated'),
  canonicalLocation: { provider: 'drive', containerRef: roots.drive },
  policy: {
    scope: 'family_shared',
    sensitivity: 'protected',
    protectedClass: 'protected',
  },
};
const elevatedTitle = 'Synthetic durable elevated title';
const principal = brainReadPrincipal();
const context = {
  requestId: requestId('req_postgres_elevated'),
  receivedAt: brainReadNow,
  clientId: 'synthetic-test-client',
};
const request = {
  operationId: operationId('op_postgres_elevated'),
  requestId: context.requestId,
  principalId: principal.principal.id,
  clientId: context.clientId,
  brainRecordId: brainRecordId('brn_postgres_elevated_target'),
  mutation: { mode: 'patch' as const, patch: { title: elevatedTitle } },
};

function grantOf(response: MutationResponse) {
  if (response.elevation === undefined) {
    throw new Error('missing synthetic elevation grant');
  }
  return {
    challengeId: response.elevation.challengeId,
    confirmationToken: response.elevation.confirmationToken,
  };
}

describe('Elevated update_record PostgreSQL persistence', () => {
  let pool: Pool = createTestPool(connectionString);
  let drive: FakeMutableKnowledgeProvider;
  let updates = 0;
  const clock = { now: () => brainReadNow };

  const countingDrive = (): MutableKnowledgeProvider => ({
    provider: 'drive',
    search: (searchRequest, signal) => drive.search(searchRequest, signal),
    fetch: (fetchRequest, signal) => drive.fetch(fetchRequest, signal),
    create: (createRequest, signal) => drive.create(createRequest, signal),
    update: (updateRequest, signal) => {
      updates += 1;
      return drive.update(updateRequest, signal);
    },
    append: (appendRequest, signal) => drive.append(appendRequest, signal),
    trash: (trashRequest, signal) => drive.trash(trashRequest, signal),
    reconcile: (reconcileRequest, signal) =>
      drive.reconcile(reconcileRequest, signal),
  });

  const buildService = (store = new PostgresOperationalStateStore(pool)) =>
    new MutationService(
      new AuthorizationEngine(policy, clock),
      new DestructiveClassifier(),
      new CanonicalRouter(policy),
      store,
      [
        new FakeMutableKnowledgeProvider('notion', [], {
          configuredAccess: {
            brainScopes: ['family_shared'],
            rootRefs: [roots.notion],
          },
        }),
        countingDrive(),
      ],
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
      undefined,
      new ElevationService(store, clock),
    );

  const restart = async () => {
    await pool.end();
    pool = createTestPool(connectionString);
  };

  const setDrive = (unknown = false) => {
    drive = new FakeMutableKnowledgeProvider('drive', [target], {
      configuredAccess: {
        brainScopes: ['family_shared'],
        rootRefs: [roots.drive],
      },
      now: () => brainReadNow,
      ...(unknown
        ? { unknownOperationIds: [operationId('op_postgres_elevated')] }
        : {}),
    });
  };

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    updates = 0;
    setDrive();
    await resetOperationalState(pool);
    await new PostgresOperationalStateStore(pool).ensureBrainRecordAlias({
      brainRecordId: brainRecordId('brn_postgres_elevated_target'),
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

  it('confirms a challenge issued before a restart and stores only its hash', async () => {
    const first = await buildService().updateRecord(
      principal,
      context,
      request,
      new AbortController().signal,
    );
    const grant = grantOf(first);

    await restart();
    const confirmed = await buildService().updateRecord(
      principal,
      context,
      { ...request, elevation: grant },
      new AbortController().signal,
    );

    expect(confirmed).toMatchObject({ state: 'completed' });
    expect(updates).toBe(1);
    const persisted = await pool.query<{ readonly dump: string }>(
      `SELECT concat_ws('|',
         (SELECT string_agg(row_to_json(c)::text, '|') FROM elevation_challenges c),
         (SELECT string_agg(row_to_json(o)::text, '|') FROM operations o),
         (SELECT string_agg(event::text, '|') FROM audit_outbox)
       ) AS dump`,
    );
    expect(persisted.rows[0]?.dump).not.toContain(grant.confirmationToken);
    const audits = await new PostgresOperationalStateStore(
      pool,
    ).listPendingAuditEvents(10);
    expect(
      audits.map(({ event }) => [event.outcome, event.reasonCode]),
    ).toEqual([
      ['ELEVATION_PENDING', 'explicit_elevation_required'],
      ['EXECUTING', 'elevated_action_confirmed'],
      ['COMPLETED', 'provider_mutation_completed'],
    ]);
    expect(JSON.stringify(audits)).not.toContain(elevatedTitle);
  });

  it('lets exactly one of two concurrent service instances dispatch', async () => {
    const grant = grantOf(
      await buildService().updateRecord(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
    );

    const outcomes = await Promise.allSettled([
      buildService().updateRecord(
        principal,
        context,
        { ...request, elevation: grant },
        new AbortController().signal,
      ),
      buildService().updateRecord(
        principal,
        context,
        { ...request, elevation: grant },
        new AbortController().signal,
      ),
    ]);

    expect(updates).toBe(1);
    expect(
      outcomes.some(
        (outcome) =>
          outcome.status === 'fulfilled' && outcome.value.state === 'completed',
      ),
    ).toBe(true);
    const rows = await pool.query<{ readonly state: string }>(
      `SELECT state FROM operations WHERE id = 'op_postgres_elevated'`,
    );
    expect(rows.rows).toEqual([{ state: 'COMPLETED' }]);
    const consumed = await pool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count FROM elevation_challenges
       WHERE consumed_at IS NOT NULL`,
    );
    expect(consumed.rows[0]?.count).toBe('1');
  });

  it('rejects a superseded challenge across restart and accepts the newest', async () => {
    const original = grantOf(
      await buildService().updateRecord(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
    );
    await restart();
    const replayed = grantOf(
      await buildService().updateRecord(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
    );

    await expect(
      buildService().updateRecord(
        principal,
        context,
        { ...request, elevation: original },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'elevation_required' });
    await expect(
      buildService().updateRecord(
        principal,
        context,
        { ...request, elevation: replayed },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(updates).toBe(1);
    const rejected = await new PostgresOperationalStateStore(
      pool,
    ).listPendingAuditEvents(10);
    expect(
      rejected.filter(
        ({ event }) => event.eventType === 'brain.elevation.rejected',
      ),
    ).toHaveLength(1);
  });

  it('reconciles an uncertain elevated write after restart without repeating it', async () => {
    setDrive(true);
    const grant = grantOf(
      await buildService().updateRecord(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
    );
    await expect(
      buildService().updateRecord(
        principal,
        context,
        { ...request, elevation: grant },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });

    await restart();
    await expect(
      buildService().updateRecord(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(updates).toBe(1);
  });
});
