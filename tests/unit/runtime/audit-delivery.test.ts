import { describe, expect, it } from 'vitest';

import type { AuditFlushResult } from '../../../src/application/audit-outbox-service.js';
import { DomainError } from '../../../src/domain/errors.js';
import {
  AuditDeliveryLoop,
  type DeliveryScheduler,
} from '../../../src/runtime/audit-delivery.js';

class ManualScheduler implements DeliveryScheduler {
  readonly pending: { readonly run: () => void; readonly ms: number }[] = [];

  schedule(run: () => void, ms: number): unknown {
    const entry = { run, ms };
    this.pending.push(entry);
    return entry;
  }

  cancel(handle: unknown): void {
    const index = this.pending.indexOf(handle as (typeof this.pending)[number]);
    if (index >= 0) this.pending.splice(index, 1);
  }

  async next(): Promise<number> {
    const entry = this.pending.shift();
    if (entry === undefined) throw new Error('nothing scheduled');
    entry.run();
    await new Promise((resolve) => setImmediate(resolve));
    return entry.ms;
  }
}

const result = (claimed: number): AuditFlushResult => ({
  claimed,
  delivered: claimed,
  failed: 0,
  lostClaims: 0,
});

function outbox(results: (AuditFlushResult | Error | 'hang')[]) {
  const signals: AbortSignal[] = [];
  return {
    signals,
    flush: (signal: AbortSignal) => {
      signals.push(signal);
      const next = results.shift() ?? result(0);
      if (next === 'hang') {
        return new Promise<AuditFlushResult>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('cancelled', 'AbortError'));
          });
        });
      }
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
}

