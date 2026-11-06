import type { FastifyInstance } from 'fastify';

/** Something to release after the server stops, such as a database pool. */
export interface ClosableResource {
  readonly name: string;
  close(): Promise<void>;
}

/** The subset of `process` the server needs, injectable for tests. */
export interface SignalSource {
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  removeListener(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

export interface StartServerOptions {
  readonly port: number;
  /** Cloud Run requires all interfaces; tests bind to loopback. */
  readonly host?: string;
  /**
   * One deadline for the whole shutdown: draining gets three quarters of it
   * and the resources close in parallel within the rest. The default stays
   * under Cloud Run's ten-second grace period.
   */
  readonly shutdownTimeoutMs?: number;
  readonly resources?: readonly ClosableResource[];
  readonly signals?: SignalSource;
}

export interface ServerLifecycle {
  readonly url: string;
  /** Settles once shutdown has finished, however it was triggered. */
  readonly closed: Promise<void>;
  /** Idempotent graceful shutdown. */
  close(): Promise<void>;
}

const defaultShutdownTimeoutMs = 8_000;
const idleSweepMs = 25;

function invalidOptions(): TypeError {
  return new TypeError('invalid_server_options');
}

/** Resolves when `work` settles or the bound passes; never rejects. */
async function bounded(work: () => Promise<void>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timed_out');
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      work().then(
        () => 'closed' as const,
        () => 'failed' as const,
      ),
      expiry,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Listens and installs graceful shutdown: on SIGTERM or SIGINT (Cloud Run
 * sends SIGTERM), stop accepting requests, drain in-flight ones, then close
 * the resources, all within one deadline so shutdown cannot hang.
 */
export async function startServer(
  app: FastifyInstance,
  options: StartServerOptions,
): Promise<ServerLifecycle> {
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs;
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535 ||
    !Number.isInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs < 1 ||
    shutdownTimeoutMs > 120_000
  ) {
    throw invalidOptions();
  }
  const signals = options.signals ?? process;
  const resources = options.resources ?? [];

  const closeResources = async (deadline: number): Promise<void> => {
    const budget = Math.max(1, deadline - Date.now());
    await Promise.all(
      resources.map(async (resource) => {
        const outcome = await bounded(() => resource.close(), budget);
        if (outcome !== 'closed') {
          // Only the fixed resource name and outcome; never an error message.
          app.log.error(
            { resource: resource.name, outcome },
            'resource_close_incomplete',
          );
        }
      }),
    );
  };

  /**
   * Fastify closes only connections idle at the moment it starts closing. A
   * request in flight then leaves a keep-alive socket open after its response,
   * so idle connections are swept until the server closes; whatever remains at
   * the drain bound is destroyed so nothing outlives the shutdown.
   */
  const drain = async (budget: number): Promise<void> => {
    const sweep = setInterval(() => {
      app.server.closeIdleConnections();
    }, idleSweepMs);
    try {
      const outcome = await bounded(() => app.close(), budget);
      if (outcome !== 'closed') {
        app.server.closeAllConnections();
        app.log.error({ outcome }, 'server_drain_incomplete');
      }
    } finally {
      clearInterval(sweep);
    }
  };

  let settle: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let shutdown: Promise<void> | undefined;
  // Stays registered during shutdown so a repeated signal is absorbed rather
  // than falling back to the default handler and killing the drain.
  const onSignal = (): void => {
    void close();
  };
  const close = (): Promise<void> => {
    shutdown ??= (async () => {
      const deadline = Date.now() + shutdownTimeoutMs;
      await drain(Math.max(1, Math.floor(shutdownTimeoutMs * 0.75)));
      await closeResources(deadline);
      signals.removeListener('SIGTERM', onSignal);
      signals.removeListener('SIGINT', onSignal);
      app.log.info({}, 'server_stopped');
      settle();
    })();
    return shutdown;
  };

  let url: string;
  try {
    url = await app.listen({
      port: options.port,
      host: options.host ?? '0.0.0.0',
    });
  } catch (error) {
    await bounded(() => app.close(), shutdownTimeoutMs);
    await closeResources(Date.now() + shutdownTimeoutMs);
    throw error;
  }
  signals.on('SIGTERM', onSignal);
  signals.on('SIGINT', onSignal);
  return { url, closed, close };
}
