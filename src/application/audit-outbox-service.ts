import { DomainError } from '../domain/errors.js';
import type { AuditEvent, AuditSink } from '../ports/audit-sink.js';
import type { OperationalStateStore } from '../ports/operational-state-store.js';

export type AuditOutboxStore = Pick<
  OperationalStateStore,
  'claimAuditEvent' | 'markAuditEventDelivered' | 'markAuditEventFailed'
>;

export interface AuditOutboxOptions {
  readonly batchSize: number;
  readonly baseRetryMs: number;
  readonly maximumRetryMs: number;
  readonly leaseMs: number;
  readonly deliveryTimeoutMs: number;
}

export interface AuditFlushResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
  readonly lostClaims: number;
}

/** Claims per pass; a full pass tells a scheduler that a backlog remains. */
export const defaultAuditBatchSize = 100;

const defaults: AuditOutboxOptions = {
  batchSize: defaultAuditBatchSize,
  baseRetryMs: 1_000,
  maximumRetryMs: 60_000,
  leaseMs: 30_000,
  deliveryTimeoutMs: 5_000,
};

function cancelled(): DOMException {
  return new DOMException('Audit delivery cancelled', 'AbortError');
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}

function unavailable(reason: string): DomainError {
  return new DomainError('provider_unavailable', true, { reason });
}

async function stateCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw unavailable('audit_state_unavailable');
  }
}

function boundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

/** A bounded delivery pass, not a scheduler or a public Brain operation. */
export class AuditOutboxService {
  private readonly options: AuditOutboxOptions;
  private flushing = false;
  private sinkPending = false;

  constructor(
    private readonly store: AuditOutboxStore,
    private readonly sink: AuditSink,
    options: Partial<AuditOutboxOptions> = {},
  ) {
    this.options = { ...defaults, ...options };
    const o = this.options;
    if (
      !boundedInteger(o.batchSize, 1_000) ||
      !boundedInteger(o.baseRetryMs, o.maximumRetryMs) ||
      !boundedInteger(o.maximumRetryMs, 3_600_000) ||
      !boundedInteger(o.leaseMs, 300_000) ||
      !boundedInteger(o.deliveryTimeoutMs, 60_000) ||
      o.deliveryTimeoutMs >= o.leaseMs
    ) {
      throw new TypeError('invalid_audit_outbox_options');
    }
  }

  async flush(signal: AbortSignal): Promise<AuditFlushResult> {
    assertActive(signal);
    // A sink that ignores cancellation must not accumulate overlapping sends.
    if (this.flushing || this.sinkPending)
      throw unavailable('audit_flush_in_progress');
    this.flushing = true;
    const result = { claimed: 0, delivered: 0, failed: 0, lostClaims: 0 };
    try {
      while (result.claimed < this.options.batchSize) {
        assertActive(signal);
        const record = await stateCall(() =>
          this.store.claimAuditEvent(this.options.leaseMs),
        );
        if (record === null) {
          assertActive(signal);
          break;
        }
        result.claimed++;
        try {
          assertActive(signal);
          await this.emitWithDeadline(record.event, signal);
          assertActive(signal);
        } catch (error) {
          const wasCancelled = signal.aborted;
          const timedOut =
            error instanceof DomainError &&
            error.details['reason'] === 'audit_sink_timeout';
          const code = wasCancelled
            ? 'audit_delivery_cancelled'
            : timedOut
              ? 'audit_sink_timeout'
              : 'audit_sink_unavailable';
          const delay = Math.min(
            this.options.maximumRetryMs,
            this.options.baseRetryMs *
              2 ** Math.min(Math.max(record.attempts - 1, 0), 30),
          );
          const deferred = await stateCall(() =>
            this.store.markAuditEventFailed(
              record.id,
              record.claimToken,
              code,
              delay,
            ),
          );
          if (deferred) result.failed++;
          else result.lostClaims++;
          if (wasCancelled) throw cancelled();
          if (timedOut) break;
          continue;
        }
        // Keep acknowledgement outside the sink catch. An uncertain database
        // acknowledgement is not a sink failure and must not rewrite its state.
        const acknowledged = await stateCall(() =>
          this.store.markAuditEventDelivered(record.id, record.claimToken),
        );
        if (acknowledged) result.delivered++;
        else result.lostClaims++;
      }
      return result;
    } finally {
      this.flushing = false;
    }
  }

  private emitWithDeadline(
    event: AuditEvent,
    signal: AbortSignal,
  ): Promise<void> {
    assertActive(signal);
    const controller = new AbortController();
    this.sinkPending = true;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (
        failure?: 'cancelled' | 'timeout' | 'unavailable',
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (failure === undefined) resolve();
        else if (failure === 'cancelled') reject(cancelled());
        else
          reject(
            unavailable(
              failure === 'timeout'
                ? 'audit_sink_timeout'
                : 'audit_sink_unavailable',
            ),
          );
      };
      const onAbort = (): void => {
        finish('cancelled');
        controller.abort(cancelled());
      };
      const timer = setTimeout(() => {
        finish('timeout');
        controller.abort(
          new DOMException('Audit delivery timed out', 'TimeoutError'),
        );
      }, this.options.deliveryTimeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        // Attach both handlers even after timeout/cancellation, so late failure
        // is consumed and can only release the local in-flight guard.
        void this.sink.emit(event, controller.signal).then(
          () => {
            this.sinkPending = false;
            finish();
          },
          () => {
            this.sinkPending = false;
            finish('unavailable');
          },
        );
      } catch {
        this.sinkPending = false;
        finish('unavailable');
      }
    });
  }
}
