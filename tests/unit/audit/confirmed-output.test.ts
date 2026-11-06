import { getEventListeners } from 'node:events';
import { Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { CloudLoggingAuditSink } from '../../../src/adapters/audit/cloud-logging-audit-sink.js';
import { StreamJsonLineDestination } from '../../../src/adapters/logging/json-line-destination.js';
import { principalId, requestId } from '../../../src/domain/identifiers.js';
import type { AuditEvent } from '../../../src/ports/audit-sink.js';

const event: AuditEvent = {
  eventType: 'brain.operation.completed',
  requestId: requestId('req_synthetic_callback'),
  principalId: principalId('prn_synthetic_operator'),
  operation: 'fetch_record',
  outcome: 'COMPLETED',
  timestamp: new Date('2042-01-02T03:04:05.000Z'),
};

function controlledOutput() {
  const lines: string[] = [];
  let acknowledge: (error?: Error | null) => void = () => {
    throw new Error('synthetic_write_not_started');
  };
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      acknowledge = callback;
    },
  });
  const sink = new CloudLoggingAuditSink(new StreamJsonLineDestination(stream));
  return {
    stream,
    sink,
    lines,
    acknowledge: (error?: Error) => {
      acknowledge(error);
    },
  };
}

describe('confirmed audit output', () => {
  it('keeps delivery pending until the stream confirms the write', async () => {
    const output = controlledOutput();
    const signal = new AbortController().signal;
    let delivered = false;
    const delivery = output.sink.emit(event, signal).then(() => {
      delivered = true;
    });

    await setImmediate();
    expect(output.lines).toHaveLength(1);
    expect(output.stream.writableNeedDrain).toBe(true);
    expect(delivered).toBe(false);

    output.acknowledge();
    await delivery;
    expect(delivered).toBe(true);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    output.stream.destroy();
  });

  it('returns a safe error for asynchronous failure and absorbs the stream error event', async () => {
    const output = controlledOutput();
    const delivery = output.sink
      .emit(event, new AbortController().signal)
      .catch((error: unknown) => error);
    output.acknowledge(new Error('SYNTHETIC_PRIVATE_SINK_ERROR'));

    const error = await delivery;
    await setImmediate();
    expect(error).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'audit_sink_write_failed' },
    });
    expect(JSON.stringify(error)).not.toContain('SYNTHETIC_PRIVATE_SINK_ERROR');
    await expect(
      output.sink.emit(event, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('rejects a closed stream without marking delivery successful', async () => {
    const output = controlledOutput();
    const delivery = output.sink
      .emit(event, new AbortController().signal)
      .catch((error: unknown) => error);
    output.stream.destroy();
    await expect(delivery).resolves.toMatchObject({
      code: 'provider_unavailable',
    });
  });

  it('rejects concurrent output during backpressure so the caller can retain it for retry', async () => {
    const output = controlledOutput();
    const first = output.sink.emit(event, new AbortController().signal);
    await expect(
      output.sink.emit(event, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(output.lines).toHaveLength(1);
    output.acknowledge();
    await first;

    const retry = output.sink.emit(event, new AbortController().signal);
    output.acknowledge();
    await retry;
    expect(output.lines).toHaveLength(2);
    output.stream.destroy();
  });

  it('does not write an already cancelled event or disclose the abort reason', async () => {
    const output = controlledOutput();
    const controller = new AbortController();
    controller.abort(new Error('SYNTHETIC_ABORT_SECRET'));
    const error = await output.sink
      .emit(event, controller.signal)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(JSON.stringify(error)).not.toContain('SYNTHETIC_ABORT_SECRET');
    expect(output.lines).toEqual([]);
    output.stream.destroy();
  });

  it('cancels a pending caller without falsely acknowledging or destroying shared stdout', async () => {
    const output = controlledOutput();
    const controller = new AbortController();
    const delivery = output.sink
      .emit(event, controller.signal)
      .catch((error: unknown) => error);
    controller.abort(new Error('SYNTHETIC_ABORT_SECRET'));
    await expect(delivery).resolves.toMatchObject({ name: 'AbortError' });
    expect(output.stream.destroyed).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

    // Cancellation cannot retract bytes already handed to stdout. Keep bounded
    // backpressure until its callback settles; late failures must be absorbed.
    await expect(
      output.sink.emit(event, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    output.acknowledge(new Error('SYNTHETIC_LATE_WRITE_ERROR'));
    await setImmediate();
  });

  it.each([
    { clientId: { token: 'SYNTHETIC_NESTED_SECRET' } },
    { providerRecordId: { toJSON: () => 'SYNTHETIC_JSON_SECRET' } },
    { timestamp: new Date('invalid') },
    { operation: 'raw_provider_method' },
  ])(
    'rejects invalid metadata values before serializing them (%#)',
    async (override) => {
      const output = controlledOutput();
      const error = await output.sink
        .emit(
          { ...event, ...override } as AuditEvent,
          new AbortController().signal,
        )
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: 'invalid_request',
        details: { reason: 'invalid_audit_event' },
      });
      expect(JSON.stringify(error)).not.toMatch(
        /SYNTHETIC_NESTED_SECRET|SYNTHETIC_JSON_SECRET/u,
      );
      expect(output.lines).toEqual([]);
      output.stream.destroy();
    },
  );
});
