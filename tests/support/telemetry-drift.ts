import { expect } from 'vitest';

import { CloudLoggingTelemetrySink } from '../../src/adapters/telemetry/cloud-logging-telemetry-sink.js';
import type { TelemetryObservation } from '../../src/ports/telemetry-sink.js';

/**
 * Every tag a service really emits must survive the telemetry adapter's closed
 * vocabulary; a silently dropped label is drift and fails here.
 */
export async function expectTelemetrySurvivesAdapter(
  observations: readonly TelemetryObservation[],
): Promise<void> {
  expect(observations.length).toBeGreaterThan(0);
  for (const observation of observations) {
    const lines: string[] = [];
    const sink = new CloudLoggingTelemetrySink(
      {
        write: (line) => {
          lines.push(line);
          return Promise.resolve();
        },
      },
      { now: () => new Date('2043-01-01T00:00:00.000Z') },
    );
    await sink.observe(observation);
    expect(lines, JSON.stringify(observation)).toHaveLength(1);
    const written = JSON.parse(lines[0] ?? '{}') as { labels?: unknown };
    expect(written.labels, JSON.stringify(observation)).toEqual(
      observation.tags ?? {},
    );
  }
}
