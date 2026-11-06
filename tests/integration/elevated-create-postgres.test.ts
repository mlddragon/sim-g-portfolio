import { readFileSync } from 'node:fs';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ElevationService } from '../../src/application/elevation-service.js';
import { MutationService } from '../../src/application/mutation-service.js';
import { runMigrations } from '../../src/adapters/state/postgres/migrate.js';
import { PostgresOperationalStateStore } from '../../src/adapters/state/postgres/postgres-operational-state-store.js';
import { AuthorizationEngine } from '../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../src/domain/authorization/destructive-classifier.js';
import { operationId, requestId } from '../../src/domain/identifiers.js';
import { loadExecutablePolicy } from '../../src/domain/policy/policy-loader.js';
import { CanonicalRouter } from '../../src/domain/routing/canonical-router.js';
import type { MutableKnowledgeProvider } from '../../src/ports/knowledge-provider.js';
import { FakeMutableKnowledgeProvider } from '../support/fake-knowledge-providers.js';
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
const operator = brainReadPrincipal();
const context = {
  requestId: requestId('req_postgres_elevated_create'),
  receivedAt: brainReadNow,
  clientId: 'synthetic-test-client',
};
const body = 'Synthetic durable legal-scope note';
const request = {
  operationId: operationId('op_postgres_elevated_create'),
  requestId: context.requestId,
  principalId: operator.principal.id,
  clientId: context.clientId,
  title: 'Synthetic legal-scope note',
  content: body,
  semanticMetadata: {
    recordType: 'knowledge',
    durability: 'durable',
    sensitivity: 'protected' as const,
  },
};

describe('elevated persist_knowledge with PostgreSQL', () => {
  let pool: Pool = createTestPool(connectionString);
  let notion: FakeMutableKnowledgeProvider;
  let creates = 0;
  const clock = { now: () => brainReadNow };

  const buildService = () => {
    const store = new PostgresOperationalStateStore(pool);
    const counting: MutableKnowledgeProvider = {
      provider: 'notion',
      search: (r, s) => notion.search(r, s),
      fetch: (r, s) => notion.fetch(r, s),
      create: (r, s) => {
        creates += 1;
        return notion.create(r, s);
      },
      update: (r, s) => notion.update(r, s),
      append: (r, s) => notion.append(r, s),
      trash: (r, s) => notion.trash(r, s),
      reconcile: (r, s) => notion.reconcile(r, s),
    };
    return new MutationService(
      new AuthorizationEngine(policy, clock),
      new DestructiveClassifier(),
      new CanonicalRouter(policy),
      store,
      [
        counting,
        new FakeMutableKnowledgeProvider('drive', [], {
          configuredAccess: {
            brainScopes: ['family_shared'],
            rootRefs: ['drive.family_shared'],
          },
        }),
      ],
      [
        {
          provider: 'notion',
          containerKey: 'notion.family_shared',
          scope: 'family_shared',
        },
        {
          provider: 'notion',
          containerKey: 'notion.protected',
          scope: 'legal',
        },
        {
          provider: 'drive',
          containerKey: 'drive.family_shared',
          scope: 'family_shared',
        },
      ],
      clock,
      undefined,
      new ElevationService(store, clock),
    );
  };

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    creates = 0;
    notion = new FakeMutableKnowledgeProvider('notion', [], {
      configuredAccess: {
        brainScopes: ['family_shared', 'legal'],
        rootRefs: ['notion.family_shared', 'notion.protected'],
      },
      now: () => brainReadNow,
    });
    await resetOperationalState(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('confirms a route-bound challenge issued before a restart and creates once', async () => {
    const challenged = await buildService().persistKnowledge(
      operator,
      context,
      request,
      new AbortController().signal,
    );
    expect(challenged).toMatchObject({ state: 'elevation_required' });
    if (challenged.elevation === undefined) throw new Error('missing grant');
    const grant = {
      challengeId: challenged.elevation.challengeId,
      confirmationToken: challenged.elevation.confirmationToken,
    };

    await pool.end();
    pool = createTestPool(connectionString);
    const created = await buildService().persistKnowledge(
      operator,
      context,
      { ...request, elevation: grant },
      new AbortController().signal,
    );

    expect(created).toMatchObject({
      state: 'completed',
      record: { canonicalLocation: { containerRef: 'notion.protected' } },
    });
    expect(creates).toBe(1);
    const challenge = await pool.query<{
      readonly targets: readonly string[];
      readonly consumed: boolean;
    }>(
      `SELECT frozen_target_ids AS targets, consumed_at IS NOT NULL AS consumed
       FROM elevation_challenges`,
    );
    expect(challenge.rows).toHaveLength(1);
    expect(challenge.rows[0]?.consumed).toBe(true);
    expect(challenge.rows[0]?.targets[0]).toMatch(/^brn_route_[0-9a-f]{40}$/u);
    const dump = await pool.query<{ readonly dump: string }>(
      `SELECT concat_ws('|',
         (SELECT string_agg(row_to_json(o)::text, '|') FROM operations o),
         (SELECT string_agg(row_to_json(c)::text, '|') FROM elevation_challenges c),
         (SELECT string_agg(event::text, '|') FROM audit_outbox)
       ) AS dump`,
    );
    expect(dump.rows[0]?.dump).not.toContain(body);
    expect(dump.rows[0]?.dump).not.toContain(grant.confirmationToken);
  });
});
