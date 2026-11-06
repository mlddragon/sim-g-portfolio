import { readFileSync } from 'node:fs';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApprovalService } from '../../src/application/approval-service.js';
import { AuditedBrainOperations } from '../../src/application/audited-brain-operations.js';
import { BrainQueryService } from '../../src/application/brain-query-service.js';
import { MutationService } from '../../src/application/mutation-service.js';
import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { PostgresOperationalStateStore } from '../../src/adapters/state/postgres/postgres-operational-state-store.js';
import { AuthorizationEngine } from '../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../src/domain/authorization/destructive-classifier.js';
import {
  operationId,
  principalId,
  providerRecordId,
  requestId,
} from '../../src/domain/identifiers.js';
import { loadExecutablePolicy } from '../../src/domain/policy/policy-loader.js';
import { CanonicalRouter } from '../../src/domain/routing/canonical-router.js';
import {
  FakeFetchableKnowledgeProvider,
  FakeMutableKnowledgeProvider,
} from '../support/fake-knowledge-providers.js';
import {
  brainReadNow,
  brainReadPrincipal,
} from '../support/brain-read-fixtures.js';
import {
  createTestPool,
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
const surfaces = [
  {
    provider: 'notion' as const,
    containerKey: 'notion.family_shared',
    scope: 'family_shared' as const,
  },
  {
    provider: 'drive' as const,
    containerKey: 'drive.family_shared',
    scope: 'family_shared' as const,
  },
];
const confidential = 'Synthetic confidential outbox text';

describe('AuditedBrainOperations with the PostgreSQL outbox', () => {
  const pool: Pool = createTestPool(connectionString);
  const clock = { now: () => brainReadNow };

  const build = () => {
    const store = new PostgresOperationalStateStore(pool);
    const providers = (['notion', 'drive'] as const).map(
      (provider) =>
        new FakeMutableKnowledgeProvider(provider, [], {
          configuredAccess: {
            brainScopes: ['family_shared'],
            rootRefs: [`${provider}.family_shared`],
          },
          now: () => brainReadNow,
        }),
    );
    const authorization = new AuthorizationEngine(policy, clock);
    const mutations = new MutationService(
      authorization,
      new DestructiveClassifier(),
      new CanonicalRouter(policy),
      store,
      providers,
      surfaces,
      clock,
    );
    const projection = {
      findByApprovalRequestId: () => Promise.resolve(null),
      create: () =>
        Promise.resolve({
          providerRecordId: providerRecordId(
            '40000000-0000-4000-8000-000000000071',
          ),
        }),
      update: () => Promise.resolve(),
    };
    return {
      store,
      audited: new AuditedBrainOperations(
        {
          query: new BrainQueryService(
            authorization,
            store,
            [
              ...providers,
              new FakeFetchableKnowledgeProvider('github', [], {
                configuredAccess: { brainScopes: [], rootRefs: [] },
              }),
            ],
            surfaces,
            {
              clock,
            },
          ),
          mutations,
          approvals: new ApprovalService(
            authorization,
            store,
            projection,
            mutations,
            clock,
          ),
        },
        store,
        clock,
      ),
    };
  };

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await resetOperationalState(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('durably records completed and rejected requests as metadata only', async () => {
    const { audited, store } = build();
    const operator = brainReadPrincipal();
    const participant = brainReadPrincipal('family_participant');
    const context = {
      requestId: requestId('req_audited_persist'),
      receivedAt: brainReadNow,
      clientId: 'synthetic-test-client',
    };

    await expect(
      audited.persistKnowledge(
        operator,
        context,
        {
          operationId: operationId('op_audited_persist'),
          requestId: context.requestId,
          principalId: operator.principal.id,
          clientId: context.clientId,
          title: 'Synthetic audited note',
          content: confidential,
          semanticMetadata: {
            subject: confidential,
            recordType: 'knowledge',
            durability: 'durable',
            sensitivity: 'family_shared',
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    await expect(
      audited.listApprovals(
        participant,
        {
          requestId: requestId('req_audited_list'),
          receivedAt: brainReadNow,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });

    const events = (await store.listPendingAuditEvents(50)).map(
      ({ event }) => event,
    );
    expect(
      events
        .filter(({ eventType }) => eventType.startsWith('brain.request.'))
        .map(({ eventType, operation, outcome, principalId: actor }) => [
          eventType,
          operation,
          outcome,
          actor,
        ]),
    ).toEqual([
      [
        'brain.request.completed',
        'persist_knowledge',
        'COMPLETED',
        principalId('prn_operator'),
      ],
      [
        'brain.request.rejected',
        'list_approvals',
        'DENIED',
        principalId('prn_participant'),
      ],
    ]);
    expect(JSON.stringify(events)).not.toContain(confidential);
  });
});
