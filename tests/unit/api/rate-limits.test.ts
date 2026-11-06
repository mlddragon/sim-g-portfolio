import { describe, expect, it } from 'vitest';

import type { ApiOptions } from '../../../src/api/build-app.js';
import type { AuthenticatedPrincipal } from '../../../src/domain/principal.js';
import {
  addisonToken,
  apiHarness,
  apiNow,
  validToken,
} from '../../support/api-harness.js';
import { brainReadPrincipal } from '../../support/brain-read-fixtures.js';

class ManualClock {
  at = apiNow.getTime();
  now(): Date {
    return new Date(this.at);
  }
}

const jillToken = 'synthetic.steward-token';

function steward(): AuthenticatedPrincipal {
  const base = brainReadPrincipal('parent_steward');
  return {
    principal: {
      ...base.principal,
      id: 'prn_steward' as never,
      key: 'steward',
    },
    identity: {
      ...base.identity,
      principalId: 'prn_steward' as never,
      clientId: 'synthetic-client',
    },
  };
}

async function limited(
  rateLimits: NonNullable<ApiOptions['rateLimits']>,
  hops = 0,
) {
  const clock = new ManualClock();
  const harness = await apiHarness(
    {
      clock,
      authentication: {
        authenticate: (token, context) => {
          harness.authentications.push({ token, context });
          if (token === validToken) {
            const operator = brainReadPrincipal();
            return Promise.resolve({
              ...operator,
              identity: { ...operator.identity, clientId: 'synthetic-client' },
            });
          }
          if (token === addisonToken) {
            return Promise.resolve(brainReadPrincipal('family_participant'));
          }
          if (token === jillToken) return Promise.resolve(steward());
          return Promise.reject(new Error('synthetic unauthenticated'));
        },
      },
    },
    { rateLimits, trustedProxyHops: hops },
  );
  return { ...harness, clock };
}

function request(
  app: Awaited<ReturnType<typeof limited>>['app'],
  options: {
    readonly ip?: string;
    readonly token?: string;
    readonly url?: string;
    readonly payload?: string;
    readonly headers?: Record<string, string>;
    readonly method?: 'GET' | 'POST';
  } = {},
) {
  return app.inject({
    method: options.method ?? 'POST',
    url: options.url ?? '/v1/operations/search_brain',
    remoteAddress: options.ip ?? '192.0.2.10',
    headers: {
      'content-type': 'application/json',
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
      ...options.headers,
    },
    ...(options.method === 'GET'
      ? {}
      : { payload: options.payload ?? '{"query":"q","limit":1}' }),
  });
}

const appendBody = JSON.stringify({
  requestId: 'req_rate_append',
  brainRecordId: 'brn_target',
  content: 'Synthetic appended text',
});

