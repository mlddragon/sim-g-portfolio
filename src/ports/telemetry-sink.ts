export const telemetryMetricNames = [
  'request.total',
  'request.duration',
  'authentication.duration',
  'policy.duration',
  'routing.duration',
  'provider.duration',
  'provider.timeout',
  'search.partial',
  'error.total',
  'database.duration',
  'approval.pending_count',
  'approval.oldest_age',
] as const;

export type TelemetryMetricName = (typeof telemetryMetricNames)[number];
export type TelemetryTagValue = boolean | number | string;

export type TelemetryObservation =
  | {
      readonly kind: 'counter';
      readonly name: TelemetryMetricName;
      readonly value: number;
      readonly tags?: Readonly<Record<string, TelemetryTagValue>>;
    }
  | {
      readonly kind: 'duration';
      readonly name: TelemetryMetricName;
      readonly milliseconds: number;
      readonly tags?: Readonly<Record<string, TelemetryTagValue>>;
    }
  | {
      readonly kind: 'gauge';
      readonly name: TelemetryMetricName;
      readonly value: number;
      readonly tags?: Readonly<Record<string, TelemetryTagValue>>;
    };

export interface TelemetrySink {
  observe(observation: TelemetryObservation): void | Promise<void>;
}
