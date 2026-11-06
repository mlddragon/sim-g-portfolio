import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuditOutboxService } from '../../../src/application/audit-outbox-service.js';
import type { AuditOutboxOptions } from '../../../src/application/audit-outbox-service.js';
import { principalId, requestId } from '../../../src/domain/identifiers.js';
import type { AuditEvent, AuditSink } from '../../../src/ports/audit-sink.js';
import type {
  AuditDeliveryErrorCode,
  ClaimedAuditOutboxRecord,
} from '../../../src/ports/operational-state-store.js';

const event: AuditEvent = {
  eventType: 'brain.read.completed',
  requestId: requestId('req_synthetic_worker'),
  principalId: principalId('prn_synthetic_operator'),
  operation: 'search_brain',
  outcome: 'COMPLETED',
  timestamp: new Date('2042-01-02T03:04:05Z'),
};

function fixture(count = 1, attempts = 1) {
  const claims: ClaimedAuditOutboxRecord[] = Array.from(
    { length: count },
    (_, index) => ({
      id: String(index + 1),
      event,
      attempts,
      availableAt: new Date('2042-01-02T03:04:05Z'),
      claimExpiresAt: new Date('2042-01-02T03:04:35Z'),
      claimToken: `synthetic_claim_${String(index + 1)}`,
    }),
  );
  const delivered: string[] = [];
  const deferred: {
    id: string;
    code: AuditDeliveryErrorCode;
    delay: number;
  }[] = [];
  const store = {
    claimAuditEvent: vi.fn((_leaseMs: number) =>
      Promise.resolve(claims.shift() ?? null),
    ),
    markAuditEventDelivered: vi.fn((id: string, token: string) => {
      if (token !== `synthetic_claim_${id}`)
        throw new Error('wrong synthetic owner');
      delivered.push(id);
      return Promise.resolve(true);
    }),
    markAuditEventFailed: vi.fn(
      (
        id: string,
        token: string,
        code: AuditDeliveryErrorCode,
        delay: number,
      ) => {
        if (token !== `synthetic_claim_${id}`)
          throw new Error('wrong synthetic owner');
        deferred.push({ id, code, delay });
        return Promise.resolve(true);
      },
    ),
  };
  const emitted: AuditEvent[] = [];
  const sink: AuditSink = {
    emit: (value) => {
      emitted.push(value);
      return Promise.resolve();
    },
  };
  return { store, sink, claims, delivered, deferred, emitted };
}

const signal = () => new AbortController().signal;

