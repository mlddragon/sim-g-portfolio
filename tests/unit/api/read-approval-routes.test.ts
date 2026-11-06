import { describe, expect, it } from 'vitest';

import { DomainError } from '../../../src/domain/errors.js';
import {
  addisonToken,
  apiHarness,
  postOperation,
} from '../../support/api-harness.js';

const participant = { authorization: `Bearer ${addisonToken}` };

describe('fetch_record route', () => {
  it('fetches one record by its Brain ID and projects the full record', async () => {
    const { app, fetches } = await apiHarness();

    const response = await postOperation(app, 'fetch_record', {
      brainRecordId: 'brn_drive_fetched',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      record: {
        brainRecordId: 'brn_drive_fetched',
        title: 'Synthetic fetched',
        excerpt: 'Synthetic fetched excerpt',
        content: 'Synthetic full body.',
        contentType: 'text/markdown',
        canonicalLocation: {
          provider: 'drive',
          containerRef: expect.any(String) as unknown,
          displayPath: 'Synthetic / fetched',
        },
        provenance: {
          provider: 'drive',
          providerRecordId: 'drive-record-fetched',
          providerVersion: 'drive-version-fetched',
          createdAt: '2042-01-01T00:00:00.000Z',
          updatedAt: '2042-01-02T00:00:00.000Z',
        },
        policy: {
          scope: 'family_shared',
          sensitivity: 'family_shared',
          protectedClass: 'none',
        },
      },
    });
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.request).toEqual({ brainRecordId: 'brn_drive_fetched' });
    expect(fetches[0]?.context).toMatchObject({
      requestId: 'req_api_1',
      clientId: 'synthetic-client',
    });
  });

  it('never projects fields outside the record contract', async () => {
    const { app } = await apiHarness({
      operations: {
        fetchRecord: () =>
          Promise.resolve({
            record: {
              brainRecordId: 'brn_extra',
              title: 't',
              excerpt: 'e',
              content: 'c',
              contentType: 'text/plain',
              canonicalLocation: {
                provider: 'notion',
                containerRef: 'notion.family_shared',
                providerToken: 'synthetic-leak',
              },
              provenance: {
                provider: 'notion',
                providerRecordId: 'notion-extra',
                createdAt: new Date('2042-01-01T00:00:00.000Z'),
                updatedAt: new Date('2042-01-01T00:00:00.000Z'),
                rawProviderPayload: 'synthetic-leak',
              },
              policy: {
                scope: 'family_shared',
                sensitivity: 'family_shared',
                protectedClass: 'none',
              },
              credential: 'synthetic-leak',
            },
          } as never),
      },
    });

    const response = await postOperation(app, 'fetch_record', {
      brainRecordId: 'brn_extra',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('synthetic-leak');
  });

  it.each([
    ['a missing ID', {}],
    ['a numeric ID', { brainRecordId: 42 }],
    ['an empty ID', { brainRecordId: '' }],
    ['an ID with spaces', { brainRecordId: 'brn bad' }],
    ['an ID with a control character', { brainRecordId: 'brn\u0000x' }],
    ['an oversized ID', { brainRecordId: `brn_${'x'.repeat(600)}` }],
    ['a provider record ID instead', { providerRecordId: 'notion-1' }],
    [
      'a forged principal',
      { brainRecordId: 'brn_1', principalId: 'prn_steward' },
    ],
    ['a provider hint', { brainRecordId: 'brn_1', provider: 'notion' }],
    ['an array body', [{ brainRecordId: 'brn_1' }]],
  ])('rejects %s before the service', async (_, body) => {
    const { app, fetches } = await apiHarness();

    const response = await postOperation(app, 'fetch_record', body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'invalid_request',
        details: { reason: 'invalid_request_body' },
      },
    });
    expect(fetches).toEqual([]);
  });

  it('passes a hidden denial through as the same 404 as a missing record', async () => {
    // The fetch service reports an unauthorized record exactly like a missing
    // one, so the transport must not reveal that it exists.
    const denial = new DomainError('not_found', false, {
      reason: 'record_not_found',
    });
    const seen: string[] = [];
    const { app } = await apiHarness({
      operations: {
        fetchRecord: (authenticated) => {
          seen.push(authenticated.principal.role);
          return Promise.reject(denial);
        },
      },
    });

    const response = await postOperation(
      app,
      'fetch_record',
      { brainRecordId: 'brn_parent_only' },
      participant,
    );

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      ...denial.toResponse(),
      requestId: 'req_api_1',
    });
    expect(seen).toEqual(['family_participant']);
  });

  it('requires authentication before reading the body', async () => {
    const { app, fetches, authentications } = await apiHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/operations/fetch_record',
      headers: { 'content-type': 'application/json' },
      payload: '{"brainRecordId":"brn_1"}',
    });

    expect(response.statusCode).toBe(401);
    expect(authentications).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it('rejects an oversized fetch body with 413', async () => {
    const { app, fetches } = await apiHarness();

    const response = await postOperation(app, 'fetch_record', {
      brainRecordId: 'brn_1',
      padding: 'x'.repeat(5_000),
    });

    expect(response.statusCode).toBe(413);
    expect(fetches).toEqual([]);
  });
});

