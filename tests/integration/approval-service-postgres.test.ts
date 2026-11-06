import { readFileSync } from 'node:fs';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ApprovalRequestCoordinator,
  ApprovalService,
} from '../../src/application/approval-service.js';
import { MutationService } from '../../src/application/mutation-service.js';
import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { PostgresOperationalStateStore } from '../../src/adapters/state/postgres/postgres-operational-state-store.js';
import { AuthorizationEngine } from '../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../src/domain/authorization/destructive-classifier.js';
import {
  brainRecordId,
  operationId,
  principalId,
  providerRecordId,
  requestId,
} from '../../src/domain/identifiers.js';
import { loadExecutablePolicy } from '../../src/domain/policy/policy-loader.js';
import { CanonicalRouter } from '../../src/domain/routing/canonical-router.js';
import type { ApprovalProjectionPort } from '../../src/ports/approval-projection.js';
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
  ...brainReadRecord(brainReadSummary('notion', 'approval-postgres')),
  brainRecordId: brainRecordId('brn_provider_approval_postgres'),
  canonicalLocation: {
    provider: 'notion' as const,
    containerRef: roots.notion,
  },
  provenance: {
    ...brainReadRecord(brainReadSummary('notion', 'approval-postgres'))
      .provenance,
    creatorPrincipalId: principalId('prn_participant'),
  },
};

class DurableProjectionSpy implements ApprovalProjectionPort {
  readonly creates: Parameters<ApprovalProjectionPort['create']>[0][] = [];
  readonly updates: Parameters<ApprovalProjectionPort['update']>[0][] = [];

  findByApprovalRequestId(): Promise<null> {
    return Promise.resolve(null);
  }

  create(
    request: Parameters<ApprovalProjectionPort['create']>[0],
  ): ReturnType<ApprovalProjectionPort['create']> {
    this.creates.push(request);
    return Promise.resolve({
      providerRecordId: providerRecordId(
        '40000000-0000-4000-8000-000000000003',
      ),
    });
  }

  update(
    request: Parameters<ApprovalProjectionPort['update']>[0],
  ): Promise<void> {
    this.updates.push(request);
    return Promise.resolve();
  }
}

