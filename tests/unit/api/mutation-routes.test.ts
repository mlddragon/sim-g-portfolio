import { describe, expect, it } from 'vitest';

import { DomainError } from '../../../src/domain/errors.js';
import {
  elevationChallengeId,
  operationId,
} from '../../../src/domain/identifiers.js';
import { mutationOperationId } from '../../../src/api/schemas/mutations.js';
import type { MutationResponse } from '../../../src/domain/operations.js';
import {
  addisonToken,
  apiHarness,
  postOperation,
} from '../../support/api-harness.js';

const secretContent = 'Synthetic confidential family note body';
const secretToken = `synthetic-elevation-token-${'z'.repeat(40)}`;
const keys = { requestId: 'req_client_1' };
const masonOp = (operation: string) =>
  mutationOperationId('prn_operator', operation, 'req_client_1');

const validBodies = {
  persist_knowledge: {
    ...keys,
    title: 'Synthetic title',
    content: secretContent,
    semanticMetadata: {
      subject: 'Synthetic subject',
      recordType: 'note',
      sensitivity: 'family_shared',
      canonicalHint: { provider: 'notion' },
    },
  },
  update_record: {
    ...keys,
    brainRecordId: 'brn_target',
    mutation: { mode: 'patch', patch: { title: 'Synthetic new title' } },
  },
  append_to_record: {
    ...keys,
    brainRecordId: 'brn_target',
    content: secretContent,
  },
  delete_record: {
    ...keys,
    brainRecordId: 'brn_target',
    explicitIntent: true,
  },
} as const;

type Operation = keyof typeof validBodies;
const operations = Object.keys(validBodies) as Operation[];