describe('list_approvals route', () => {
  it.each([
    ['an empty object', '{}', 'application/json'],
    ['no body', undefined, undefined],
  ])('lists approvals with %s', async (_, payload, contentType) => {
    const { app, listings } = await apiHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/operations/list_approvals',
      headers: {
        authorization: 'Bearer synthetic.valid-token_for~operator+/=',
        ...(contentType === undefined ? {} : { 'content-type': contentType }),
      },
      ...(payload === undefined ? {} : { payload }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      approvals: [
        {
          approvalRequestId: 'apr_api_1',
          operationId: 'op_api_1',
          status: 'pending',
          summary: {
            requestedByDisplayName: 'participant',
            action: 'Update one Family Shared record',
            safeTargetDescription: 'Synthetic shared note',
          },
          createdAt: '2045-05-06T07:00:00.000Z',
        },
      ],
    });
    expect(listings).toHaveLength(1);
    expect(listings[0]?.context.requestId).toBe('req_api_1');
  });

  it.each([
    ['a filter field', { status: 'pending' }],
    ['a forged principal', { principalId: 'prn_steward' }],
    ['an array', []],
    ['a JSON string', '"all"'],
  ])('rejects %s', async (_, body) => {
    const { app, listings } = await apiHarness();

    const response = await postOperation(app, 'list_approvals', body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { details: { reason: 'invalid_request_body' } },
    });
    expect(listings).toEqual([]);
  });

  it('passes Participant through for the service to deny', async () => {
    const denial = new DomainError('unauthorized', false, {
      reason: 'approval_list_denied',
    });
    const seen: { id: string; role: string }[] = [];
    const { app } = await apiHarness({
      operations: {
        listApprovals: (authenticated) => {
          seen.push(authenticated.principal);
          return Promise.reject(denial);
        },
      },
    });

    const response = await postOperation(
      app,
      'list_approvals',
      { principalId: 'prn_operator' },
      participant,
    );
    expect(response.statusCode).toBe(400);
    expect(seen).toEqual([]);

    const denied = await postOperation(app, 'list_approvals', {}, participant);

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({
      ...denial.toResponse(),
      requestId: 'req_api_2',
    });
    expect(seen).toMatchObject([
      { id: 'prn_participant', role: 'family_participant' },
    ]);
  });

  it('requires omitting the JSON content type when sending no body', async () => {
    const { app, listings } = await apiHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/operations/list_approvals',
      headers: {
        authorization: 'Bearer synthetic.valid-token_for~operator+/=',
        'content-type': 'application/json',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { details: { reason: 'invalid_json' } },
    });
    expect(listings).toEqual([]);
  });

  it('never projects approval fields outside the safe list contract', async () => {
    const { app } = await apiHarness({
      operations: {
        listApprovals: () =>
          Promise.resolve({
            approvals: [
              {
                approvalRequestId: 'apr_extra',
                operationId: 'op_extra',
                status: 'pending',
                summary: {
                  requestedByDisplayName: 'participant',
                  action: 'a',
                  safeTargetDescription: 'd',
                  protectedPayload: 'synthetic-leak',
                },
                createdAt: new Date('2045-01-01T00:00:00.000Z'),
                mutationPayload: { content: 'synthetic-leak' },
              },
            ],
          } as never),
      },
    });

    const response = await postOperation(app, 'list_approvals', {});

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('synthetic-leak');
  });
});