describe('AuditOutboxService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims just in time and acknowledges only confirmed sequential delivery', async () => {
    const f = fixture(2);
    const entered = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    let writes = 0;
    const worker = new AuditOutboxService(f.store, {
      emit: async (value) => {
        f.emitted.push(value);
        writes++;
        if (writes === 1) {
          entered.resolve(undefined);
          await finish.promise;
        }
      },
    });
    const flushing = worker.flush(signal());
    await entered.promise;
    expect(f.claims).toHaveLength(1);
    expect(f.delivered).toEqual([]);
    finish.resolve(undefined);
    expect(await flushing).toEqual({
      claimed: 2,
      delivered: 2,
      failed: 0,
      lostClaims: 0,
    });
    expect(f.emitted).toEqual([event, event]);
    expect(f.delivered).toEqual(['1', '2']);
  });

  it('limits a flush without claiming the rest of the queue', async () => {
    const f = fixture(2);
    expect(
      await new AuditOutboxService(f.store, f.sink, { batchSize: 1 }).flush(
        signal(),
      ),
    ).toEqual({ claimed: 1, delivered: 1, failed: 0, lostClaims: 0 });
    expect(f.claims).toHaveLength(1);
    expect(f.emitted).toEqual([event]);
  });

  it.each([
    { attempts: 1, delay: 1_000 },
    { attempts: 2, delay: 2_000 },
    { attempts: 7, delay: 60_000 },
    { attempts: 2147483647, delay: 60_000 },
  ])(
    'retains failures with safe capped retry delay for attempt $attempts',
    async ({ attempts, delay }) => {
      const f = fixture(1, attempts);
      const worker = new AuditOutboxService(f.store, {
        emit: () => Promise.reject(new Error('SYNTHETIC_TOKEN_SQL_PAYLOAD')),
      });
      expect(await worker.flush(signal())).toEqual({
        claimed: 1,
        delivered: 0,
        failed: 1,
        lostClaims: 0,
      });
      expect(f.deferred).toEqual([
        { id: '1', code: 'audit_sink_unavailable', delay },
      ]);
      expect(f.delivered).toEqual([]);
    },
  );

  it('does not count a stale acknowledgement as delivery', async () => {
    const f = fixture();
    f.store.markAuditEventDelivered.mockResolvedValue(false);
    expect(
      await new AuditOutboxService(f.store, f.sink).flush(signal()),
    ).toEqual({ claimed: 1, delivered: 0, failed: 0, lostClaims: 1 });
    expect(f.deferred).toEqual([]);
  });

  it('does not overwrite another owner when retry scheduling loses its claim', async () => {
    const f = fixture();
    f.store.markAuditEventFailed.mockResolvedValue(false);
    expect(
      await new AuditOutboxService(f.store, {
        emit: () => Promise.reject(new Error('synthetic failure')),
      }).flush(signal()),
    ).toEqual({ claimed: 1, delivered: 0, failed: 0, lostClaims: 1 });
  });

  it.each(['claim', 'acknowledge', 'retry'] as const)(
    'stops on %s storage failure without exposing raw details or inventing a new outcome',
    async (phase) => {
      const f = fixture(2);
      const privateError = new Error('SYNTHETIC_PRIVATE_DATABASE_ERROR');
      let sink = f.sink;
      if (phase === 'claim')
        f.store.claimAuditEvent.mockRejectedValue(privateError);
      if (phase === 'acknowledge')
        f.store.markAuditEventDelivered.mockRejectedValue(privateError);
      if (phase === 'retry') {
        f.store.markAuditEventFailed.mockRejectedValue(privateError);
        sink = {
          emit: () => Promise.reject(new Error('synthetic sink failure')),
        };
      }
      const error: unknown = await new AuditOutboxService(f.store, sink)
        .flush(signal())
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: 'provider_unavailable',
        retryable: true,
        details: { reason: 'audit_state_unavailable' },
      });
      expect(JSON.stringify(error)).not.toContain(
        'SYNTHETIC_PRIVATE_DATABASE_ERROR',
      );
      expect(f.deferred).toEqual([]);
      expect(f.delivered).toEqual([]);
      expect(f.claims).toHaveLength(phase === 'claim' ? 2 : 1);
    },
  );

  it('rejects an already cancelled flush without claiming or leaking its reason', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error('SYNTHETIC_ABORT_SECRET'));
    const error: unknown = await new AuditOutboxService(f.store, f.sink)
      .flush(controller.signal)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: 'AbortError',
      message: 'Audit delivery cancelled',
    });
    expect(f.claims).toHaveLength(1);
    expect(f.emitted).toEqual([]);
  });

  it('releases a claim acquired during cancellation without sending the event', async () => {
    const f = fixture();
    const claim = f.claims[0];
    if (claim === undefined) throw new Error('missing synthetic claim');
    const controller = new AbortController();
    f.store.claimAuditEvent.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(claim);
    });
    await expect(
      new AuditOutboxService(f.store, f.sink).flush(controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.emitted).toEqual([]);
    expect(f.deferred).toEqual([
      { id: '1', code: 'audit_delivery_cancelled', delay: 1_000 },
    ]);
  });

  it('does not acknowledge when cancellation follows sink success', async () => {
    const f = fixture();
    const controller = new AbortController();
    const worker = new AuditOutboxService(f.store, {
      emit: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    await expect(worker.flush(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(f.delivered).toEqual([]);
    expect(f.deferred).toEqual([
      { id: '1', code: 'audit_delivery_cancelled', delay: 1_000 },
    ]);
  });

  it.each(['timeout', 'cancel'] as const)(
    'bounds a non-cooperative sink on %s, absorbs late failure, and prevents overlapping sends',
    async (mode) => {
      vi.useFakeTimers();
      const f = fixture(2);
      const controller = new AbortController();
      const entered = Promise.withResolvers<undefined>();
      const late = Promise.withResolvers<undefined>();
      let sinkSignal: AbortSignal | undefined;
      const worker = new AuditOutboxService(
        f.store,
        {
          emit: (_event, value) => {
            sinkSignal = value;
            entered.resolve(undefined);
            return late.promise;
          },
        },
        { deliveryTimeoutMs: 10, leaseMs: 1_000 },
      );
      const flushing = worker
        .flush(controller.signal)
        .catch((caught: unknown) => caught);
      await entered.promise;
      await expect(worker.flush(signal())).rejects.toMatchObject({
        code: 'provider_unavailable',
      });
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(10);
      else controller.abort(new Error('SYNTHETIC_ABORT_SECRET'));
      const result: unknown = await flushing;
      if (mode === 'timeout')
        expect(result).toEqual({
          claimed: 1,
          delivered: 0,
          failed: 1,
          lostClaims: 0,
        });
      else
        expect(result).toMatchObject({
          name: 'AbortError',
          message: 'Audit delivery cancelled',
        });
      expect(sinkSignal?.aborted).toBe(true);
      expect(f.claims).toHaveLength(1);
      expect(f.delivered).toEqual([]);
      expect(f.deferred).toEqual([
        {
          id: '1',
          code:
            mode === 'timeout'
              ? 'audit_sink_timeout'
              : 'audit_delivery_cancelled',
          delay: 1_000,
        },
      ]);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      await expect(worker.flush(signal())).rejects.toMatchObject({
        code: 'provider_unavailable',
      });
      late.reject(new Error('SYNTHETIC_LATE_SINK_ERROR'));
      await vi.advanceTimersByTimeAsync(0);
      // Late failure must not acknowledge or rewrite the scheduled retry.
      expect(f.delivered).toEqual([]);
      expect(f.deferred).toHaveLength(1);
    },
  );

  it.each<Partial<AuditOutboxOptions>>([
    { batchSize: 0 },
    { batchSize: 1_001 },
    { batchSize: Number.NaN },
    { baseRetryMs: 0 },
    { baseRetryMs: 60_001 },
    { maximumRetryMs: Number.POSITIVE_INFINITY },
    { maximumRetryMs: 3_600_001 },
    { leaseMs: 0 },
    { leaseMs: 300_001 },
    { deliveryTimeoutMs: 0 },
    { deliveryTimeoutMs: 30_000 },
    { deliveryTimeoutMs: 1.5 },
  ])('rejects unsafe worker bounds (%#)', (options) => {
    const f = fixture();
    expect(() => new AuditOutboxService(f.store, f.sink, options)).toThrow(
      'invalid_audit_outbox_options',
    );
  });
});
