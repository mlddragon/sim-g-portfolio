import { describe, expect, it } from 'vitest';

import { DomainError } from '../../../src/domain/errors.js';
import {
  addisonToken,
  apiHarness as harness,
  apiNow as now,
  confidentialQuery,
  postOperation,
  validToken,
  type ApiHarness as Harness,
} from '../../support/api-harness.js';

function search(
  app: Harness['app'],
  body: unknown = { query: confidentialQuery, limit: 5 },
  headers: Record<string, string> = {},
) {
  return postOperation(app, 'search_brain', body, headers);
}

describe('API composition root', () => {
  it('authenticates, then searches with a server-generated request context', async () => {
    const { app, searches, authentications } = await harness();

    const response = await search(app);

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('req_api_1');
    expect(response.json()).toEqual({
      requestId: 'req_api_1',
      results: [
        {
          brainRecordId: 'brn_notion_api',
          title: 'Synthetic api',
          excerpt: 'Synthetic api excerpt',
          canonicalLocation: {
            provider: 'notion',
            containerRef: 'notion://development/family-shared',
            displayPath: 'Synthetic / api',
          },
          provenance: {
            provider: 'notion',
            providerRecordId: 'notion-record-api',
            providerVersion: 'notion-version-api',
            createdAt: '2042-01-01T00:00:00.000Z',
            updatedAt: '2042-01-02T00:00:00.000Z',
          },
          policy: {
            scope: 'family_shared',
            sensitivity: 'family_shared',
            protectedClass: 'none',
          },
        },
      ],
      completeness: {
        complete: false,
        providers: [
          { provider: 'notion', state: 'complete' },
          {
            provider: 'github',
            state: 'timed_out',
            errorCode: 'provider_unavailable',
          },
        ],
      },
    });
    expect(authentications).toEqual([
      {
        token: validToken,
        context: { requestId: 'req_api_1', receivedAt: now },
      },
    ]);
    expect(searches).toHaveLength(1);
    expect(searches[0]?.request).toEqual({
      query: confidentialQuery,
      limit: 5,
    });
    expect(searches[0]?.context).toEqual({
      requestId: 'req_api_1',
      receivedAt: now,
      clientId: 'synthetic-client',
    });
    expect(searches[0]?.authenticated.principal.id).toBe('prn_operator');
    expect(searches[0]?.signal.aborted).toBe(false);
  });

  it('never trusts a client-supplied request ID', async () => {
    const { app, searches } = await harness();

    const response = await search(app, undefined, {
      'x-request-id': 'req_forged',
    });

    expect(response.headers['x-request-id']).toBe('req_api_1');
    expect(searches[0]?.context.requestId).toBe('req_api_1');
  });

  it.each([
    ['a missing header', {}],
    ['a non-bearer scheme', { authorization: `Basic ${validToken}` }],
    ['an empty bearer token', { authorization: 'Bearer ' }],
    ['a token with spaces', { authorization: 'Bearer two tokens' }],
    ['an oversized token', { authorization: `Bearer ${'a'.repeat(16_385)}` }],
    ['a trailing newline', { authorization: `Bearer ${validToken}\n` }],
    ['a repeated scheme', { authorization: 'Bearer Bearer abc' }],
  ])(
    'rejects %s before any service call',
    async (_, headers: Record<string, string>) => {
      const { app, searches, authentications } = await harness();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/operations/search_brain',
        headers: { 'content-type': 'application/json', ...headers },
        payload: JSON.stringify({ query: 'q', limit: 1 }),
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.json()).toEqual({
        error: {
          code: 'unauthenticated',
          retryable: false,
          details: { reason: 'bearer_token_required' },
        },
        requestId: 'req_api_1',
      });
      expect(authentications).toEqual([]);
      expect(searches).toEqual([]);
    },
  );

  it('maps an invalid token to 401 without calling the operation', async () => {
    const { app, searches } = await harness();

    const response = await search(app, undefined, {
      authorization: 'Bearer synthetic.invalid',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: 'unauthenticated',
        details: { reason: 'identity_verification_failed' },
      },
    });
    expect(searches).toEqual([]);
  });

  it('maps an identity provider outage to a retryable 503', async () => {
    const { app } = await harness({
      authentication: {
        authenticate: () =>
          Promise.reject(
            new DomainError('provider_unavailable', true, {
              reason: 'jwks_timeout',
            }),
          ),
      },
    });

    const response = await search(app);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: 'provider_unavailable', retryable: true },
    });
  });

  it('authenticates before validating the body', async () => {
    const { app, authentications } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/operations/search_brain',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });

    expect(response.statusCode).toBe(401);
    expect(authentications).toEqual([]);
  });

  it.each([
    [
      'a forged principal field',
      { query: 'q', limit: 1, principalId: 'prn_steward' },
    ],
    ['a forged user claim', { query: 'q', limit: 1, user: 'steward' }],
    ['a missing query', { limit: 1 }],
    ['a blank query', { query: '   ', limit: 1 }],
    ['an oversized query', { query: 'q'.repeat(2_049), limit: 1 }],
    ['a zero limit', { query: 'q', limit: 0 }],
    ['a limit above the maximum', { query: 'q', limit: 51 }],
    ['a fractional limit', { query: 'q', limit: 1.5 }],
    ['a string limit', { query: 'q', limit: '5' }],
    ['an array body', [{ query: 'q', limit: 1 }]],
  ])('rejects %s with a safe 400', async (_, body: unknown) => {
    const { app, searches } = await harness();

    const response = await search(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'invalid_request',
        retryable: false,
        details: { reason: 'invalid_request_body' },
      },
      requestId: 'req_api_1',
    });
    expect(searches).toEqual([]);
  });

  it('rejects malformed JSON with a safe 400', async () => {
    const { app } = await harness();

    const response = await search(app, '{"query": "q",');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_request', details: { reason: 'invalid_json' } },
    });
    expect(response.body).not.toContain('Unexpected');
  });

  it.each([
    '{"query":"q","limit":1,"__proto__":{"admin":true}}',
    '{"query":"q","limit":1,"constructor":{"prototype":{"admin":true}}}',
  ])('rejects prototype-polluting JSON %s', async (payload) => {
    const { app, searches } = await harness();

    const response = await search(app, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_request', details: { reason: 'invalid_json' } },
    });
    expect(searches).toEqual([]);
  });

  it('rejects a non-JSON content type with 415', async () => {
    const { app, searches } = await harness();

    const response = await search(app, 'query=q', {
      'content-type': 'application/x-www-form-urlencoded',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({
      error: {
        code: 'invalid_request',
        details: { reason: 'unsupported_media_type' },
      },
    });
    expect(searches).toEqual([]);
  });

  it('rejects an oversized body with 413', async () => {
    const { app, searches } = await harness();

    const response = await search(app, {
      query: 'q',
      limit: 1,
      padding: 'x'.repeat(20_000),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_request', details: { reason: 'body_too_large' } },
    });
    expect(searches).toEqual([]);
  });

  it.each([
    ['POST', '/v1/operations/raw_notion_query'],
    ['POST', '/v1/operations/ninth_operation'],
    ['POST', '/v1/operations/raw_provider_write'],
    ['GET', '/v1/operations/search_brain'],
    ['POST', '/v1/providers/notion/pages'],
    ['GET', '/'],
  ])('answers %s %s with a safe 404', async (method, url) => {
    const { app, searches } = await harness();

    const response = await app.inject({
      method: method as 'GET' | 'POST',
      url,
      headers: {
        authorization: `Bearer ${validToken}`,
        'content-type': 'application/json',
      },
      ...(method === 'POST' ? { payload: '{}' } : {}),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'not_found',
        retryable: false,
        details: { reason: 'route_not_found' },
      },
      requestId: 'req_api_1',
    });
    expect(searches).toEqual([]);
  });

  it.each([
    [
      new DomainError('unauthorized', false, {
        reason: 'record_access_denied',
      }),
      403,
    ],
    [new DomainError('invalid_request', false), 400],
    [new DomainError('not_found', false), 404],
    [new DomainError('idempotency_conflict', false), 409],
    [new DomainError('provider_unavailable', true), 503],
    [new DomainError('environment_boundary_violation', false), 403],
    [new DomainError('internal_error', false), 500],
  ] as const)(
    'maps %s to its stable status with the safe body',
    async (error, status) => {
      const { app } = await harness({
        operations: { searchBrain: () => Promise.reject(error) },
      });

      const response = await search(app);

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({
        ...error.toResponse(),
        requestId: 'req_api_1',
      });
    },
  );

  it('hides unexpected failures behind a generic internal error', async () => {
    const leaked = new Error(
      `SELECT * FROM principals -- ${confidentialQuery} token=${validToken}`,
    );
    const { app, logs } = await harness({
      operations: { searchBrain: () => Promise.reject(leaked) },
    });

    const response = await search(app);

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'internal_error', retryable: false, details: {} },
      requestId: 'req_api_1',
    });
    for (const text of [response.body, JSON.stringify(logs())]) {
      expect(text).not.toContain('SELECT');
      expect(text).not.toContain(confidentialQuery);
      expect(text).not.toContain(validToken);
      expect(text).not.toContain('stack');
    }
  });

  it('serves liveness without authentication or infrastructure detail', async () => {
    const { app, authentications } = await harness();

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(authentications).toEqual([]);
  });

  it('sets safe security headers on every response', async () => {
    const { app } = await harness();

    for (const response of [
      await search(app),
      await app.inject({ method: 'GET', url: '/healthz' }),
      await app.inject({ method: 'GET', url: '/missing' }),
    ]) {
      expect(response.headers).toMatchObject({
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      });
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['server']).toBeUndefined();
    }
  });

  it('logs one metadata-only line per request, never bodies or credentials', async () => {
    const { app, logs } = await harness();

    await search(app);
    await search(app, undefined, { authorization: 'Bearer synthetic.invalid' });

    const lines = logs();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      msg: 'request_completed',
      requestId: 'req_api_1',
      method: 'POST',
      route: '/v1/operations/search_brain',
      statusCode: 200,
    });
    expect(lines[1]).toMatchObject({
      requestId: 'req_api_2',
      statusCode: 401,
      errorCode: 'unauthenticated',
    });
    const text = JSON.stringify(lines);
    expect(text).not.toContain(confidentialQuery);
    expect(text).not.toContain(validToken);
    expect(text).not.toContain('synthetic.invalid');
    expect(text).not.toContain('authorization');
  });

  it('logs only the route template, never a query string', async () => {
    const { app, logs } = await harness();

    await app.inject({
      method: 'GET',
      url: `/missing?token=${validToken}`,
    });

    expect(JSON.stringify(logs())).not.toContain(validToken);
  });

  it('rejects invalid options at construction', async () => {
    await expect(harness({}, { trustedProxyHops: -1 })).rejects.toThrow(
      'invalid_api_options',
    );
    await expect(harness({}, { operationTimeoutMs: 0 })).rejects.toThrow(
      'invalid_api_options',
    );
    await expect(harness({}, { trustedProxyHops: 3 })).rejects.toThrow(
      'invalid_api_options',
    );
  });

  it('aborts the operation signal at the operation deadline', async () => {
    let observed: AbortSignal | undefined;
    const { app } = await harness(
      {
        operations: {
          searchBrain: (_authenticated, _context, _request, signal) => {
            observed = signal;
            return new Promise((_, reject) => {
              signal.addEventListener('abort', () => {
                reject(new DOMException('cancelled', 'AbortError'));
              });
            });
          },
        },
      },
      { operationTimeoutMs: 50 },
    );

    const response = await search(app);

    expect(observed?.aborted).toBe(true);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: 'provider_unavailable',
        retryable: true,
        details: { reason: 'operation_timeout' },
      },
    });
  });

  it('accepts the bearer scheme case-insensitively', async () => {
    const { app, searches } = await harness();

    const response = await search(app, undefined, {
      authorization: `bearer ${validToken}`,
    });

    expect(response.statusCode).toBe(200);
    expect(searches).toHaveLength(1);
  });

  it('answers a malformed URL through the safe envelope without echoing it', async () => {
    const { app, logs, authentications } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/operations/%E0%A4%A?token=${validToken}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'invalid_request',
        retryable: false,
        details: { reason: 'bad_url' },
      },
      requestId: 'req_api_1',
    });
    expect(response.headers).toMatchObject({
      'x-request-id': 'req_api_1',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(response.body).not.toContain(validToken);
    expect(response.body).not.toContain('FST_');
    expect(logs()).toEqual([
      expect.objectContaining({
        msg: 'request_completed',
        requestId: 'req_api_1',
        statusCode: 400,
        errorCode: 'invalid_request',
      }),
    ]);
    expect(JSON.stringify(logs())).not.toContain(validToken);
    expect(authentications).toEqual([]);
  });

  it.each([
    ['malformed JSON', '{bad'],
    ['an oversized body', JSON.stringify({ padding: 'x'.repeat(70_000) })],
  ])(
    'answers an unknown route with 404 before parsing %s',
    async (_, payload) => {
      const { app } = await harness();

      const response = await app.inject({
        method: 'POST',
        url: '/missing',
        headers: { 'content-type': 'application/json' },
        payload,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: { code: 'not_found', details: { reason: 'route_not_found' } },
      });
    },
  );

  it('times out an operation that ignores its signal', async () => {
    const { app } = await harness(
      { operations: { searchBrain: () => new Promise(() => undefined) } },
      { operationTimeoutMs: 30 },
    );
    const started = Date.now();

    const response = await search(app);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: 'provider_unavailable',
        retryable: true,
        details: { reason: 'operation_timeout' },
      },
    });
  });

  it('times out authentication that never settles', async () => {
    const { app, searches } = await harness(
      { authentication: { authenticate: () => new Promise(() => undefined) } },
      { operationTimeoutMs: 30 },
    );

    const response = await search(app);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: 'provider_unavailable',
        details: { reason: 'authentication_timeout' },
      },
    });
    expect(searches).toEqual([]);
  });

  it('keeps the safe envelope when the failure itself is hostile', async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error(`hostile ${confidentialQuery}`);
        },
        getOwnPropertyDescriptor: () => {
          throw new Error(`hostile ${confidentialQuery}`);
        },
        get: () => {
          throw new Error(`hostile ${confidentialQuery}`);
        },
      },
    ) as unknown as Error;
    const { app, logs } = await harness({
      operations: { searchBrain: () => Promise.reject(hostile) },
    });

    const response = await search(app);

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'internal_error', retryable: false, details: {} },
      requestId: 'req_api_1',
    });
    expect(response.body).not.toContain(confidentialQuery);
    expect(logs()[0]).toMatchObject({ errorCode: 'internal_error' });
  });

  it.each([400, 413, 415])(
    'never treats an application error with status %s as a transport error',
    async (statusCode) => {
      const { app } = await harness({
        operations: {
          searchBrain: () =>
            Promise.reject(
              Object.assign(new Error('synthetic'), {
                statusCode,
                code: 'FST_ERR_CTP_BODY_TOO_LARGE',
              }),
            ),
        },
      });

      const response = await search(app);

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        error: { code: 'internal_error' },
      });
    },
  );

  it('falls back to a generated request ID when the source is invalid', async () => {
    const { app, searches } = await harness({
      requestIds: () => 'invalid id\n',
    });

    const response = await search(app);

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toMatch(
      /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(searches[0]?.context.requestId).toBe(
      response.headers['x-request-id'],
    );
  });

  it('passes Participant through unchanged for server-side authorization', async () => {
    const { app, searches } = await harness();

    await search(app, undefined, { authorization: `Bearer ${addisonToken}` });

    expect(searches[0]?.authenticated.principal.role).toBe(
      'family_participant',
    );
    expect(searches[0]?.context).not.toHaveProperty('clientId');
  });
});