describe('AuditDeliveryLoop', () => {
  it('delivers immediately, again at once while a backlog remains, then on the interval', async () => {
    const scheduler = new ManualScheduler();
    const service = outbox([result(10), result(3), result(0)]);
    const loop = new AuditDeliveryLoop(service, {
      batchSize: 10,
      intervalMs: 5_000,
      scheduler,
      log: () => undefined,
    });

    loop.start();
    expect(await scheduler.next()).toBe(0);
    expect(await scheduler.next()).toBe(0);
    expect(await scheduler.next()).toBe(5_000);
    expect(service.signals).toHaveLength(3);
    expect(scheduler.pending.map(({ ms }) => ms)).toEqual([5_000]);
    await loop.close();
  });

  it('logs a failed pass by its fixed reason only and keeps delivering', async () => {
    const scheduler = new ManualScheduler();
    const lines: string[] = [];
    const service = outbox([
      new DomainError('provider_unavailable', true, {
        reason: 'audit_state_unavailable',
      }),
      new Error('synthetic secret detail'),
      result(1),
    ]);
    const loop = new AuditDeliveryLoop(service, {
      batchSize: 10,
      intervalMs: 1_000,
      scheduler,
      log: (line) => lines.push(line),
    });

    loop.start();
    await scheduler.next();
    await scheduler.next();
    await scheduler.next();

    expect(lines).toEqual([
      '{"severity":"WARNING","msg":"audit_delivery_failed","reason":"audit_state_unavailable"}\n',
      '{"severity":"WARNING","msg":"audit_delivery_failed","reason":"unexpected_audit_delivery_failure"}\n',
    ]);
    expect(service.signals).toHaveLength(3);
    await loop.close();
  });

  it('stops claiming on close by aborting the pass in flight, then schedules nothing', async () => {
    const scheduler = new ManualScheduler();
    const service = outbox(['hang']);
    const loop = new AuditDeliveryLoop(service, {
      batchSize: 10,
      intervalMs: 1_000,
      scheduler,
      log: () => undefined,
    });

    loop.start();
    await scheduler.next();
    const closing = loop.close();
    await closing;
    await loop.close();

    expect(service.signals[0]?.aborted).toBe(true);
    expect(scheduler.pending).toEqual([]);
  });

  it('never starts a pass after close', async () => {
    const scheduler = new ManualScheduler();
    const service = outbox([]);
    const loop = new AuditDeliveryLoop(service, {
      batchSize: 10,
      intervalMs: 1_000,
      scheduler,
      log: () => undefined,
    });

    loop.start();
    await loop.close();

    expect(scheduler.pending).toEqual([]);
    expect(service.signals).toEqual([]);
  });

  it('backs off and logs counts only when a full pass defers its events', async () => {
    const scheduler = new ManualScheduler();
    const lines: string[] = [];
    const service = outbox([
      { claimed: 10, delivered: 0, failed: 9, lostClaims: 1 },
    ]);
    const loop = new AuditDeliveryLoop(service, {
      batchSize: 10,
      intervalMs: 1_000,
      scheduler,
      log: (line) => lines.push(line),
    });

    loop.start();
    await scheduler.next();

    expect(scheduler.pending.map(({ ms }) => ms)).toEqual([1_000]);
    expect(lines).toEqual([
      '{"severity":"WARNING","msg":"audit_delivery_deferred","failed":9,"lostClaims":1}\n',
    ]);
    await loop.close();
  });

  it('starts one loop only, even when started again during a pass', async () => {
    const scheduler = new ManualScheduler();
    const service = outbox(['hang']);
    const loop = new AuditDeliveryLoop(service, {
      batchSize: 10,
      intervalMs: 1_000,
      scheduler,
      log: () => undefined,
    });

    loop.start();
    await scheduler.next();
    loop.start();

    expect(scheduler.pending).toEqual([]);
    await loop.close();
    expect(service.signals).toHaveLength(1);
  });

  it('waits on close for a pass that ignores cancellation', async () => {
    const scheduler = new ManualScheduler();
    let settle: (value: AuditFlushResult) => void = () => undefined;
    const loop = new AuditDeliveryLoop(
      {
        flush: () =>
          new Promise<AuditFlushResult>((resolve) => {
            settle = resolve;
          }),
      },
      { batchSize: 10, intervalMs: 1_000, scheduler, log: () => undefined },
    );

    loop.start();
    await scheduler.next();
    let closed = false;
    const closing = loop.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    settle(result(0));
    await closing;
    expect(closed).toBe(true);
    expect(scheduler.pending).toEqual([]);
  });

  it('keeps going and closes cleanly when logging itself fails', async () => {
    const scheduler = new ManualScheduler();
    const service = outbox([new Error('synthetic')]);
    const loop = new AuditDeliveryLoop(service, {
      batchSize: 10,
      intervalMs: 1_000,
      scheduler,
      log: () => {
        throw new Error('stderr closed');
      },
    });

    loop.start();
    await scheduler.next();

    expect(scheduler.pending.map(({ ms }) => ms)).toEqual([1_000]);
    await expect(loop.close()).resolves.toBeUndefined();
  });

  it('survives a flush that throws synchronously', async () => {
    const scheduler = new ManualScheduler();
    const lines: string[] = [];
    const loop = new AuditDeliveryLoop(
      {
        flush: () => {
          throw new Error('synthetic');
        },
      },
      {
        batchSize: 10,
        intervalMs: 1_000,
        scheduler,
        log: (line) => lines.push(line),
      },
    );

    loop.start();
    await scheduler.next();

    expect(lines).toHaveLength(1);
    expect(scheduler.pending.map(({ ms }) => ms)).toEqual([1_000]);
    await loop.close();
  });

  it('still logs a real failure that ends the pass during shutdown', async () => {
    const scheduler = new ManualScheduler();
    const lines: string[] = [];
    const loop = new AuditDeliveryLoop(
      {
        flush: (signal: AbortSignal) =>
          new Promise<AuditFlushResult>((_, reject) => {
            signal.addEventListener('abort', () => {
              reject(
                new DomainError('provider_unavailable', true, {
                  reason: 'audit_state_unavailable',
                }),
              );
            });
          }),
      },
      {
        batchSize: 10,
        intervalMs: 1_000,
        scheduler,
        log: (line) => lines.push(line),
      },
    );

    loop.start();
    await scheduler.next();
    await loop.close();

    expect(lines).toEqual([
      '{"severity":"WARNING","msg":"audit_delivery_failed","reason":"audit_state_unavailable"}\n',
    ]);
    expect(scheduler.pending).toEqual([]);
  });

  it.each([
    { intervalMs: 0 },
    { intervalMs: 600_001 },
    { batchSize: 0 },
    { intervalMs: 1.5 },
  ])('rejects invalid options %o', (options) => {
    expect(
      () =>
        new AuditDeliveryLoop(outbox([]), {
          batchSize: 10,
          intervalMs: 1_000,
          log: () => undefined,
          ...options,
        }),
    ).toThrow('invalid_audit_delivery_options');
  });
});
