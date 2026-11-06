import { EventEmitter } from 'node:events';
import { Agent, request as httpRequest } from 'node:http';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/api/build-app.js';
import { startServer, type ServerLifecycle } from '../../src/server.js';
import type { RequestContext } from '../../src/domain/request-context.js';
import { brainReadPrincipal } from '../support/brain-read-fixtures.js';

const started: ServerLifecycle[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.close()));
});

async function app() {
  return buildApp(
    {
      authentication: {
        authenticate: () => Promise.reject(new Error('unused')),
      },
      operations: {} as never,
      clock: { now: () => new Date('2046-01-01T00:00:00.000Z') },
    },
    { logStream: new PassThrough() },
  );
}

class FakeProcess extends EventEmitter {}

/** An app whose search takes `delayMs`, for in-flight shutdown tests. */
async function slowApp(delayMs: number) {
  return buildApp(
    {
      authentication: {
        authenticate: () => Promise.resolve(brainReadPrincipal()),
      },
      operations: {
        searchBrain: (_authenticated: unknown, context: RequestContext) =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                requestId: context.requestId,
                results: [],
                completeness: { complete: true, providers: [] },
              });
            }, delayMs);
          }),
      } as never,
      clock: { now: () => new Date('2046-01-01T00:00:00.000Z') },
    },
    { logStream: new PassThrough() },
  );
}

function keepAliveSearch(url: string, agent: Agent) {
  return new Promise<{ status: number; connection: string | undefined }>(
    (resolve, reject) => {
      const outgoing = httpRequest(
        `${url}/v1/operations/search_brain`,
        {
          method: 'POST',
          agent,
          headers: {
            authorization: 'Bearer synthetic.token',
            'content-type': 'application/json',
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              connection: response.headers.connection,
            });
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end('{"query":"q","limit":1}');
    },
  );
}

describe('startServer', () => {
  it('listens and serves liveness over real HTTP', async () => {
    const server = await startServer(await app(), {
      port: 0,
      host: '127.0.0.1',
      signals: new FakeProcess(),
    });
    started.push(server);

    const response = await fetch(`${server.url}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('drains and closes the app and every resource once on SIGTERM', async () => {
    const signals = new FakeProcess();
    const closed: string[] = [];
    const server = await startServer(await app(), {
      port: 0,
      host: '127.0.0.1',
      signals,
      resources: [
        {
          name: 'database',
          close: () => {
            closed.push('database');
            return Promise.resolve();
          },
        },
      ],
    });

    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    await server.closed;
    await server.close();

    expect(closed).toEqual(['database']);
    await expect(fetch(`${server.url}/healthz`)).rejects.toThrow();
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('drains an in-flight keep-alive request promptly instead of waiting out the timeout', async () => {
    const signals = new FakeProcess();
    const agent = new Agent({ keepAlive: true });
    const server = await startServer(await slowApp(200), {
      port: 0,
      host: '127.0.0.1',
      signals,
      shutdownTimeoutMs: 5_000,
    });
    const startedAt = Date.now();

    const pending = keepAliveSearch(server.url, agent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    signals.emit('SIGTERM');
    const response = await pending;
    await server.closed;
    agent.destroy();

    expect(response.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('absorbs a second signal while draining rather than leaving the default handler', async () => {
    const signals = new FakeProcess();
    const agent = new Agent({ keepAlive: true });
    const server = await startServer(await slowApp(150), {
      port: 0,
      host: '127.0.0.1',
      signals,
    });

    const pending = keepAliveSearch(server.url, agent);
    await new Promise((resolve) => setTimeout(resolve, 30));
    signals.emit('SIGTERM');
    expect(signals.listenerCount('SIGTERM')).toBeGreaterThan(0);
    expect(signals.listenerCount('SIGINT')).toBeGreaterThan(0);
    signals.emit('SIGINT');
    await pending;
    await server.closed;
    agent.destroy();

    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('keeps the whole shutdown within one deadline', async () => {
    const server = await startServer(await app(), {
      port: 0,
      host: '127.0.0.1',
      signals: new FakeProcess(),
      shutdownTimeoutMs: 200,
      resources: [1, 2, 3, 4].map((index) => ({
        name: `stuck_${String(index)}`,
        close: () => new Promise<void>(() => undefined),
      })),
    });
    const startedAt = Date.now();

    await server.close();

    expect(Date.now() - startedAt).toBeLessThan(600);
  });

  it('bounds shutdown when a resource never closes and still closes the rest', async () => {
    const closed: string[] = [];
    const server = await startServer(await app(), {
      port: 0,
      host: '127.0.0.1',
      signals: new FakeProcess(),
      shutdownTimeoutMs: 50,
      resources: [
        { name: 'stuck', close: () => new Promise(() => undefined) },
        {
          name: 'failing',
          close: () => Promise.reject(new Error('synthetic close failure')),
        },
        {
          name: 'pool',
          close: () => {
            closed.push('pool');
            return Promise.resolve();
          },
        },
      ],
    });
    const startedAt = Date.now();

    await server.close();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(closed).toEqual(['pool']);
  });

  it('closes resources and rejects when the port is unavailable', async () => {
    const first = await startServer(await app(), {
      port: 0,
      host: '127.0.0.1',
      signals: new FakeProcess(),
    });
    started.push(first);
    const port = Number(new URL(first.url).port);
    const closed: string[] = [];

    await expect(
      startServer(await app(), {
        port,
        host: '127.0.0.1',
        signals: new FakeProcess(),
        resources: [
          {
            name: 'pool',
            close: () => {
              closed.push('pool');
              return Promise.resolve();
            },
          },
        ],
      }),
    ).rejects.toThrow();
    expect(closed).toEqual(['pool']);
  });

  it.each([
    { port: -1 },
    { port: 70_000 },
    { port: 1.5 },
    { port: 0, shutdownTimeoutMs: 0 },
  ])('rejects invalid options %o', async (options) => {
    await expect(
      startServer(await app(), {
        host: '127.0.0.1',
        signals: new FakeProcess(),
        ...options,
      }),
    ).rejects.toThrow('invalid_server_options');
  });
});
