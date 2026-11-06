import { DomainError } from '../domain/errors.js';
import type { AuthenticatedPrincipal } from '../domain/principal.js';
import type { AuditEvent } from '../ports/audit-sink.js';
import type { Clock } from '../ports/clock.js';
import type { OperationalStateStore } from '../ports/operational-state-store.js';
import type {
  TelemetryObservation,
  TelemetrySink,
  TelemetryTagValue,
} from '../ports/telemetry-sink.js';

export type BrainReadAuditStore = Pick<
  OperationalStateStore,
  'enqueueAuditEvent'
>;

export type DeadlineOutcome<Value> =
  | { readonly kind: 'completed'; readonly value: Value }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'timed_out' };

export function cancelled(): DOMException {
  return new DOMException('Brain query cancelled', 'AbortError');
}

export function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}

export function assertAuthenticated(
  authenticated: AuthenticatedPrincipal,
): void {
  if (
    authenticated.principal.status !== 'active' ||
    authenticated.identity.principalId !== authenticated.principal.id
  ) {
    throw new DomainError('unauthenticated', false, {
      reason: 'identity_not_authorized',
    });
  }
}

export function validateProviderTimeout(milliseconds: number): void {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 60_000
  ) {
    throw new TypeError('invalid_brain_query_options');
  }
}

export async function enqueueReadAudit(
  store: BrainReadAuditStore,
  event: AuditEvent,
): Promise<void> {
  try {
    await store.enqueueAuditEvent(event);
  } catch {
    throw new DomainError('provider_unavailable', true, {
      reason: 'audit_state_unavailable',
    });
  }
}

/** Telemetry cannot change authorization or the client-visible read outcome. */
export function observeTelemetry(
  sink: TelemetrySink | undefined,
  observation: TelemetryObservation,
): void {
  if (sink === undefined) return;
  try {
    void Promise.resolve(sink.observe(observation)).catch(() => undefined);
  } catch {
    // The read path remains governed by authorization and durable audit state.
  }
}

export function readTimerStart(clock: Clock | undefined): number | undefined {
  if (clock === undefined) return undefined;
  try {
    const value = clock.now().getTime();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function observeDuration(
  sink: TelemetrySink | undefined,
  clock: Clock | undefined,
  name: 'request.duration' | 'provider.duration',
  startedAt: number | undefined,
  tags: Readonly<Record<string, TelemetryTagValue>>,
): void {
  const finishedAt = readTimerStart(clock);
  if (startedAt === undefined || finishedAt === undefined) return;
  observeTelemetry(sink, {
    kind: 'duration',
    name,
    milliseconds: Math.max(0, finishedAt - startedAt),
    tags,
  });
}

/** Settles at the local deadline even when an adapter ignores cancellation. */
export async function runWithDeadline<Value>(
  call: (signal: AbortSignal) => Promise<Value>,
  externalSignal: AbortSignal,
  timeoutMilliseconds: number,
): Promise<DeadlineOutcome<Value>> {
  const controller = new AbortController();
  let rejectCancellation: (reason: DOMException) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const onAbort = (): void => {
    controller.abort(cancelled());
    rejectCancellation(cancelled());
  };
  externalSignal.addEventListener('abort', onAbort, { once: true });
  if (externalSignal.aborted) onAbort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DeadlineOutcome<Value>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: 'timed_out' });
      controller.abort(
        new DOMException('Provider deadline exceeded', 'TimeoutError'),
      );
    }, timeoutMilliseconds);
  });
  const pending = Promise.resolve()
    .then(() => call(controller.signal))
    .then<DeadlineOutcome<Value>, DeadlineOutcome<Value>>(
      (value) => ({ kind: 'completed', value }),
      (error: unknown) => ({ kind: 'failed', error }),
    );
  try {
    return await Promise.race([pending, timeout, cancellation]);
  } finally {
    clearTimeout(timer);
    externalSignal.removeEventListener('abort', onAbort);
  }
}
