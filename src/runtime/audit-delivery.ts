import type { AuditOutboxService } from '../application/audit-outbox-service.js';
import { DomainError } from '../domain/errors.js';

export interface DeliveryScheduler {
  schedule(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

export interface AuditDeliveryLoopOptions {
  /** The outbox service's batch size; a full batch means a backlog remains. */
  readonly batchSize: number;
  /** Pause between passes when the outbox is drained. */
  readonly intervalMs: number;
  readonly log: (line: string) => void;
  readonly scheduler?: DeliveryScheduler;
}

const timers: DeliveryScheduler = {
  schedule: (run, ms) => setTimeout(run, ms),
  cancel: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};
const safeReason = /^[a-z][a-z0-9_]{0,95}$/u;

function failureLine(error: unknown): string {
  const reason: unknown =
    error instanceof DomainError ? error.details['reason'] : undefined;
  return `${JSON.stringify({
    severity: 'WARNING',
    msg: 'audit_delivery_failed',
    reason:
      typeof reason === 'string' && safeReason.test(reason)
        ? reason
        : 'unexpected_audit_delivery_failure',
  })}\n`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Runs bounded audit outbox delivery passes in the gateway process: at once
 * while a backlog remains, otherwise on an interval. A failed pass is logged by
 * its fixed reason and retried on the next interval, as is a pass that deferred
 * events (logged by count), so a failing sink never drives back-to-back passes.
 * Closing stops scheduling
 * and aborts the pass in flight; the event being delivered is marked for retry,
 * so nothing is lost and the next process delivers it.
 */
export class AuditDeliveryLoop {
  readonly #outbox: Pick<AuditOutboxService, 'flush'>;
  readonly #batchSize: number;
  readonly #intervalMs: number;
  readonly #log: (line: string) => void;
  readonly #scheduler: DeliveryScheduler;
  #handle: unknown;
  #controller: AbortController | undefined;
  #current: Promise<void> | undefined;
  #started = false;
  #closed = false;

  constructor(
    outbox: Pick<AuditOutboxService, 'flush'>,
    options: AuditDeliveryLoopOptions,
  ) {
    if (
      !Number.isSafeInteger(options.batchSize) ||
      options.batchSize < 1 ||
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 1 ||
      options.intervalMs > 600_000
    ) {
      throw new TypeError('invalid_audit_delivery_options');
    }
    this.#outbox = outbox;
    this.#batchSize = options.batchSize;
    this.#intervalMs = options.intervalMs;
    this.#log = options.log;
    this.#scheduler = options.scheduler ?? timers;
  }

  start(): void {
    if (this.#closed || this.#started) return;
    this.#started = true;
    this.#schedule(0);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#handle !== undefined) {
      this.#scheduler.cancel(this.#handle);
      this.#handle = undefined;
    }
    this.#controller?.abort();
    await this.#current;
  }

  #schedule(ms: number): void {
    if (this.#closed) return;
    this.#handle = this.#scheduler.schedule(() => {
      this.#handle = undefined;
      this.#tick();
    }, ms);
  }

  #tick(): void {
    if (this.#closed) return;
    const controller = new AbortController();
    this.#controller = controller;
    this.#current = Promise.resolve()
      .then(() => this.#outbox.flush(controller.signal))
      .then(
        (result) => {
          const deferred = result.failed > 0 || result.lostClaims > 0;
          if (deferred) {
            this.#write(
              `${JSON.stringify({
                severity: 'WARNING',
                msg: 'audit_delivery_deferred',
                failed: result.failed,
                lostClaims: result.lostClaims,
              })}\n`,
            );
          }
          this.#schedule(
            !deferred && result.claimed >= this.#batchSize
              ? 0
              : this.#intervalMs,
          );
        },
        (error: unknown) => {
          // A pass aborted by close is the expected way to stop.
          if (!(this.#closed && isAbort(error))) {
            this.#write(failureLine(error));
          }
          this.#schedule(this.#intervalMs);
        },
      )
      .catch(() => {
        // Scheduling must never surface as an unhandled rejection.
      });
  }

  #write(line: string): void {
    try {
      this.#log(line);
    } catch {
      // Diagnostics are best effort; delivery state lives in the outbox.
    }
  }
}
