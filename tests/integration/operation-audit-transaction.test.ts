import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { PostgresOperationalStateStore } from '../../src/adapters/state/postgres/postgres-operational-state-store.js';
import {
  brainRecordId,
  operationId,
  principalId,
  providerRecordId,
  requestId,
} from '../../src/domain/identifiers.js';
import type { AuditEvent } from '../../src/ports/audit-sink.js';
import type {
  CreateOperationRecord,
  OperationTransition,
} from '../../src/ports/operational-state-store.js';
import {
  createTestPool,
  requireTestDatabaseUrl,
  resetOperationalState,
} from '../support/postgres.js';

const connectionString = requireTestDatabaseUrl();
const pool = createTestPool(connectionString);
const store = new PostgresOperationalStateStore(pool);
const createdAt = new Date('2042-01-02T03:04:05.000Z');
const transitionedAt = new Date('2042-01-02T03:04:06.000Z');
const operation: CreateOperationRecord = {
  operationId: operationId('op_synthetic_atomic_audit'),
  requestId: requestId('req_synthetic_atomic_audit'),
  principalId: principalId('prn_operator'),
  clientId: 'synthetic-client',
  operation: 'update_record',
  requestFingerprint: 'a'.repeat(64),
  targetBrainRecordId: brainRecordId('brn_synthetic_atomic_audit'),
  mutationPayload: { content: 'SYNTHETIC_PRIVATE_BODY' },
  createdAt,
};
const transition: OperationTransition = {
  operationId: operation.operationId,
  expectedStates: ['RECEIVED'],
  nextState: 'EXECUTING',
  provider: 'notion',
  providerRecordId: providerRecordId('synthetic-page'),
  providerVersion: 'synthetic-v1',
  policyVersion: 'synthetic-policy-v1',
  transitionedAt,
};
const audit = { eventType: 'brain.operation.transitioned' };

