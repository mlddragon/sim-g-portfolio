import { describe, expect, it } from 'vitest';

import { PassThrough } from 'node:stream';

import {
  BoundedTelemetryDestination,
  CloudLoggingTelemetrySink,
} from '../../../src/adapters/telemetry/cloud-logging-telemetry-sink.js';
import type { JsonLineDestination } from '../../../src/adapters/logging/json-line-destination.js';
import type { TelemetryObservation } from '../../../src/ports/telemetry-sink.js';

const now = new Date('2043-03-16T17:18:19.000Z');
const clock = { now: () => now };
const secret = 'Synthetic confidential query text';

class CapturingDestination implements JsonLineDestination {
  readonly lines: string[] = [];
  behaviour: 'ok' | 'reject' | 'throw' | 'hang' = 'ok';

  write(line: string, signal: AbortSignal): Promise<void> {
    if (this.behaviour === 'throw') throw new Error('synthetic sync failure');
    if (this.behaviour === 'reject') {
      return Promise.reject(new Error('synthetic destination closed'));
    }
    if (this.behaviour === 'hang') {
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    this.lines.push(line);
    return Promise.resolve();
  }

  parsed(): Record<string, unknown>[] {
    return this.lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
  }
}

function sink(destination = new CapturingDestination(), timeoutMs = 50) {
  return {
    destination,
    telemetry: new CloudLoggingTelemetrySink(destination, clock, timeoutMs),
  };
}

describe('CloudLoggingTelemetrySink', () => {
  it('writes counters, durations and gauges as one structured line each', async () => {
    const { destination, telemetry } = sink();

    await telemetry.observe({
      kind: 'counter',
      name: 'request.total',
      value: 1,
      tags: { operation: 'search_brain', outcome: 'partial' },
    });
    await telemetry.observe({
      kind: 'duration',
      name: 'provider.duration',
      milliseconds: 12.5,
      tags: { provider: 'drive', unit: 'milliseconds' },
    });
    await telemetry.observe({
      kind: 'gauge',
      name: 'approval.pending_count',
      value: 3,
    });

    expect(destination.lines.every((line) => line.endsWith('\n'))).toBe(true);
    expect(destination.parsed()).toEqual([
      {
        severity: 'INFO',
        logType: 'family_brain_telemetry',
        kind: 'counter',
        metric: 'request.total',
        value: 1,
        labels: { operation: 'search_brain', outcome: 'partial' },
        timestamp: now.toISOString(),
      },
      {
        severity: 'INFO',
        logType: 'family_brain_telemetry',
        kind: 'duration',
        metric: 'provider.duration',
        milliseconds: 12.5,
        labels: { provider: 'drive', unit: 'milliseconds' },
        timestamp: now.toISOString(),
      },
      {
        severity: 'INFO',
        logType: 'family_brain_telemetry',
        kind: 'gauge',
        metric: 'approval.pending_count',
        value: 3,
        labels: {},
        timestamp: now.toISOString(),
      },
    ]);
  });

  it('keeps only allowlisted label keys and values', async () => {
    const { destination, telemetry } = sink();

    await telemetry.observe({
      kind: 'counter',
      name: 'error.total',
      value: 1,
      tags: {
        operation: 'raw_provider_proxy',
        code: 'unauthorized',
        provider: 'dropbox',
        query: secret,
        principalId: 'prn_operator',
        outcome: secret,
      },
    });

    expect(destination.parsed()[0]?.['labels']).toEqual({
      code: 'unauthorized',
    });
    expect(destination.lines.join('')).not.toContain(secret);
    expect(destination.lines.join('')).not.toContain('prn_operator');
  });

  it.each([
    ['an unknown metric', { kind: 'counter', name: 'query.text', value: 1 }],
    ['an unknown kind', { kind: 'histogram', name: 'request.total', value: 1 }],
    [
      'a non-finite value',
      { kind: 'gauge', name: 'approval.oldest_age', value: Number.NaN },
    ],
    [
      'a negative counter',
      { kind: 'counter', name: 'request.total', value: -1 },
    ],
    [
      'a negative duration',
      { kind: 'duration', name: 'request.duration', milliseconds: -5 },
    ],
    [
      'a non-plain tag object',
      {
        kind: 'counter',
        name: 'request.total',
        value: 1,
        tags: new Map([['operation', 'search_brain']]),
      },
    ],
    ['a null observation', null],
  ])('drops %s without throwing', async (_, observation) => {
    const { destination, telemetry } = sink();

    await expect(
      telemetry.observe(observation as unknown as TelemetryObservation),
    ).resolves.toBeUndefined();
    expect(destination.lines).toEqual([]);
  });

  it('never invokes a getter on the observation tags', async () => {
    const { destination, telemetry } = sink();
    let invoked = false;
    const tags = {};
    Object.defineProperty(tags, 'operation', {
      enumerable: true,
      get: () => {
        invoked = true;
        return 'search_brain';
      },
    });

    await telemetry.observe({
      kind: 'counter',
      name: 'request.total',
      value: 1,
      tags,
    });

    expect(invoked).toBe(false);
    expect(destination.parsed()[0]?.['labels']).toEqual({});
  });

  it.each(['reject', 'throw', 'hang'] as const)(
    'never fails or blocks the caller when the destination does %s',
    async (behaviour) => {
      const destination = new CapturingDestination();
      destination.behaviour = behaviour;
      const { telemetry } = sink(destination, 20);

      await expect(
        telemetry.observe({ kind: 'counter', name: 'request.total', value: 1 }),
      ).resolves.toBeUndefined();
    },
  );

  it('never throws when the clock fails', async () => {
    const destination = new CapturingDestination();
    const telemetry = new CloudLoggingTelemetrySink(
      destination,
      {
        now: () => {
          throw new Error('synthetic clock failure');
        },
      },
      20,
    );

    await expect(
      telemetry.observe({ kind: 'counter', name: 'request.total', value: 1 }),
    ).resolves.toBeUndefined();
    expect(destination.lines).toEqual([]);
  });

  it('writes every observation of a same-tick burst to a real stream', async () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    const telemetry = new CloudLoggingTelemetrySink(
      new BoundedTelemetryDestination(stream),
      clock,
    );

    await Promise.all([
      telemetry.observe({ kind: 'counter', name: 'request.total', value: 1 }),
      telemetry.observe({
        kind: 'duration',
        name: 'request.duration',
        milliseconds: 3,
      }),
      telemetry.observe({ kind: 'counter', name: 'search.partial', value: 1 }),
      telemetry.observe({
        kind: 'counter',
        name: 'provider.timeout',
        value: 1,
        tags: { provider: 'github' },
      }),
    ]);

    const lines = chunks.join('').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line) as { metric: string })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: 'request.total' }),
        expect.objectContaining({ metric: 'request.duration' }),
        expect.objectContaining({ metric: 'search.partial' }),
        expect.objectContaining({ metric: 'provider.timeout' }),
      ]),
    );
    expect(lines).toHaveLength(4);
  });

  it('drops instead of queueing once the bounded in-flight limit is reached', async () => {
    // No reader: accepted writes stay in flight until their timeout aborts them.
    const stream = new PassThrough({ highWaterMark: 1 });
    const destination = new BoundedTelemetryDestination(stream, 2);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        destination.write('{"synthetic":true}\n', AbortSignal.timeout(30)),
      ),
    );

    const dropped = results.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof Error &&
        result.reason.message === 'telemetry_dropped',
    );
    expect(dropped.length).toBeGreaterThanOrEqual(3);
    const telemetry = new CloudLoggingTelemetrySink(destination, clock, 30);
    await expect(
      telemetry.observe({ kind: 'counter', name: 'request.total', value: 1 }),
    ).resolves.toBeUndefined();
  });

  it('settles a hung write within the configured timeout', async () => {
    const destination = new CapturingDestination();
    destination.behaviour = 'hang';
    const { telemetry } = sink(destination, 20);
    const started = Date.now();

    await telemetry.observe({
      kind: 'counter',
      name: 'request.total',
      value: 1,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('drops an observation whose proxy traps throw', async () => {
    const { destination, telemetry } = sink();
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('synthetic trap');
        },
        getOwnPropertyDescriptor: () => {
          throw new Error('synthetic trap');
        },
      },
    );

    await expect(
      telemetry.observe(hostile as unknown as TelemetryObservation),
    ).resolves.toBeUndefined();
    await expect(
      telemetry.observe({
        kind: 'counter',
        name: 'request.total',
        value: 1,
        tags: hostile as unknown as Record<string, string>,
      }),
    ).resolves.toBeUndefined();
    expect(destination.lines).toEqual([]);
  });
});
