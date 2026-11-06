import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CloudLoggingAuditSink } from '../../src/adapters/audit/cloud-logging-audit-sink.js';
import { StreamJsonLineDestination } from '../../src/adapters/logging/json-line-destination.js';
import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { createPostgresPool } from '../../src/adapters/state/postgres/pool.js';
import { PostgresOperationalStateStore } from '../../src/adapters/state/postgres/postgres-operational-state-store.js';
import { AuditOutboxService } from '../../src/application/audit-outbox-service.js';
import { principalId, requestId } from '../../src/domain/identifiers.js';
import type { AuditEvent } from '../../src/ports/audit-sink.js';
import type { AuditDeliveryErrorCode } from '../../src/ports/operational-state-store.js';
import {
  createTestPool,
  requireTestDatabaseUrl,
  resetOperationalState,
} from '../support/postgres.js';

const connectionString = requireTestDatabaseUrl();
const pool = createTestPool(connectionString);
const otherPool = createTestPool(connectionString);
const first = new PostgresOperationalStateStore(pool);
const second = new PostgresOperationalStateStore(otherPool);
const event: AuditEvent = {
  eventType: 'brain.read.completed',
  requestId: requestId('req_synthetic_audit_delivery'),
  principalId: principalId('operator'),
  operation: 'search_brain',
  outcome: 'COMPLETED',
  timestamp: new Date('2042-01-02T03:04:05Z'),
};