describe('atomic operation transition and metadata-only audit', () => {
  beforeAll(async () => {
    await runMigrations(pool);
  });
  beforeEach(async () => {
    await resetOperationalState(pool);
    await store.openOperation(operation);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('rolls back the transition when the audit insert fails and leaves the connection reusable', async () => {
    // Test-only fault in the isolated database; production migrations are unchanged.
    await pool.query(`ALTER TABLE audit_outbox ADD CONSTRAINT synthetic_reject_audit
      CHECK (event->>'operationId' IS DISTINCT FROM 'op_synthetic_atomic_audit')`);
    try {
      const error: unknown = await store
        .transitionOperationWithAudit(transition, audit)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: 'provider_unavailable',
        retryable: true,
        details: { reason: 'operation_audit_state_unavailable' },
      });
      expect(JSON.stringify(error)).not.toMatch(
        /synthetic_reject_audit|SYNTHETIC_PRIVATE_BODY|INSERT|UPDATE/u,
      );
      expect(await store.getOperation(operation.operationId)).toMatchObject({
        state: 'RECEIVED',
        updatedAt: createdAt,
      });
      expect(await store.listPendingAuditEvents(10)).toEqual([]);
    } finally {
      await pool.query(
        'ALTER TABLE audit_outbox DROP CONSTRAINT synthetic_reject_audit',
      );
    }
    await store.transitionOperationWithAudit(transition, audit);
    expect(await store.listPendingAuditEvents(10)).toHaveLength(1);
  });

  it('inserts no event on a stale transition or a missing operation', async () => {
    for (const request of [
      {
        ...transition,
        expectedStates: ['EXECUTING'] as const,
        nextState: 'COMPLETED' as const,
      },
      { ...transition, operationId: operationId('op_synthetic_missing') },
    ]) {
      await expect(
        store.transitionOperationWithAudit(request, audit),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        details: { reason: 'invalid_state_transition' },
      });
    }
    expect(await store.getOperation(operation.operationId)).toMatchObject({
      state: 'RECEIVED',
    });
    expect(await store.listPendingAuditEvents(10)).toEqual([]);
  });

  it('does not report success or retain either write when a deferred check rejects COMMIT', async () => {
    await pool.query(`CREATE FUNCTION synthetic_reject_audit_commit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_COMMIT_FAILURE'; END $$`);
    try {
      await pool.query(`CREATE CONSTRAINT TRIGGER synthetic_audit_commit_check
        AFTER INSERT ON audit_outbox DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION synthetic_reject_audit_commit()`);
      try {
        const error: unknown = await store
          .transitionOperationWithAudit(transition, audit)
          .catch((caught: unknown) => caught);
        expect(error).toMatchObject({
          code: 'provider_unavailable',
          details: { reason: 'operation_audit_state_unavailable' },
        });
        expect(JSON.stringify(error)).not.toContain('SYNTHETIC_COMMIT_FAILURE');
        expect(await store.getOperation(operation.operationId)).toMatchObject({
          state: 'RECEIVED',
          updatedAt: createdAt,
        });
        expect(await store.listPendingAuditEvents(10)).toEqual([]);
      } finally {
        await pool.query(
          'DROP TRIGGER synthetic_audit_commit_check ON audit_outbox',
        );
      }
    } finally {
      await pool.query('DROP FUNCTION synthetic_reject_audit_commit()');
    }
  });

  it('keeps the new operation state invisible while audit insertion is blocked', async () => {
    const blocker = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE audit_outbox IN SHARE MODE');
      pending = store.transitionOperationWithAudit(transition, audit);
      // Wait for the real database lock wait, not an assumed scheduling delay.
      await expect
        .poll(async () => {
          const blocked = await pool.query<{
            count: number;
          }>(`SELECT count(*)::int AS count
          FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query LIKE 'INSERT INTO audit_outbox%'`);
          return blocked.rows[0]?.count;
        })
        .toBe(1);
      expect(await store.getOperation(operation.operationId)).toMatchObject({
        state: 'RECEIVED',
      });
      expect(await store.listPendingAuditEvents(10)).toEqual([]);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending;
    }
    expect(await store.getOperation(operation.operationId)).toMatchObject({
      state: 'EXECUTING',
    });
    expect(await store.listPendingAuditEvents(10)).toHaveLength(1);
  });

  it('commits one transition and one event under concurrent attempts on separate connections', async () => {
    const otherPool = createTestPool(connectionString);
    try {
      const other = new PostgresOperationalStateStore(otherPool);
      const results = await Promise.allSettled([
        store.transitionOperationWithAudit(transition, audit),
        other.transitionOperationWithAudit(transition, audit),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toMatchObject([
        {
          reason: {
            code: 'invalid_request',
            details: { reason: 'invalid_state_transition' },
          },
        },
      ]);
      expect(await store.getOperation(operation.operationId)).toMatchObject({
        state: 'EXECUTING',
      });
      expect(await store.listPendingAuditEvents(10)).toMatchObject([
        {
          event: {
            operationId: 'op_synthetic_atomic_audit',
            outcome: 'EXECUTING',
          },
        },
      ]);
    } finally {
      await otherPool.end();
    }
  });

  it.each(['prn_operator', 'prn_steward', 'prn_participant'])(
    'derives correlation from persisted %s operation, ignoring runtime overrides and content',
    async (actor) => {
      await resetOperationalState(pool);
      await store.openOperation({
        ...operation,
        principalId: principalId(actor),
      });
      const runtimeAudit = {
        ...audit,
        requestId: 'req_forged',
        principalId: 'prn_forged',
        clientId: 'forged-client',
        operationId: 'op_forged',
        operation: 'delete_record',
        outcome: 'COMPLETED',
        provider: 'github',
        providerRecordId: 'forged-target',
        brainRecordId: 'brn_forged',
        providerVersion: 'forged-version',
        policyVersion: 'forged-policy',
        approvalRequestId: 'apr_forged',
        timestamp: new Date('2000-01-01'),
        content: 'SYNTHETIC_PRIVATE_BODY',
        providerPayload: { secret: 'SYNTHETIC_SECRET' },
        toJSON: () => ({ secret: 'SYNTHETIC_SERIALIZATION_HOOK' }),
        reasonCode: 'authorization_allowed',
        integrityHash: 'synthetic-hash',
      };
      await store.transitionOperationWithAudit(transition, runtimeAudit);
      const events = await store.listPendingAuditEvents(10);
      expect(events).toHaveLength(1);
      expect(events[0]?.event).toEqual({
        eventType: 'brain.operation.transitioned',
        requestId: 'req_synthetic_atomic_audit',
        principalId: actor,
        clientId: 'synthetic-client',
        operationId: 'op_synthetic_atomic_audit',
        operation: 'update_record',
        outcome: 'EXECUTING',
        provider: 'notion',
        providerRecordId: 'synthetic-page',
        brainRecordId: 'brn_synthetic_atomic_audit',
        providerVersion: 'synthetic-v1',
        policyVersion: 'synthetic-policy-v1',
        reasonCode: 'authorization_allowed',
        integrityHash: 'synthetic-hash',
        timestamp: transitionedAt,
      });
      const raw = await pool.query('SELECT event FROM audit_outbox');
      expect(JSON.stringify(raw.rows)).not.toMatch(
        /forged|SYNTHETIC_PRIVATE_BODY|SYNTHETIC_SECRET|SYNTHETIC_SERIALIZATION_HOOK/u,
      );
    },
  );

  it('uses retained provider metadata from the transitioned row when the request omits it', async () => {
    await store.transitionOperation(transition);
    await store.transitionOperationWithAudit(
      {
        operationId: operation.operationId,
        expectedStates: ['EXECUTING'],
        nextState: 'COMPLETED',
        transitionedAt: new Date('2042-01-02T03:04:07.000Z'),
      },
      audit,
    );
    expect(await store.listPendingAuditEvents(10)).toMatchObject([
      {
        event: {
          outcome: 'COMPLETED',
          provider: 'notion',
          providerRecordId: 'synthetic-page',
          providerVersion: 'synthetic-v1',
          policyVersion: 'synthetic-policy-v1',
        },
      },
    ]);
  });

  it.each(['eventType', 'reasonCode', 'integrityHash'])(
    'rejects a nested payload in %s without serializing it or committing',
    async (field) => {
      let invoked = false;
      const invalid = {
        ...audit,
        [field]: {
          toJSON: () => {
            invoked = true;
            return 'SYNTHETIC_SECRET';
          },
        },
      };
      await expect(
        store.transitionOperationWithAudit(transition, invalid),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        details: { reason: 'invalid_audit_event' },
      });
      expect(invoked).toBe(false);
      expect(await store.getOperation(operation.operationId)).toMatchObject({
        state: 'RECEIVED',
      });
      expect(await store.listPendingAuditEvents(10)).toEqual([]);
    },
  );

  it.each(['providerRecordId', 'providerVersion', 'policyVersion'])(
    'rejects nested transition %s before the driver can turn its payload into audit text',
    async (field) => {
      let invoked = false;
      for (const value of [
        { content: 'SYNTHETIC_TRANSITION_PRIVATE_BODY' },
        {
          toJSON: () => {
            invoked = true;
            return 'SYNTHETIC_TRANSITION_PRIVATE_BODY';
          },
        },
        {
          toPostgres: () => {
            invoked = true;
            return 'SYNTHETIC_TRANSITION_PRIVATE_BODY';
          },
        },
      ]) {
        await expect(
          store.transitionOperationWithAudit(
            { ...transition, [field]: value },
            audit,
          ),
        ).rejects.toMatchObject({
          code: 'invalid_request',
          details: { reason: 'invalid_audit_event' },
        });
        expect(invoked).toBe(false);
        expect(await store.getOperation(operation.operationId)).toEqual({
          ...operation,
          state: 'RECEIVED',
          updatedAt: createdAt,
        });
        expect(await store.listPendingAuditEvents(10)).toEqual([]);
      }
    },
  );

  it('rejects an expected-state set containing the destination so repeated calls cannot duplicate the event', async () => {
    await expect(
      store.transitionOperationWithAudit(
        {
          ...transition,
          expectedStates: ['RECEIVED', 'EXECUTING'],
        },
        audit,
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'audit_transition_must_change_state' },
    });
    expect(await store.getOperation(operation.operationId)).toMatchObject({
      state: 'RECEIVED',
    });
    expect(await store.listPendingAuditEvents(10)).toEqual([]);
  });

  it('rejects object-valued expected states before driver coercion can bypass the no-op guard', async () => {
    await store.transitionOperation(transition);
    let invoked = false;
    const invalid = {
      ...transition,
      expectedStates: [
        {
          toPostgres: () => {
            invoked = true;
            return 'EXECUTING';
          },
        },
      ],
    } as unknown as OperationTransition;
    await expect(
      store.transitionOperationWithAudit(invalid, audit),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'invalid_audit_event' },
    });
    expect(invoked).toBe(false);
    expect(await store.listPendingAuditEvents(10)).toEqual([]);
  });

  it('returns a safe error if acquiring a database connection fails', async () => {
    const closedPool = createTestPool(connectionString);
    await closedPool.end();
    await expect(
      new PostgresOperationalStateStore(
        closedPool,
      ).transitionOperationWithAudit(transition, audit),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'operation_audit_state_unavailable' },
    });
  });

  it('also validates standalone outbox events before JSON serialization', async () => {
    let invoked = false;
    const invalid = {
      eventType: 'brain.read.completed',
      requestId: requestId('req_synthetic_read'),
      principalId: principalId('prn_operator'),
      operation: 'search_brain',
      outcome: 'COMPLETED',
      providerVersion: {
        toJSON: () => {
          invoked = true;
          return 'SYNTHETIC_SECRET';
        },
      },
      timestamp: createdAt,
    } as unknown as AuditEvent;
    await expect(store.enqueueAuditEvent(invalid)).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'invalid_audit_event' },
    });
    expect(invoked).toBe(false);
    expect(await store.listPendingAuditEvents(10)).toEqual([]);
  });
});