describe('resolve_approval route', () => {
  it.each([
    [{ approvalRequestId: 'apr_api_1', resolution: 'approve' }],
    [
      {
        approvalRequestId: 'apr_api_1',
        resolution: 'decline',
        reason: 'Synthetic parent reason',
      },
    ],
    [{ approvalRequestId: 'apr_api_1', resolution: 'cancel' }],
  ])('resolves %o and projects the outcome', async (body) => {
    const { app, resolutions } = await apiHarness();

    const response = await postOperation(app, 'resolve_approval', body);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      approvalRequestId: 'apr_api_1',
      operationId: 'op_api_1',
      approvalStatus: 'approved',
      operationState: 'COMPLETED',
    });
    expect(resolutions[0]?.request).toEqual(body);
    expect(resolutions[0]?.authenticated.principal.id).toBe('prn_operator');
  });

  it.each([
    ['a missing resolution', { approvalRequestId: 'apr_1' }],
    [
      'an unknown resolution',
      { approvalRequestId: 'apr_1', resolution: 'force' },
    ],
    [
      'an uppercase resolution',
      { approvalRequestId: 'apr_1', resolution: 'APPROVE' },
    ],
    ['a missing ID', { resolution: 'approve' }],
    [
      'an empty reason',
      { approvalRequestId: 'apr_1', resolution: 'approve', reason: '' },
    ],
    [
      'a padded reason',
      { approvalRequestId: 'apr_1', resolution: 'approve', reason: ' why ' },
    ],
    [
      'a reason with a NUL',
      { approvalRequestId: 'apr_1', resolution: 'decline', reason: 'x\u0000y' },
    ],
    [
      'a reason with a lone surrogate',
      { approvalRequestId: 'apr_1', resolution: 'decline', reason: 'x\ud800' },
    ],
    [
      'an oversized reason',
      {
        approvalRequestId: 'apr_1',
        resolution: 'approve',
        reason: 'r'.repeat(1_001),
      },
    ],
    [
      'a forged resolver',
      {
        approvalRequestId: 'apr_1',
        resolution: 'approve',
        resolvedByPrincipalId: 'prn_steward',
      },
    ],
    [
      'an elevation token',
      {
        approvalRequestId: 'apr_1',
        resolution: 'approve',
        elevation: { challengeId: 'elv_1', confirmationToken: 'x' },
      },
    ],
  ])('rejects %s before the service', async (_, body) => {
    const { app, resolutions } = await apiHarness();

    const response = await postOperation(app, 'resolve_approval', body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { details: { reason: 'invalid_request_body' } },
    });
    expect(resolutions).toEqual([]);
  });

  it('passes Participant through for the service to deny', async () => {
    const denial = new DomainError('unauthorized', false, {
      reason: 'approval_resolution_denied',
    });
    const seen: { id: string; role: string }[] = [];
    const { app } = await apiHarness({
      operations: {
        resolveApproval: (authenticated) => {
          seen.push(authenticated.principal);
          return Promise.reject(denial);
        },
      },
    });

    const response = await postOperation(
      app,
      'resolve_approval',
      { approvalRequestId: 'apr_1', resolution: 'approve' },
      participant,
    );

    expect(seen).toMatchObject([
      { id: 'prn_participant', role: 'family_participant' },
    ]);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      ...denial.toResponse(),
      requestId: 'req_api_1',
    });
  });

  it('maps a retryable recovery error to 503', async () => {
    const { app } = await apiHarness({
      operations: {
        resolveApproval: () =>
          Promise.reject(
            new DomainError('provider_unavailable', true, {
              reason: 'recovery_operation_state_unavailable',
            }),
          ),
      },
    });

    const response = await postOperation(app, 'resolve_approval', {
      approvalRequestId: 'apr_1',
      resolution: 'approve',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: 'provider_unavailable', retryable: true },
    });
  });
});