describe('mutation routes', () => {
  it.each(operations)(
    '%s binds identity to the verified caller and keeps client idempotency keys',
    async (operation) => {
      const { app, mutations } = await apiHarness();

      const response = await postOperation(
        app,
        operation,
        validBodies[operation],
      );

      expect(response.statusCode).toBe(200);
      expect(response.headers['x-request-id']).toBe('req_api_1');
      expect(response.json()).toEqual({
        operationId: masonOp(operation),
        state: 'completed',
        brainRecordId: 'brn_api_mutated',
        record: {
          provider: 'notion',
          providerRecordId: 'notion-api-mutated',
          providerVersion: 'notion-version-mutated',
          canonicalLocation: {
            provider: 'notion',
            containerRef: 'notion://development/family-shared',
          },
        },
      });
      expect(mutations).toHaveLength(1);
      const [call] = mutations;
      expect(call?.operation).toBe(operation);
      expect(call?.request).toMatchObject({
        operationId: masonOp(operation),
        requestId: 'req_client_1',
        principalId: 'prn_operator',
        clientId: 'synthetic-client',
      });
      expect(call?.context).toMatchObject({
        requestId: 'req_client_1',
        clientId: 'synthetic-client',
      });
      expect(call?.authenticated.principal.id).toBe('prn_operator');
    },
  );

  it('passes each shape through exactly, with no added or dropped fields', async () => {
    const { app, mutations } = await apiHarness();

    for (const operation of operations) {
      await postOperation(app, operation, validBodies[operation]);
    }

    const { requestId: _r, ...persist } = validBodies.persist_knowledge;
    expect(mutations.map(({ request }) => request)).toEqual([
      {
        ...keys,
        ...persist,
        operationId: masonOp('persist_knowledge'),
        principalId: 'prn_operator',
        clientId: 'synthetic-client',
      },
      {
        ...validBodies.update_record,
        operationId: masonOp('update_record'),
        principalId: 'prn_operator',
        clientId: 'synthetic-client',
      },
      {
        ...validBodies.append_to_record,
        operationId: masonOp('append_to_record'),
        principalId: 'prn_operator',
        clientId: 'synthetic-client',
      },
      {
        ...validBodies.delete_record,
        operationId: masonOp('delete_record'),
        principalId: 'prn_operator',
        clientId: 'synthetic-client',
      },
    ]);
  });

  it('omits clientId when the verified identity has none', async () => {
    const { app, mutations } = await apiHarness();

    await postOperation(app, 'append_to_record', validBodies.append_to_record, {
      authorization: `Bearer ${addisonToken}`,
    });

    expect(mutations[0]?.request).toMatchObject({
      principalId: 'prn_participant',
    });
    expect(mutations[0]?.request).not.toHaveProperty('clientId');
    expect(mutations[0]?.context).not.toHaveProperty('clientId');
  });

  it('replays a retry under the same client keys with a new correlation ID', async () => {
    const { app, mutations } = await apiHarness();

    const first = await postOperation(
      app,
      'append_to_record',
      validBodies.append_to_record,
    );
    const retry = await postOperation(
      app,
      'append_to_record',
      validBodies.append_to_record,
    );

    expect(first.headers['x-request-id']).toBe('req_api_1');
    expect(retry.headers['x-request-id']).toBe('req_api_2');
    expect(mutations.map(({ request }) => request.requestId)).toEqual([
      'req_client_1',
      'req_client_1',
    ]);
    expect(mutations.map(({ request }) => request.operationId)).toEqual([
      masonOp('append_to_record'),
      masonOp('append_to_record'),
    ]);
  });

  const forged: readonly [Operation, string, Record<string, unknown>][] =
    operations.flatMap((operation) =>
      (
        [
          ['a principal', { principalId: 'prn_steward' }],
          ['a client ID', { clientId: 'forged-client' }],
          ['a user claim', { user: 'steward' }],
          ['a role', { role: 'owner_operator' }],
          ['a client operation ID', { operationId: 'op_someone_else' }],
        ] as const
      ).map(
        ([label, extra]) =>
          [operation, label, { ...validBodies[operation], ...extra }] as [
            Operation,
            string,
            Record<string, unknown>,
          ],
      ),
    );

  it.each(forged)(
    '%s rejects %s before the service',
    async (operation, _, body) => {
      const { app, mutations } = await apiHarness();

      const response = await postOperation(app, operation, body);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: 'invalid_request',
          details: { reason: 'invalid_request_body' },
        },
      });
      expect(mutations).toEqual([]);
    },
  );

  it.each([
    [
      'persist_knowledge',
      { ...validBodies.persist_knowledge, requestId: undefined },
    ],
    [
      'persist_knowledge',
      { ...validBodies.persist_knowledge, requestId: 'bad id' },
    ],
    ['persist_knowledge', { ...validBodies.persist_knowledge, title: '' }],
    [
      'persist_knowledge',
      { ...validBodies.persist_knowledge, title: 't'.repeat(2_001) },
    ],
    ['persist_knowledge', { ...validBodies.persist_knowledge, content: '' }],
    [
      'persist_knowledge',
      {
        ...validBodies.persist_knowledge,
        semanticMetadata: { subject: 'x', scope: 'parent_and_stewardship' },
      },
    ],
    [
      'persist_knowledge',
      {
        ...validBodies.persist_knowledge,
        semanticMetadata: { protectedClass: 'legal_hold' },
      },
    ],
    [
      'persist_knowledge',
      {
        ...validBodies.persist_knowledge,
        semanticMetadata: { creatorPrincipalId: 'prn_steward' },
      },
    ],
    [
      'persist_knowledge',
      {
        ...validBodies.persist_knowledge,
        semanticMetadata: { sensitivity: 'public' },
      },
    ],
    [
      'persist_knowledge',
      {
        ...validBodies.persist_knowledge,
        semanticMetadata: { canonicalHint: { provider: 'dropbox' } },
      },
    ],
    [
      'persist_knowledge',
      {
        ...validBodies.persist_knowledge,
        semanticMetadata: { canonicalHint: { providerRecordId: 'x' } },
      },
    ],
    [
      'update_record',
      {
        ...validBodies.update_record,
        mutation: {
          mode: 'patch',
          patch: { title: 't' },
          replacement: { content: 'c' },
        },
      },
    ],
    [
      'update_record',
      { ...validBodies.update_record, mutation: { mode: 'patch', patch: {} } },
    ],
    [
      'update_record',
      {
        ...validBodies.update_record,
        mutation: { mode: 'patch', patch: { title: 't', scope: 'x' } },
      },
    ],
    [
      'update_record',
      {
        ...validBodies.update_record,
        mutation: { mode: 'patch', patch: { title: '' } },
      },
    ],
    [
      'update_record',
      {
        ...validBodies.update_record,
        mutation: { mode: 'replace', replacement: {} },
      },
    ],
    [
      'update_record',
      {
        ...validBodies.update_record,
        mutation: { mode: 'merge', patch: { title: 't' } },
      },
    ],
    ['append_to_record', { ...validBodies.append_to_record, content: '   ' }],
    [
      'append_to_record',
      { ...validBodies.append_to_record, brainRecordId: '' },
    ],
    ['delete_record', { ...validBodies.delete_record, explicitIntent: false }],
    ['delete_record', { ...validBodies.delete_record, explicitIntent: 'true' }],
    ['delete_record', { ...keys, brainRecordId: 'brn_target' }],
    ['delete_record', { ...validBodies.delete_record, permanent: true }],
    [
      'delete_record',
      { ...validBodies.delete_record, brainRecordIds: ['a', 'b'] },
    ],
  ] as const)('%s rejects a malformed body %#', async (operation, body) => {
    const { app, mutations } = await apiHarness();

    const response = await postOperation(app, operation, body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { details: { reason: 'invalid_request_body' } },
    });
    expect(mutations).toEqual([]);
  });

  it.each(['persist_knowledge', 'update_record', 'append_to_record'] as const)(
    '%s rejects content over 1 MiB of UTF-8 before the service',
    async (operation) => {
      const { app, mutations } = await apiHarness();
      // 0x80+ code points are multi-byte, so this exceeds 1 MiB in UTF-8.
      const content = 'é'.repeat(600_000);
      const body =
        operation === 'update_record'
          ? {
              ...validBodies.update_record,
              mutation: { mode: 'replace', replacement: { content } },
            }
          : { ...validBodies[operation], content };

      const response = await postOperation(app, operation, body);

      expect(response.statusCode).toBe(400);
      expect(mutations).toEqual([]);
    },
  );

  it('accepts a full 1 MiB ASCII body and rejects a body over the route limit', async () => {
    const { app, mutations } = await apiHarness();

    const accepted = await postOperation(app, 'persist_knowledge', {
      ...validBodies.persist_knowledge,
      content: 'a'.repeat(1_048_576),
    });
    const tooLarge = await postOperation(app, 'append_to_record', {
      ...validBodies.append_to_record,
      content: 'a'.repeat(1_048_576),
      padding: 'p'.repeat(1_100_000),
    });

    expect(accepted.statusCode).toBe(200);
    expect(tooLarge.statusCode).toBe(413);
    expect(mutations).toHaveLength(1);
  });

  it('keeps the delete body limit small', async () => {
    const { app, mutations } = await apiHarness();

    const response = await postOperation(app, 'delete_record', {
      ...validBodies.delete_record,
      padding: 'p'.repeat(10_000),
    });

    expect(response.statusCode).toBe(413);
    expect(mutations).toEqual([]);
  });

  it.each([
    ['completed', 200],
    ['failed', 422],
    ['approval_required', 202],
    ['outcome_unknown', 202],
  ] as const)('answers a %s state with %i', async (state, status) => {
    const { app } = await apiHarness({
      operations: {
        updateRecord: (_authenticated, _context, request) =>
          Promise.resolve({ operationId: request.operationId, state }),
      },
    });

    const response = await postOperation(
      app,
      'update_record',
      validBodies.update_record,
    );

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({
      operationId: masonOp('update_record'),
      state,
    });
  });

  it('returns a one-time elevation grant only in the body, never in logs', async () => {
    const grant: MutationResponse = {
      operationId: operationId('op_client_1'),
      state: 'elevation_required',
      elevation: {
        challengeId: elevationChallengeId('elv_api_1'),
        confirmationToken: secretToken,
        expiresAt: new Date('2045-05-06T07:13:09.000Z'),
      },
    };
    const { app, logs } = await apiHarness({
      operations: { deleteRecord: () => Promise.resolve(grant) },
    });

    const response = await postOperation(
      app,
      'delete_record',
      validBodies.delete_record,
    );

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      operationId: 'op_client_1',
      state: 'elevation_required',
      elevation: {
        challengeId: 'elv_api_1',
        confirmationToken: secretToken,
        expiresAt: '2045-05-06T07:13:09.000Z',
      },
    });
    expect(JSON.stringify(logs())).not.toContain(secretToken);
  });

  it('passes an elevation confirmation through and never logs it', async () => {
    const { app, mutations, logs } = await apiHarness();
    const elevation = {
      challengeId: 'elv_api_1',
      confirmationToken: secretToken,
    };

    const response = await postOperation(app, 'update_record', {
      ...validBodies.update_record,
      elevation,
    });

    expect(response.statusCode).toBe(200);
    expect(mutations[0]?.request).toMatchObject({ elevation });
    expect(JSON.stringify(logs())).not.toContain(secretToken);
    expect(JSON.stringify(logs())).not.toContain(secretContent);
  });

  it.each([
    [{ challengeId: 'elv_1' }],
    [{ confirmationToken: secretToken }],
    [{ challengeId: 'elv_1', confirmationToken: '' }],
    [{ challengeId: 'elv_1', confirmationToken: 'x'.repeat(513) }],
    [
      {
        challengeId: 'elv_1',
        confirmationToken: secretToken,
        principalId: 'prn_steward',
      },
    ],
    ['elv_1'],
  ])('rejects a malformed elevation %#', async (elevation) => {
    const { app, mutations } = await apiHarness();

    const response = await postOperation(app, 'append_to_record', {
      ...validBodies.append_to_record,
      elevation,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(secretToken);
    expect(mutations).toEqual([]);
  });

  it('logs the operation ID but never content, titles or tokens', async () => {
    const { app, logs } = await apiHarness();

    await postOperation(
      app,
      'persist_knowledge',
      validBodies.persist_knowledge,
    );

    const lines = logs();
    expect(lines).toEqual([
      expect.objectContaining({
        msg: 'request_completed',
        requestId: 'req_api_1',
        route: '/v1/operations/persist_knowledge',
        operationId: masonOp('persist_knowledge'),
        clientRequestId: 'req_client_1',
        statusCode: 200,
      }),
    ]);
    const text = JSON.stringify(lines);
    expect(text).not.toContain(secretContent);
    expect(text).not.toContain('Synthetic title');
    expect(text).not.toContain('Synthetic subject');
  });

  it('never projects fields outside the mutation contract', async () => {
    const { app } = await apiHarness({
      operations: {
        persistKnowledge: () =>
          Promise.resolve({
            operationId: 'op_client_1',
            state: 'completed',
            mutationPayload: { content: 'synthetic-leak' },
            record: {
              provider: 'notion',
              providerRecordId: 'notion-1',
              canonicalLocation: {
                provider: 'notion',
                containerRef: 'notion.family_shared',
                credential: 'synthetic-leak',
              },
              rawProviderResponse: 'synthetic-leak',
            },
            elevation: undefined,
          } as never),
      },
    });

    const response = await postOperation(
      app,
      'persist_knowledge',
      validBodies.persist_knowledge,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('synthetic-leak');
  });

  it('maps an idempotency conflict to 409 without echoing content', async () => {
    const conflict = new DomainError('idempotency_conflict', false, {
      operation: 'append_to_record',
      reason: 'request_key_or_fingerprint_conflict',
    });
    const { app } = await apiHarness({
      operations: { appendToRecord: () => Promise.reject(conflict) },
    });

    const response = await postOperation(
      app,
      'append_to_record',
      validBodies.append_to_record,
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      ...conflict.toResponse(),
      requestId: 'req_api_1',
    });
    expect(response.body).not.toContain(secretContent);
  });

  it('derives a stable operation ID scoped to principal and operation', () => {
    const id = mutationOperationId('prn_operator', 'update_record', 'req_1');

    expect(id).toMatch(/^op_[0-9a-f]{64}$/u);
    expect(mutationOperationId('prn_operator', 'update_record', 'req_1')).toBe(
      id,
    );
    expect(
      mutationOperationId('prn_participant', 'update_record', 'req_1'),
    ).not.toBe(id);
    expect(
      mutationOperationId('prn_operator', 'append_to_record', 'req_1'),
    ).not.toBe(id);
    expect(
      mutationOperationId('prn_operator', 'update_record', 'req_2'),
    ).not.toBe(id);
    // Field boundaries are unambiguous.
    expect(mutationOperationId('prn_a', 'b', 'c_d')).not.toBe(
      mutationOperationId('prn_a', 'b_c', 'd'),
    );
  });

  it('gives Participant a different operation than Operator for the same request ID', async () => {
    const { app, mutations } = await apiHarness();

    await postOperation(app, 'append_to_record', validBodies.append_to_record);
    await postOperation(app, 'append_to_record', validBodies.append_to_record, {
      authorization: `Bearer ${addisonToken}`,
    });

    expect(mutations.map(({ request }) => request.operationId)).toEqual([
      masonOp('append_to_record'),
      mutationOperationId(
        'prn_participant',
        'append_to_record',
        'req_client_1',
      ),
    ]);
  });

  it.each([
    ['persist_knowledge', 'title', { title: 'Synthetic\u0000title' }],
    ['persist_knowledge', 'content', { content: 'Synthetic\ud800' }],
    [
      'persist_knowledge',
      'semantic metadata',
      { semanticMetadata: { subject: 'x\u0000' } },
    ],
    ['append_to_record', 'content', { content: 'Synthetic\udc00body' }],
    [
      'update_record',
      'patch content',
      { mutation: { mode: 'patch', patch: { content: 'x\u0000' } } },
    ],
    [
      'update_record',
      'replacement title',
      {
        mutation: {
          mode: 'replace',
          replacement: { title: '\ud800', content: 'body' },
        },
      },
    ],
  ] as const)(
    '%s rejects unstorable text in %s with a safe 400',
    async (operation, _, overrides) => {
      const { app, mutations } = await apiHarness();

      const response = await postOperation(app, operation, {
        ...validBodies[operation],
        ...overrides,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { details: { reason: 'invalid_request_body' } },
      });
      expect(mutations).toEqual([]);
    },
  );

  it('never reads a mutation body before authentication', async () => {
    const { app, mutations, authentications } = await apiHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/operations/persist_knowledge',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(validBodies.persist_knowledge),
    });

    expect(response.statusCode).toBe(401);
    expect(authentications).toEqual([]);
    expect(mutations).toEqual([]);
  });
});
