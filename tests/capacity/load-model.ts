/**
 * Pure pieces of the synthetic capacity load generator: workload selection,
 * latency statistics and Google-shaped synthetic ID token claims. Nothing here
 * performs I/O, so it is unit tested directly.
 */

export type CapacityOperation =
  'search_brain' | 'fetch_record' | 'persist_knowledge' | 'list_approvals';

export type OperationMix = Partial<Record<CapacityOperation, number>>;

export interface Sample {
  readonly operation: CapacityOperation;
  /** HTTP status, or 0 for a transport failure or timeout. */
  readonly status: number;
  readonly milliseconds: number;
  /** The gateway's fixed error reason, when it returned one. */
  readonly reason?: string;
}

export interface LatencySummary {
  readonly requests: number;
  readonly errors: number;
  readonly errorRate: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface OperationSummary extends LatencySummary {
  readonly statuses: Readonly<Record<string, number>>;
  readonly reasons: Readonly<Record<string, number>>;
}

export interface SampleSummary {
  readonly total: LatencySummary & { readonly requestsPerSecond: number };
  readonly byOperation: Readonly<Record<string, OperationSummary>>;
}

/** Nearest-rank percentile; NaN for no values. */
export function percentile(values: readonly number[], rank: number): number {
  if (!Number.isFinite(rank) || rank < 0 || rank > 100) {
    throw new TypeError('invalid_percentile');
  }
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)] ?? Number.NaN;
}

/** A response is an error unless it is a 2xx. */
function isError(status: number): boolean {
  return status < 200 || status >= 300;
}

function latency(samples: readonly Sample[]): LatencySummary {
  const milliseconds = samples.map((sample) => sample.milliseconds);
  const errors = samples.filter((sample) => isError(sample.status)).length;
  return {
    requests: samples.length,
    errors,
    errorRate: samples.length === 0 ? 0 : errors / samples.length,
    p50: percentile(milliseconds, 50),
    p95: percentile(milliseconds, 95),
    p99: percentile(milliseconds, 99),
    // A loop, not Math.max(...values): large runs exceed the argument limit.
    max:
      milliseconds.length === 0
        ? Number.NaN
        : milliseconds.reduce(
            (peak, value) => (value > peak ? value : peak),
            Number.NEGATIVE_INFINITY,
          ),
  };
}

export function summarizeSamples(
  samples: readonly Sample[],
  elapsedMilliseconds: number,
): SampleSummary {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const group = groups.get(sample.operation) ?? [];
    group.push(sample);
    groups.set(sample.operation, group);
  }
  const byOperation: Record<string, OperationSummary> = {};
  for (const [operation, group] of groups) {
    const statuses: Record<string, number> = {};
    const reasons: Record<string, number> = {};
    for (const sample of group) {
      const key = String(sample.status);
      statuses[key] = (statuses[key] ?? 0) + 1;
      if (sample.reason !== undefined) {
        reasons[sample.reason] = (reasons[sample.reason] ?? 0) + 1;
      }
    }
    byOperation[operation] = { ...latency(group), statuses, reasons };
  }
  return {
    total: {
      ...latency(samples),
      requestsPerSecond:
        elapsedMilliseconds > 0
          ? samples.length / (elapsedMilliseconds / 1_000)
          : 0,
    },
    byOperation,
  };
}

/** Picks by cumulative weight; `random` returns a value in [0, 1). */
export function pickOperation(
  mix: OperationMix,
  random: () => number,
): CapacityOperation {
  const entries = (
    Object.entries(mix) as [CapacityOperation, number | undefined][]
  ).filter(
    (entry): entry is [CapacityOperation, number] =>
      typeof entry[1] === 'number' && entry[1] > 0,
  );
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (entries.length === 0 || !Number.isFinite(total)) {
    throw new TypeError('invalid_operation_mix');
  }
  let threshold = random() * total;
  for (const [operation, weight] of entries) {
    if (threshold < weight) return operation;
    threshold -= weight;
  }
  return entries[entries.length - 1]?.[0] ?? 'search_brain';
}

export interface SyntheticIdentity {
  readonly subject: string;
  readonly email: string;
  readonly audience: string;
  readonly hostedDomain: string;
  readonly issuedAt: number;
  readonly lifetimeSeconds: number;
}

const syntheticDomain = 'example.invalid';

/**
 * Claims for a synthetic Google Workspace ID token. Only the reserved
 * `example.invalid` domain is accepted, so a real identity can never be
 * minted by the capacity harness.
 */
export function syntheticGoogleClaims(identity: SyntheticIdentity) {
  if (
    identity.hostedDomain !== syntheticDomain ||
    !identity.email.endsWith(`@${syntheticDomain}`) ||
    !identity.subject.startsWith('synthetic-')
  ) {
    throw new TypeError('synthetic_identity_required');
  }
  return {
    iss: 'https://accounts.google.com',
    sub: identity.subject,
    aud: identity.audience,
    azp: identity.audience,
    email: identity.email,
    email_verified: true,
    hd: identity.hostedDomain,
    iat: identity.issuedAt,
    exp: identity.issuedAt + identity.lifetimeSeconds,
  };
}
