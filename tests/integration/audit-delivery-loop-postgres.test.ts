import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { PostgresOperationalStateStore } from '../../src/adapters/state/postgres/postgres-operational-state-store.js';
import { AuditOutboxService } from '../../src/application/audit-outbox-service.js';
import { principalId, requestId } from '../../src/domain/identifiers.js';
import type { AuditEvent, AuditSink } from '../../src/ports/audit-sink.js';
import { AuditDeliveryLoop } from '../../src/runtime/audit-delivery.js';
import {
  createTestPool,
  queryRows,
  requireTestDatabaseUrl,
  resetOperationalState,
} from '../support/postgres.js';

const connectionString = requireTestDatabaseUrl();
const event = (suffix: string): AuditEvent => ({
  eventType: 'brain.request.completed',
  requestId: requestId(`req_synthetic_loop_${suffix}`),
  principalId: principalId('prn_operator'),
  operation: 'search_brain',
  outcome: 'COMPLETED',
  reasonCode: 'search_complete',
  timestamp: new Date('2042-01-02T03:04:05Z'),
});

async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('in-process audit delivery over PostgreSQL', () => {
  const pool = createTestPool(connectionString);

  beforeAll(async () => {
    await runMigrations(pool);
  });
  beforeEach(async () => {
    await resetOperationalState(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('delivers queued events and survives a shutdown mid-delivery', async () => {
    const store = new PostgresOperationalStateStore(pool);
    for (const suffix of ['a', 'b', 'c']) {
      await store.enqueueAuditEvent(event(suffix));
    }

    // First process: the sink hangs on the first event, then the process stops.
    let sinkCalls = 0;
    const hanging: AuditSink = {
      emit: (_event, signal) => {
        sinkCalls += 1;
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('cancelled', 'AbortError'));
          });
        });
      },
    };
    const firstLoop = new AuditDeliveryLoop(
      new AuditOutboxService(store, hanging, {
        baseRetryMs: 1,
        maximumRetryMs: 1,
      }),
      { batchSize: 100, intervalMs: 50, log: () => undefined },
    );
    firstLoop.start();
    await until(() => sinkCalls > 0);
    await firstLoop.close();

    const undelivered = await queryRows<{ count: string }>(
      pool,
      'SELECT count(*)::text AS count FROM audit_outbox WHERE delivered_at IS NULL',
    );
    expect(undelivered[0]?.count).toBe('3');

    // Next process: a fresh pool and store deliver everything exactly once.
    const restarted = createTestPool(connectionString);
    try {
      const delivered: string[] = [];
      const sink: AuditSink = {
        emit: (emitted) => {
          delivered.push(String(emitted.requestId));
          return Promise.resolve();
        },
      };
      const secondLoop = new AuditDeliveryLoop(
        new AuditOutboxService(
          new PostgresOperationalStateStore(restarted),
          sink,
          {
            baseRetryMs: 1,
            maximumRetryMs: 1,
          },
        ),
        { batchSize: 100, intervalMs: 20, log: () => undefined },
      );
      secondLoop.start();
      await until(() => delivered.length === 3);
      await secondLoop.close();

      expect([...delivered].sort()).toEqual([
        'req_synthetic_loop_a',
        'req_synthetic_loop_b',
        'req_synthetic_loop_c',
      ]);
      const remaining = await queryRows<{ count: string }>(
        pool,
        'SELECT count(*)::text AS count FROM audit_outbox WHERE delivered_at IS NULL',
      );
      expect(remaining[0]?.count).toBe('0');
    } finally {
      await restarted.end();
    }
  });
});