describe('durable approval workflow with PostgreSQL', () => {
  let pool: Pool = createTestPool(connectionString);
  const projection = new DurableProjectionSpy();
  const notion = new FakeMutableKnowledgeProvider('notion', [target], {
    configuredAccess: {
      brainScopes: ['family_shared'],
      rootRefs: [roots.notion],
    },
    now: () => brainReadNow,
  });
  const drive = new FakeMutableKnowledgeProvider('drive', [], {
    configuredAccess: {
      brainScopes: ['family_shared'],
      rootRefs: [roots.drive],
    },
  });
  const clock = { now: () => brainReadNow };

  const build = (store: PostgresOperationalStateStore) => {
    const authorization = new AuthorizationEngine(policy, clock);
    const coordinator = new ApprovalRequestCoordinator(
      store,
      projection,
      clock,
    );
    const mutation = new MutationService(
      authorization,
      new DestructiveClassifier(),
      new CanonicalRouter(policy),
      store,
      [notion, drive],
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
      coordinator,
    );
    return {
      mutation,
      approval: new ApprovalService(
        authorization,
        store,
        projection,
        mutation,
        clock,
      ),
    };
  };

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await resetOperationalState(pool);
    projection.creates.length = 0;
    projection.updates.length = 0;
    await new PostgresOperationalStateStore(pool).ensureBrainRecordAlias({
      brainRecordId: brainRecordId('brn_approval_postgres_target'),
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

  it('survives service/pool reconstruction and executes one freshly authorized approved update', async () => {
    const participant = brainReadPrincipal('family_participant');
    const context = {
      requestId: requestId('req_postgres_approval_update'),
      receivedAt: brainReadNow,
      clientId: 'synthetic-test-client',
    };
    await expect(
      build(new PostgresOperationalStateStore(pool)).mutation.updateRecord(
        participant,
        context,
        {
          operationId: operationId('op_postgres_approval_update'),
          requestId: context.requestId,
          principalId: participant.principal.id,
          clientId: context.clientId,
          brainRecordId: brainRecordId('brn_approval_postgres_target'),
          mutation: {
            mode: 'replace',
            replacement: { content: 'Synthetic approved durable body' },
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'approval_required' });

    await pool.end();
    pool = createTestPool(connectionString);
    const restarted = build(new PostgresOperationalStateStore(pool));
    const listed = await restarted.approval.listApprovals(
      brainReadPrincipal('parent_steward'),
      {
        requestId: requestId('req_postgres_approval_list'),
        receivedAt: brainReadNow,
        clientId: 'synthetic-test-client',
      },
      new AbortController().signal,
    );
    expect(listed.approvals).toHaveLength(1);
    const pending = listed.approvals[0];
    if (pending === undefined) throw new Error('missing pending approval');
    const audits = await new PostgresOperationalStateStore(
      pool,
    ).listPendingAuditEvents(20);
    expect(
      audits.some(
        ({ event }) =>
          event.eventType === 'brain.approval.created' &&
          event.approvalRequestId === pending.approvalRequestId &&
          event.principalId === principalId('prn_participant'),
      ),
    ).toBe(true);

    const resolution = await restarted.approval.resolveApproval(
      brainReadPrincipal('parent_steward'),
      {
        requestId: requestId('req_postgres_approval_resolve'),
        receivedAt: brainReadNow,
        clientId: 'synthetic-test-client',
      },
      {
        approvalRequestId: pending.approvalRequestId,
        resolution: 'approve',
      },
      new AbortController().signal,
    );
    expect(resolution).toMatchObject({
      approvalStatus: 'approved',
      operationState: 'COMPLETED',
    });
    expect(projection.creates).toHaveLength(1);
    expect(projection.updates).toHaveLength(1);
    await expect(
      notion.fetch(
        {
          providerRecordId: target.provenance.providerRecordId,
          access: {
            brainScopes: ['family_shared'],
            rootRefs: [roots.notion],
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ content: 'Synthetic approved durable body' });
  });

  it('never re-dispatches an approved update stranded after its claim, across restart', async () => {
    const participant = brainReadPrincipal('family_participant');
    const parent = brainReadPrincipal('parent_steward');
    const context = {
      requestId: requestId('req_postgres_approval_stranded'),
      receivedAt: brainReadNow,
      clientId: 'synthetic-test-client',
    };
    await build(new PostgresOperationalStateStore(pool)).mutation.updateRecord(
      participant,
      context,
      {
        operationId: operationId('op_postgres_approval_stranded'),
        requestId: context.requestId,
        principalId: participant.principal.id,
        clientId: context.clientId,
        brainRecordId: brainRecordId('brn_approval_postgres_target'),
        mutation: {
          mode: 'replace',
          replacement: { content: 'Synthetic stranded approved body' },
        },
      },
      new AbortController().signal,
    );
    const store = new PostgresOperationalStateStore(pool);
    const [pending] = await store.listPendingApprovals();
    if (pending === undefined) throw new Error('missing pending approval');
    // The process claimed the approved execution, then crashed before dispatch.
    await store.resolveApprovalWithOperation({
      approvalRequestId: pending.id,
      status: 'approved',
      resolvedByPrincipalId: parent.principal.id,
      resolvedAt: brainReadNow,
      operationTransition: {
        operationId: operationId('op_postgres_approval_stranded'),
        expectedStates: ['APPROVAL_PENDING'],
        nextState: 'EXECUTING',
        transitionedAt: brainReadNow,
      },
      audit: {
        eventType: 'brain.approval.resolved',
        requestId: requestId('req_postgres_approval_stranded_resolve'),
        principalId: parent.principal.id,
        operation: 'resolve_approval',
        reasonCode: 'approval_approved',
      },
    });
    const access = {
      brainScopes: ['family_shared' as const],
      rootRefs: [roots.notion],
    };
    const before = await notion.fetch(
      { providerRecordId: target.provenance.providerRecordId, access },
      new AbortController().signal,
    );

    await pool.end();
    pool = createTestPool(connectionString);
    const replay = await build(
      new PostgresOperationalStateStore(pool),
    ).approval.resolveApproval(
      parent,
      {
        requestId: requestId('req_postgres_approval_stranded_resolve'),
        receivedAt: brainReadNow,
        clientId: 'synthetic-test-client',
      },
      { approvalRequestId: pending.id, resolution: 'approve' },
      new AbortController().signal,
    );

    expect(replay).toMatchObject({
      approvalStatus: 'approved',
      operationState: 'OUTCOME_UNKNOWN',
    });
    await expect(
      notion.fetch(
        { providerRecordId: target.provenance.providerRecordId, access },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ content: before.content });
    const rows = await pool.query<{
      readonly state: string;
      readonly reason: string | null;
      readonly approval: string | null;
      readonly payload: unknown;
    }>(
      `SELECT state,
              result_metadata->>'recoveryReason' AS reason,
              result_metadata->>'approvalDecisionReason' AS approval,
              mutation_payload AS payload
       FROM operations WHERE id = 'op_postgres_approval_stranded'`,
    );
    expect(rows.rows).toEqual([
      {
        state: 'OUTCOME_UNKNOWN',
        reason: 'recovery_provider_marker_not_found',
        approval: 'participant_parent_approval_required',
        payload: {
          mode: 'replace',
          replacement: { content: 'Synthetic stranded approved body' },
        },
      },
    ]);
  });
});
