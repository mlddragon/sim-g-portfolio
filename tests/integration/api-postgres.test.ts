import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import type { Pool } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { composeGateway } from '../../src/bootstrap.js';
import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { PostgresOperationalStateStore } from '../../src/adapters/state/postgres/postgres-operational-state-store.js';
import { DomainError } from '../../src/domain/errors.js';
import { providerRecordId } from '../../src/domain/identifiers.js';
import { loadExecutablePolicy } from '../../src/domain/policy/policy-loader.js';
import type { IdentityProvider } from '../../src/ports/identity-provider.js';
import {
  FakeFetchableKnowledgeProvider,
  FakeMutableKnowledgeProvider,
} from '../support/fake-knowledge-providers.js';
import {
  brainReadNow,
  brainReadRecord,
  brainReadSummary,
} from '../support/brain-read-fixtures.js';
import {
  createTestPool,
  queryRows,
  requireTestDatabaseUrl,
  resetOperationalState,
} from '../support/postgres.js';

const connectionString = requireTestDatabaseUrl();
const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);
const issuer = 'https://accounts.google.com';
const tokens: Record<string, string> = {
  'synthetic.operator-token': 'synthetic-subject-operator',
  'synthetic.participant-token': 'synthetic-subject-participant',
  'synthetic.unbound-token': 'synthetic-subject-unbound',
};
const confidential = 'Synthetic confidential HTTP note body';
const composedSummary = brainReadSummary('notion', 'composed');
const searchable = brainReadRecord({
  ...composedSummary,
  canonicalLocation: {
    ...composedSummary.canonicalLocation,
    containerRef: 'notion.family_shared',
  },
});

const identity: IdentityProvider = {
  verify: (token) => {
    const subject = tokens[token];
    if (subject === undefined) {
      return Promise.reject(
        new DomainError('unauthenticated', false, {
          reason: 'identity_verification_failed',
        }),
      );
    }
    return Promise.resolve({
      issuer,
      externalSubject: subject,
      email: `${subject}@example.invalid`,
      clientId: 'synthetic-audience',
      authenticatedAt: brainReadNow,
    });
  },
};