describe('request rate limits', () => {
  it('limits unauthenticated requests per client IP before authentication or parsing', async () => {
    const { app, authentications, searches } = await limited({
      perIpPerMinute: 2,
    });

    await request(app);
    await request(app);
    const blocked = await request(app, {
      token: validToken,
      payload: '{not json',
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(blocked.json()).toEqual({
      error: {
        code: 'rate_limited',
        retryable: true,
        details: { reason: 'ip_rate_limited' },
      },
      requestId: 'req_api_3',
    });
    expect(blocked.headers).toMatchObject({
      'cache-control': 'no-store',
      'x-request-id': 'req_api_3',
    });
    expect(authentications).toEqual([]);
    expect(searches).toEqual([]);
  });

  it('counts each client IP separately and resets after the window', async () => {
    const { app, clock } = await limited({ perIpPerMinute: 1 });

    expect((await request(app, { ip: '192.0.2.1' })).statusCode).toBe(401);
    expect((await request(app, { ip: '192.0.2.2' })).statusCode).toBe(401);
    expect((await request(app, { ip: '192.0.2.1' })).statusCode).toBe(429);

    clock.at += 30_000;
    const partial = await request(app, { ip: '192.0.2.1' });
    expect(partial.statusCode).toBe(429);
    expect(partial.headers['retry-after']).toBe('30');

    clock.at += 30_000;
    expect((await request(app, { ip: '192.0.2.1' })).statusCode).toBe(401);
  });

  it('ignores X-Forwarded-For when no proxy hop is trusted', async () => {
    const { app } = await limited({ perIpPerMinute: 1 });

    await request(app, { headers: { 'x-forwarded-for': '203.0.113.1' } });
    const spoofed = await request(app, {
      headers: { 'x-forwarded-for': '203.0.113.2' },
    });

    expect(spoofed.statusCode).toBe(429);
  });

  it('trusts only the configured proxy hop, so client-added entries cannot rotate the key', async () => {
    const { app } = await limited({ perIpPerMinute: 1 }, 1);

    await request(app, {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.9' },
    });
    const rotated = await request(app, {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.2, 203.0.113.9' },
    });
    const otherClient = await request(app, {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.10' },
    });

    expect(rotated.statusCode).toBe(429);
    expect(otherClient.statusCode).toBe(401);
  });

  it('keys an IPv6 client by its /64 so address rotation cannot evade the limit', async () => {
    const { app, authentications } = await limited(
      { perIpPerMinute: 2, maxTrackedKeys: 3 },
      1,
    );

    const statuses: number[] = [];
    for (let host = 1; host <= 6; host += 1) {
      const response = await request(app, {
        ip: '10.0.0.1',
        headers: { 'x-forwarded-for': `2001:db8:1:2::${host.toString(16)}` },
      });
      statuses.push(response.statusCode);
    }
    const otherPrefix = await request(app, {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '2001:db8:1:3::1' },
    });

    expect(statuses).toEqual([401, 401, 429, 429, 429, 429]);
    expect(otherPrefix.statusCode).toBe(401);
    expect(authentications).toEqual([]);
  });

  it('treats every form of one IPv4 address as the same client', async () => {
    const { app } = await limited({ perIpPerMinute: 1 }, 1);

    const forms = ['192.0.2.7', '::ffff:192.0.2.7', '::ffff:c000:207'];
    const statuses: number[] = [];
    for (const form of forms) {
      statuses.push(
        (
          await request(app, {
            ip: '10.0.0.1',
            headers: { 'x-forwarded-for': form },
          })
        ).statusCode,
      );
    }

    expect(statuses).toEqual([401, 429, 429]);
  });

  it('counts malformed URLs against the client IP', async () => {
    const { app, logs } = await limited({ perIpPerMinute: 2 });

    const first = await request(app, { method: 'GET', url: '/%zz' });
    const second = await request(app, { method: 'GET', url: '/%zz' });
    const third = await request(app, { method: 'GET', url: '/%zz' });

    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([
      400, 400, 429,
    ]);
    expect(third.headers['retry-after']).toBe('60');
    expect(third.json()).toMatchObject({
      error: { code: 'rate_limited', details: { reason: 'ip_rate_limited' } },
    });
    expect(logs()).toHaveLength(3);
  });

  it('starts a fresh window when the clock moves backwards', async () => {
    const { app, clock } = await limited({ perIpPerMinute: 1 });

    await request(app);
    expect((await request(app)).statusCode).toBe(429);
    clock.at -= 1_000;
    expect((await request(app)).statusCode).toBe(401);
  });

  it('limits each verified principal across IPs, never by declared identity', async () => {
    const { app, searches } = await limited({
      perIpPerMinute: 100,
      perPrincipalPerMinute: 2,
    });

    await request(app, { ip: '192.0.2.1', token: validToken });
    await request(app, {
      ip: '192.0.2.2',
      token: validToken,
      headers: { 'x-principal-id': 'prn_steward', 'x-client-id': 'other' },
    });
    const blocked = await request(app, { ip: '192.0.2.3', token: validToken });
    const participant = await request(app, {
      ip: '192.0.2.3',
      token: addisonToken,
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({
      error: { details: { reason: 'principal_rate_limited' } },
    });
    expect(participant.statusCode).toBe(200);
    expect(
      searches.map(({ authenticated }) => authenticated.principal.id),
    ).toEqual(['prn_operator', 'prn_operator', 'prn_participant']);
  });

  it('applies the tighter mutation limit while reads continue', async () => {
    const { app, mutations, searches } = await limited({
      perIpPerMinute: 100,
      perPrincipalPerMinute: 100,
      mutationsPerPrincipalPerMinute: 1,
    });
    const append = {
      url: '/v1/operations/append_to_record',
      token: validToken,
    };

    expect(
      (await request(app, { ...append, payload: appendBody })).statusCode,
    ).toBe(200);
    const blocked = await request(app, { ...append, payload: '{not json' });
    const read = await request(app, { token: validToken });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({
      error: { details: { reason: 'mutation_rate_limited' } },
    });
    expect(read.statusCode).toBe(200);
    expect(mutations).toHaveLength(1);
    expect(searches).toHaveLength(1);
  });

  it('limits a verified client ID shared across principals', async () => {
    const { app } = await limited({
      perIpPerMinute: 100,
      perPrincipalPerMinute: 100,
      perClientPerMinute: 2,
    });

    await request(app, { token: validToken });
    await request(app, { token: jillToken });
    const blocked = await request(app, { token: validToken });
    // Participant's identity has no client ID, so only her own buckets apply.
    const participant = await request(app, { token: addisonToken });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({
      error: { details: { reason: 'client_rate_limited' } },
    });
    expect(participant.statusCode).toBe(200);
  });

  it('never counts a rejected authentication against the principal', async () => {
    const { app } = await limited({
      perIpPerMinute: 100,
      perPrincipalPerMinute: 1,
    });

    await request(app, { token: 'synthetic.invalid' });
    expect((await request(app, { token: validToken })).statusCode).toBe(200);
  });

  it('keeps liveness on its own bounded bucket', async () => {
    const { app } = await limited({
      perIpPerMinute: 1,
      healthPerIpPerMinute: 2,
    });

    await request(app);
    expect(
      (await request(app, { method: 'GET', url: '/healthz' })).statusCode,
    ).toBe(200);
    expect(
      (await request(app, { method: 'GET', url: '/healthz' })).statusCode,
    ).toBe(200);
    const blocked = await request(app, { method: 'GET', url: '/healthz' });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({
      error: { details: { reason: 'health_rate_limited' } },
    });
  });

  it('counts unknown-route probes against the client IP', async () => {
    const { app } = await limited({ perIpPerMinute: 1 });

    expect((await request(app, { url: '/v1/operations/raw' })).statusCode).toBe(
      404,
    );
    expect(
      (await request(app, { url: '/v1/operations/raw2' })).statusCode,
    ).toBe(429);
  });

  it('bounds tracked keys by evicting the least recently used bucket', async () => {
    const { app } = await limited({ perIpPerMinute: 1, maxTrackedKeys: 2 });

    await request(app, { ip: '192.0.2.1' });
    await request(app, { ip: '192.0.2.2' });
    await request(app, { ip: '192.0.2.3' });

    // The oldest bucket was evicted to stay within two keys.
    expect((await request(app, { ip: '192.0.2.1' })).statusCode).toBe(401);
    expect((await request(app, { ip: '192.0.2.3' })).statusCode).toBe(429);
  });

  it('logs a rate-limited request with its code and no detail', async () => {
    const { app, logs } = await limited({ perIpPerMinute: 1 });

    await request(app);
    await request(app, { token: validToken });

    expect(logs()[1]).toMatchObject({
      requestId: 'req_api_2',
      statusCode: 429,
      errorCode: 'rate_limited',
    });
    expect(JSON.stringify(logs())).not.toContain(validToken);
  });

  it.each([
    { perIpPerMinute: 0 },
    { perPrincipalPerMinute: 1.5 },
    { mutationsPerPrincipalPerMinute: -1 },
    { perClientPerMinute: 1_000_001 },
    { healthPerIpPerMinute: Number.NaN },
    { maxTrackedKeys: 0 },
    { maxTrackedKeys: 2_000_000 },
  ])('rejects invalid rate limits %o at construction', async (rateLimits) => {
    await expect(limited(rateLimits)).rejects.toThrow('invalid_api_options');
  });
});