describe('durable audit delivery claims', () => {
  beforeAll(async () => {
    await runMigrations(pool);
  });
  beforeEach(async () => {
    await resetOperationalState(pool);
  });
  afterAll(async () => {
    await Promise.all([pool.end(), otherPool.end()]);
  });

  it('gives one pending event to only one of two concurrent workers', async () => {
    const queued = await first.enqueueAuditEvent(event);
    const claims = await Promise.all([
      first.claimAuditEvent(30_000),
      second.claimAuditEvent(30_000),
    ]);
    expect(claims.filter((claim) => claim !== null)).toMatchObject([
      { id: queued.id, attempts: 1, event },
    ]);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    expect(await first.listPendingAuditEvents(10)).toEqual([]);
  });

  it('skips a locked row instead of blocking another eligible event', async () => {
    const locked = await first.enqueueAuditEvent(event);
    const next = await first.enqueueAuditEvent(event);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT id FROM audit_outbox WHERE id = $1 FOR UPDATE',
        [locked.id],
      );
      const claim = await second.claimAuditEvent(30_000);
      expect(claim?.id).toBe(next.id);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('persists an abandoned claim and fences its owner after lease expiry and restart', async () => {
    const queued = await first.enqueueAuditEvent(event);
    const transientPool = createTestPool(connectionString);
    const abandoned = await new PostgresOperationalStateStore(
      transientPool,
    ).claimAuditEvent(30_000);
    await transientPool.end();
    expect(abandoned?.id).toBe(queued.id);
    expect(await second.claimAuditEvent(30_000)).toBeNull();
    // Simulate elapsed database time without sleeping or changing a host clock.
    await pool.query(
      "UPDATE audit_outbox SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [queued.id],
    );
    if (abandoned === null) throw new Error('missing synthetic claim');
    expect(
      await first.markAuditEventDelivered(queued.id, abandoned.claimToken),
    ).toBe(false);
    expect(
      await first.markAuditEventFailed(
        queued.id,
        abandoned.claimToken,
        'audit_sink_unavailable',
        1_000,
      ),
    ).toBe(false);
    const reclaimed = await second.claimAuditEvent(30_000);
    if (reclaimed === null)
      throw new Error('missing reclaimed synthetic claim');
    expect(reclaimed).toMatchObject({ id: queued.id, attempts: 2 });
    expect(reclaimed.claimToken).not.toBe(abandoned.claimToken);
    expect(
      await first.markAuditEventDelivered(queued.id, abandoned.claimToken),
    ).toBe(false);
    expect(
      await first.markAuditEventFailed(
        queued.id,
        abandoned.claimToken,
        'audit_sink_unavailable',
        1_000,
      ),
    ).toBe(false);
    expect(
      await second.markAuditEventDelivered(queued.id, reclaimed.claimToken),
    ).toBe(true);
    expect(
      await second.markAuditEventDelivered(queued.id, reclaimed.claimToken),
    ).toBe(false);
    expect(await second.claimAuditEvent(30_000)).toBeNull();
  });

  it.each(['acknowledge', 'retry'] as const)(
    'rechecks lease expiry after waiting for a row lock before %s',
    async (phase) => {
      await first.enqueueAuditEvent(event);
      const blockedPool = createPostgresPool({
        connectionString,
        applicationName: 'synthetic_audit_lock_wait',
        maximumConnections: 1,
      });
      const blockedStore = new PostgresOperationalStateStore(blockedPool);
      const backend = await blockedPool.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      const claim = await blockedStore.claimAuditEvent(1_500);
      if (claim === null) throw new Error('missing synthetic claim');
      const locker = await pool.connect();
      let pending: Promise<boolean> | undefined;
      try {
        await locker.query('BEGIN');
        await locker.query(
          'SELECT id FROM audit_outbox WHERE id = $1 FOR UPDATE',
          [claim.id],
        );
        pending =
          phase === 'acknowledge'
            ? blockedStore.markAuditEventDelivered(claim.id, claim.claimToken)
            : blockedStore.markAuditEventFailed(
                claim.id,
                claim.claimToken,
                'audit_sink_unavailable',
                1_000,
              );
        // Observe the actual blocked database query before letting its lease lapse.
        await expect
          .poll(
            async () => {
              const state = await pool.query<{ blocked: boolean }>(
                "SELECT wait_event_type = 'Lock' AS blocked FROM pg_stat_activity WHERE pid = $1",
                [backend.rows[0]?.pid],
              );
              return state.rows[0]?.blocked;
            },
            { interval: 10, timeout: 1_000 },
          )
          .toBe(true);
        await locker.query(
          'SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM claim_expires_at - clock_timestamp())) + 0.02) FROM audit_outbox WHERE id = $1',
          [claim.id],
        );
        await locker.query('COMMIT');
        expect(await pending).toBe(false);
        const row = await pool.query(
          'SELECT delivered_at, claim_token FROM audit_outbox WHERE id = $1',
          [claim.id],
        );
        expect(row.rows).toEqual([
          { delivered_at: null, claim_token: claim.claimToken },
        ]);
      } finally {
        await locker.query('ROLLBACK');
        locker.release();
        await pending?.catch(() => undefined);
        await blockedPool.end();
      }
    },
  );

  it('keeps failed delivery pending until its database-controlled retry time', async () => {
    const queued = await first.enqueueAuditEvent(event);
    const claim = await first.claimAuditEvent(30_000);
    if (claim === null) throw new Error('missing synthetic claim');
    expect(
      await first.markAuditEventFailed(
        queued.id,
        claim.claimToken,
        'audit_sink_unavailable',
        60_000,
      ),
    ).toBe(true);
    expect(await second.claimAuditEvent(30_000)).toBeNull();
    const result = await pool.query(
      'SELECT attempts, delivered_at, last_error_code, claim_token, claim_expires_at, available_at > clock_timestamp() AS delayed FROM audit_outbox WHERE id = $1',
      [queued.id],
    );
    expect(result.rows).toEqual([
      {
        attempts: 1,
        delivered_at: null,
        last_error_code: 'audit_sink_unavailable',
        claim_token: null,
        claim_expires_at: null,
        delayed: true,
      },
    ]);
    await pool.query(
      "UPDATE audit_outbox SET available_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [queued.id],
    );
    expect(await second.claimAuditEvent(30_000)).toMatchObject({
      id: queued.id,
      attempts: 2,
    });
  });

  it('connects the real worker, database and confirmed output without holding a database lock during delivery', async () => {
    const queued = await first.enqueueAuditEvent({
      ...event,
      content: 'SYNTHETIC_CONTENT_MUST_NOT_LOG',
    } as AuditEvent);
    const entered = Promise.withResolvers<undefined>();
    const lines: string[] = [];
    let confirm: () => void = () => {
      throw new Error('synthetic write not started');
    };
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf8'));
        confirm = callback;
        entered.resolve(undefined);
      },
    });
    const sink = new CloudLoggingAuditSink(
      new StreamJsonLineDestination(stream),
    );
    const flushing = new AuditOutboxService(first, sink).flush(
      new AbortController().signal,
    );
    try {
      await entered.promise;
      const row = await otherPool.query(
        'SELECT delivered_at, attempts FROM audit_outbox WHERE id = $1 FOR UPDATE NOWAIT',
        [queued.id],
      );
      expect(row.rows).toEqual([{ delivered_at: null, attempts: 1 }]);
      expect(
        await new AuditOutboxService(second, sink).flush(
          new AbortController().signal,
        ),
      ).toEqual({ claimed: 0, delivered: 0, failed: 0, lostClaims: 0 });
      confirm();
      expect(await flushing).toEqual({
        claimed: 1,
        delivered: 1,
        failed: 0,
        lostClaims: 0,
      });
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? '') as unknown).toEqual({
        ...event,
        timestamp: '2042-01-02T03:04:05.000Z',
        severity: 'NOTICE',
        logType: 'family_brain_audit',
      });
      expect(await first.claimAuditEvent(30_000)).toBeNull();
    } finally {
      await flushing.catch(() => undefined);
      stream.destroy();
    }
  });

  it('retries a logging outage after connection restart with no lost event or raw error', async () => {
    const queued = await first.enqueueAuditEvent(event);
    const worker = new AuditOutboxService(first, {
      emit: () => Promise.reject(new Error('SYNTHETIC_PRIVATE_SINK_FAILURE')),
    });
    expect(await worker.flush(new AbortController().signal)).toEqual({
      claimed: 1,
      delivered: 0,
      failed: 1,
      lostClaims: 0,
    });
    const rows = await pool.query(
      'SELECT delivered_at, last_error_code FROM audit_outbox WHERE id = $1',
      [queued.id],
    );
    expect(rows.rows).toEqual([
      { delivered_at: null, last_error_code: 'audit_sink_unavailable' },
    ]);
    await pool.query(
      "UPDATE audit_outbox SET available_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [queued.id],
    );
    const restartedPool = createTestPool(connectionString);
    const received: AuditEvent[] = [];
    try {
      const restarted = new AuditOutboxService(
        new PostgresOperationalStateStore(restartedPool),
        {
          emit: (value) => {
            received.push(value);
            return Promise.resolve();
          },
        },
      );
      expect(await restarted.flush(new AbortController().signal)).toEqual({
        claimed: 1,
        delivered: 1,
        failed: 0,
        lostClaims: 0,
      });
      expect(received).toEqual([event]);
      expect(await restarted.flush(new AbortController().signal)).toEqual({
        claimed: 0,
        delivered: 0,
        failed: 0,
        lostClaims: 0,
      });
    } finally {
      await restartedPool.end();
    }
  });

  it('rejects acknowledgement without the exact current event claim', async () => {
    const queued = await first.enqueueAuditEvent(event);
    const unclaimed = await first.enqueueAuditEvent(event);
    const claim = await first.claimAuditEvent(30_000);
    if (claim === null) throw new Error('missing synthetic claim');
    expect(claim.id).toBe(queued.id);
    expect(
      await first.markAuditEventDelivered(unclaimed.id, claim.claimToken),
    ).toBe(false);
    expect(
      await first.markAuditEventFailed(
        unclaimed.id,
        claim.claimToken,
        'audit_sink_unavailable',
        1_000,
      ),
    ).toBe(false);
    expect(
      await first.markAuditEventDelivered(
        claim.id,
        '00000000-0000-0000-0000-000000000000',
      ),
    ).toBe(false);
    expect(
      await first.markAuditEventDelivered(claim.id, claim.claimToken),
    ).toBe(true);
    expect(
      await first.markAuditEventFailed(
        claim.id,
        claim.claimToken,
        'audit_sink_unavailable',
        1_000,
      ),
    ).toBe(false);
    expect(await first.listPendingAuditEvents(10)).toMatchObject([
      { id: unclaimed.id, attempts: 0 },
    ]);
  });

  it.each([
    { code: 'SYNTHETIC_PRIVATE_ERROR', delay: 1_000 },
    { code: 'audit_sink_unavailable', delay: 0 },
    { code: 'audit_sink_unavailable', delay: Number.NaN },
    { code: 'audit_sink_unavailable', delay: 3_600_001 },
  ])(
    'rejects invalid retry metadata without releasing or modifying the claim (%#)',
    async ({ code, delay }) => {
      await first.enqueueAuditEvent(event);
      const claim = await first.claimAuditEvent(30_000);
      if (claim === null) throw new Error('missing synthetic claim');
      const error: unknown = await first
        .markAuditEventFailed(
          claim.id,
          claim.claimToken,
          code as AuditDeliveryErrorCode,
          delay,
        )
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'invalid_request' });
      expect(JSON.stringify(error)).not.toContain('SYNTHETIC_PRIVATE_ERROR');
      expect(
        await first.markAuditEventDelivered(claim.id, claim.claimToken),
      ).toBe(true);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 300_001])(
    'rejects invalid lease duration %s without claiming a row',
    async (leaseMs) => {
      await first.enqueueAuditEvent(event);
      await expect(first.claimAuditEvent(leaseMs)).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(await first.listPendingAuditEvents(10)).toMatchObject([
        { attempts: 0 },
      ]);
    },
  );
});