describe('composed gateway over PostgreSQL', () => {
  const pool: Pool = createTestPool(connectionString);
  const apps: Awaited<ReturnType<typeof composeGateway>>[] = [];
  const clock = { now: () => brainReadNow };

  async function gateway(statePool: Pool = pool) {
    const providers = {
      notion: new FakeMutableKnowledgeProvider('notion', [searchable], {
        configuredAccess: {
          brainScopes: ['family_shared', 'parent_and_stewardship', 'legal'],
          rootRefs: Object.values(policy.routing.containers.notion),
        },
        now: () => brainReadNow,
      }),
      drive: new FakeMutableKnowledgeProvider('drive', [], {
        configuredAccess: {
          brainScopes: ['family_shared'],
          rootRefs: Object.values(policy.routing.containers.drive),
        },
        now: () => brainReadNow,
      }),
      github: new FakeFetchableKnowledgeProvider('github', [], {
        configuredAccess: { brainScopes: [], rootRefs: [] },
      }),
    };
    const chunks: string[] = [];
    const logStream = new PassThrough();
    logStream.on('data', (chunk: Buffer) =>
      chunks.push(chunk.toString('utf8')),
    );
    const app = await composeGateway(
      {
        store: new PostgresOperationalStateStore(statePool),
        identity,
        providers,
        surfaces: [
          {
            provider: 'notion',
            containerKey: 'notion.family_shared',
            scope: 'family_shared',
          },
          {
            provider: 'drive',
            containerKey: 'drive.family_shared',
            scope: 'family_shared',
          },
          {
            provider: 'notion',
            containerKey: 'notion.parent_and_stewardship',
            scope: 'parent_and_stewardship',
          },
          {
            provider: 'notion',
            containerKey: 'notion.protected',
            scope: 'legal',
          },
        ],
        approvalProjection: {
          findByApprovalRequestId: () => Promise.resolve(null),
          create: () =>
            Promise.resolve({
              providerRecordId: providerRecordId(
                '40000000-0000-4000-8000-000000000091',
              ),
            }),
          update: () => Promise.resolve(),
        },
        policy,
        clock,
      },
      { logStream },
    );
    apps.push(app);
    return { app, providers, logs: () => chunks.join('') };
  }

  const post = (
    app: Awaited<ReturnType<typeof composeGateway>>,
    operation: string,
    body: unknown,
    token = 'synthetic.operator-token',
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/operations/${operation}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(body),
    });

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await resetOperationalState(pool);
    await pool.query(
      `INSERT INTO identity_bindings (id, principal_id, issuer, external_subject, email)
       VALUES
         ('idb_operator', 'prn_operator', $1, 'synthetic-subject-operator', 'operator@example.invalid'),
         ('idb_participant', 'prn_participant', $1, 'synthetic-subject-participant', 'participant@example.invalid')`,
      [issuer],
    );
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('authenticates a bound identity and searches through the audited boundary', async () => {
    const { app } = await gateway();

    const response = await post(app, 'search_brain', {
      query: 'Synthetic composed',
      limit: 5,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      results: [{ title: 'Synthetic composed' }],
    });
    const events = await queryRows<{
      event: { eventType: string; principalId: string };
    }>(pool, `SELECT event FROM audit_outbox ORDER BY id`);
    expect(
      events.map(({ event }) => [event.eventType, event.principalId]),
    ).toContainEqual(['brain.request.completed', 'prn_operator']);
  });

  it.each([
    [
      'an unbound identity',
      'synthetic.unbound-token',
      'identity_not_authorized',
    ],
    ['an invalid token', 'synthetic.invalid', 'identity_verification_failed'],
  ])('rejects %s with 401 and records nothing', async (_, token, reason) => {
    const { app } = await gateway();

    const response = await post(
      app,
      'search_brain',
      { query: 'q', limit: 1 },
      token,
    );

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'unauthenticated', details: { reason } },
    });
    const operations = await queryRows<{ count: string }>(
      pool,
      'SELECT count(*)::text AS count FROM operations',
    );
    expect(operations[0]?.count).toBe('0');
  });

  it('answers a retryable 503, never a 500, when PostgreSQL is unreachable', async () => {
    // Nothing listens on this loopback port, like a database mid-restart.
    const unreachable = createTestPool(
      'postgresql://gateway_test:synthetic@127.0.0.1:1/family_brain_gateway_test',
    );
    try {
      const { app } = await gateway(unreachable);

      const response = await post(app, 'search_brain', {
        query: 'Synthetic composed',
        limit: 5,
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          code: 'provider_unavailable',
          retryable: true,
          details: { reason: 'principal_state_unavailable' },
        },
      });
    } finally {
      await unreachable.end();
    }
  });

  it('rejects a disabled binding even with a valid token', async () => {
    await pool.query(
      `UPDATE identity_bindings SET enabled = false WHERE id = 'idb_operator'`,
    );
    const { app } = await gateway();

    const response = await post(app, 'search_brain', { query: 'q', limit: 1 });

    expect(response.statusCode).toBe(401);
  });

  it('persists durably once and replays a retry from PostgreSQL', async () => {
    const { app, logs } = await gateway();
    const body = {
      requestId: 'req_client_composed_persist',
      title: 'Synthetic composed title',
      content: confidential,
      semanticMetadata: {
        subject: 'synthetic composed procedure',
        recordType: 'knowledge',
        durability: 'durable',
        sensitivity: 'family_shared',
      },
    };

    const first = await post(app, 'persist_knowledge', body);
    const retry = await post(app, 'persist_knowledge', body);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ state: 'completed' });
    expect(retry.json()).toEqual(first.json());
    const rows = await queryRows<{
      principal_id: string;
      request_id: string;
      state: string;
    }>(pool, 'SELECT principal_id, request_id, state FROM operations');
    expect(rows).toEqual([
      {
        principal_id: 'prn_operator',
        request_id: 'req_client_composed_persist',
        state: 'COMPLETED',
      },
    ]);
    const outbox = await queryRows<{ event: unknown }>(
      pool,
      'SELECT event FROM audit_outbox',
    );
    expect(JSON.stringify(outbox)).not.toContain(confidential);
    expect(logs()).not.toContain(confidential);
  });

  it('enforces role policy for Participant against the real store', async () => {
    const { app } = await gateway();

    const response = await post(
      app,
      'persist_knowledge',
      {
        requestId: 'req_participant_parent_only',
        title: 'Synthetic parent title',
        content: 'Synthetic parent body',
        semanticMetadata: {
          subject: 'synthetic parent procedure',
          recordType: 'knowledge',
          durability: 'durable',
          sensitivity: 'parent_and_stewardship',
        },
      },
      'synthetic.participant-token',
    );

    // A policy denial of a mutation is a recorded, terminal `failed` state.
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ state: 'failed' });
    const rows = await queryRows<{ principal_id: string; state: string }>(
      pool,
      'SELECT principal_id, state FROM operations',
    );
    expect(rows).toEqual([
      { principal_id: 'prn_participant', state: 'FAILED' },
    ]);
    expect(response.body).not.toContain('Synthetic parent body');
  });
});
