import type { Writable } from 'node:stream';

import { DomainError } from '../../domain/errors.js';

export interface JsonLineDestination {
  write(line: string, signal: AbortSignal): void | Promise<void>;
}

export function outputAborted(): DOMException {
  return new DOMException('Log output cancelled', 'AbortError');
}

function assertOutputActive(signal: AbortSignal): void {
  if (signal.aborted) throw outputAborted();
}

function outputUnavailable(): DomainError {
  return new DomainError('provider_unavailable', true, {
    reason: 'log_destination_unavailable',
  });
}

/** One process-lifetime destination per stream, with at most one pending write. */
export class StreamJsonLineDestination implements JsonLineDestination {
  private writing = false;
  private unusable = false;
  private failPending: (() => void) | undefined;

  private readonly markUnusable = (): void => {
    this.unusable = true;
    this.writing = false;
    this.failPending?.();
    this.failPending = undefined;
  };

  constructor(private readonly stream: Writable) {
    // Node invokes the write callback before emitting 'error'. Keep a listener
    // for the lifetime of the stream so late failures are handled as well.
    stream.on('error', this.markUnusable);
    stream.once('close', () => {
      this.markUnusable();
      stream.removeListener('error', this.markUnusable);
    });
  }

  write(line: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(outputAborted());
    if (
      this.unusable ||
      this.writing ||
      !this.stream.writable ||
      this.stream.destroyed
    ) {
      return Promise.reject(outputUnavailable());
    }
    this.writing = true;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const abort = (): void => {
        // Bytes already submitted cannot be retracted. Do not close shared
        // stdout or allow more buffered writes until its callback settles.
        finish(outputAborted());
      };
      this.failPending = () => {
        finish(outputUnavailable());
      };
      signal.addEventListener('abort', abort, { once: true });

      try {
        this.stream.write(line, 'utf8', (error) => {
          if (error !== undefined && error !== null) {
            this.markUnusable();
            return;
          }
          this.writing = false;
          this.failPending = undefined;
          finish();
        });
      } catch {
        this.markUnusable();
      }
    });
  }
}

// Shared across sink instances: no per-request listener growth or write queue.
export const standardOutputDestination = new StreamJsonLineDestination(
  process.stdout,
);

export async function writeJsonLine(
  destination: JsonLineDestination,
  value: Readonly<Record<string, unknown>>,
  safeFailureReason: string,
  signal: AbortSignal,
): Promise<void> {
  assertOutputActive(signal);
  try {
    await destination.write(`${JSON.stringify(value)}\n`, signal);
    assertOutputActive(signal);
  } catch {
    if (signal.aborted) throw outputAborted();
    throw new DomainError('provider_unavailable', true, {
      reason: safeFailureReason,
    });
  }
}
