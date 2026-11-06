import { domainErrorCodes } from '../../domain/errors.js';
import { brainOperationNames } from '../../domain/operations.js';
import { knowledgeProviderNames } from '../../domain/records.js';
import type { Clock } from '../../ports/clock.js';
import {
  telemetryMetricNames,
  type TelemetryObservation,
  type TelemetrySink,
} from '../../ports/telemetry-sink.js';
import type { Writable } from 'node:stream';

import {
  outputAborted,
  writeJsonLine,
  type JsonLineDestination,
} from '../logging/json-line-destination.js';

/**
 * Closed label vocabulary. Anything outside it is dropped rather than written,
 * so free text, identifiers or content can never reach telemetry output.
 */
const allowedLabels: Readonly<Record<string, ReadonlySet<string>>> = {
  operation: new Set<string>([
    ...brainOperationNames,
    'approval_projection_create',
    'approval_projection_update',
  ]),
  outcome: new Set(['complete', 'partial', 'denied', 'cancelled', 'failed']),
  code: new Set<string>([...domainErrorCodes, 'read_failed']),
  provider: new Set<string>(knowledgeProviderNames),
  unit: new Set(['milliseconds']),
};
const metricNames = new Set<string>(telemetryMetricNames);
const kinds = new Set(['counter', 'duration', 'gauge']);
const defaultWriteTimeoutMs = 1_000;

const defaultMaxInFlight = 16;

function telemetryDropped(): Error {
  return new Error('telemetry_dropped');
}

/**
 * Best-effort telemetry output: several writes may be in flight so a same-tick
 * burst is kept, but it drops instead of queueing once the stream needs to
 * drain or the bound is reached. Audit output keeps its own strictly
 * one-pending-write destination.
 */
export class BoundedTelemetryDestination implements JsonLineDestination {
  private inFlight = 0;
  private unusable = false;

  constructor(
    private readonly stream: Writable,
    private readonly maxInFlight = defaultMaxInFlight,
  ) {
    const markUnusable = (): void => {
      this.unusable = true;
    };
    stream.on('error', markUnusable);
    stream.once('close', () => {
      markUnusable();
      stream.removeListener('error', markUnusable);
    });
  }

  write(line: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(outputAborted());
    if (
      this.unusable ||
      this.inFlight >= this.maxInFlight ||
      this.stream.writableNeedDrain ||
      !this.stream.writable ||
      this.stream.destroyed
    ) {
      return Promise.reject(telemetryDropped());
    }
    this.inFlight += 1;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const abort = (): void => {
        // The in-flight slot is released only by the stream callback.
        settle(outputAborted());
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        this.stream.write(line, 'utf8', (error) => {
          this.inFlight -= 1;
          if (error !== undefined && error !== null) {
            this.unusable = true;
            settle(telemetryDropped());
            return;
          }
          settle();
        });
      } catch {
        this.inFlight -= 1;
        this.unusable = true;
        settle(telemetryDropped());
      }
    });
  }
}

// Separate from the audit destination so best-effort telemetry never occupies
// the audit stream's single pending write.
const telemetryOutputDestination = new BoundedTelemetryDestination(
  process.stdout,
);

function ownDataValue(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    ? (descriptor.value as unknown)
    : undefined;
}

function safeLabels(tags: unknown): Record<string, string> | undefined {
  if (tags === undefined) return {};
  if (
    typeof tags !== 'object' ||
    tags === null ||
    Object.getPrototypeOf(tags) !== Object.prototype
  ) {
    return undefined;
  }
  const labels: Record<string, string> = {};
  for (const [key, allowed] of Object.entries(allowedLabels)) {
    // Read data properties only; a getter is never invoked.
    const value = ownDataValue(tags, key);
    if (typeof value === 'string' && allowed.has(value)) labels[key] = value;
  }
  return labels;
}

/** Snapshot and validate an observation; undefined means drop it. */
function normalize(
  observation: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof observation !== 'object' || observation === null) return undefined;
  const kind = ownDataValue(observation, 'kind');
  const name = ownDataValue(observation, 'name');
  if (
    typeof kind !== 'string' ||
    !kinds.has(kind) ||
    typeof name !== 'string' ||
    !metricNames.has(name)
  ) {
    return undefined;
  }
  const field = kind === 'duration' ? 'milliseconds' : 'value';
  const amount = ownDataValue(observation, field);
  if (
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    (kind !== 'gauge' && amount < 0)
  ) {
    return undefined;
  }
  const labels = safeLabels(ownDataValue(observation, 'tags'));
  if (labels === undefined) return undefined;
  return { kind, metric: name, [field]: amount, labels };
}

/**
 * Cloud Logging structured-stdout telemetry. Strictly best-effort: it never
 * throws, never blocks longer than its write timeout, and drops anything that
 * fails validation instead of writing it.
 */
export class CloudLoggingTelemetrySink implements TelemetrySink {
  constructor(
    private readonly destination: JsonLineDestination = telemetryOutputDestination,
    private readonly clock: Clock = { now: () => new Date() },
    private readonly writeTimeoutMs = defaultWriteTimeoutMs,
  ) {}

  async observe(observation: TelemetryObservation): Promise<void> {
    try {
      const normalized = normalize(observation);
      if (normalized === undefined) return;
      const timestamp = Date.prototype.toISOString.call(this.clock.now());
      await writeJsonLine(
        this.destination,
        {
          severity: 'INFO',
          logType: 'family_brain_telemetry',
          ...normalized,
          timestamp,
        },
        'telemetry_sink_write_failed',
        AbortSignal.timeout(this.writeTimeoutMs),
      );
    } catch {
      // Telemetry can never change an operation's outcome.
    }
  }
}
