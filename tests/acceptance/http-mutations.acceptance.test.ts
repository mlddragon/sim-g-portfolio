import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { mutationOperationId } from '../../src/api/schemas/mutations.js';
import { AuditedBrainOperations } from '../../src/application/audited-brain-operations.js';
import { ElevationService } from '../../src/application/elevation-service.js';
import { MutationService } from '../../src/application/mutation-service.js';
import { AuthorizationEngine } from '../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../src/domain/authorization/destructive-classifier.js';
import {
  brainRecordId,
  providerRecordId,
} from '../../src/domain/identifiers.js';
import { loadExecutablePolicy } from '../../src/domain/policy/policy-loader.js';
import { CanonicalRouter } from '../../src/domain/routing/canonical-router.js';
import {
  addisonToken,
  apiHarness,
  postOperation,
} from '../support/api-harness.js';
import {
  brainReadNow,
  brainReadRecord,
  brainReadSummary,
} from '../support/brain-read-fixtures.js';
import { FakeMutableKnowledgeProvider } from '../support/fake-knowledge-providers.js';
import { SyntheticMutationStore } from '../support/synthetic-mutation-store.js';

const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);
const root = 'notion.family_shared';
const access = { brainScopes: ['family_shared' as const], rootRefs: [root] };

async function httpComposition(protectedTarget = false) {
  const base = brainReadRecord(brainReadSummary('notion', 'http-mutation'));
  const target = {
    ...base,
    canonicalLocation: { provider: 'notion' as const, containerRef: root },
    ...(protectedTarget
      ? {
          policy: {
            ...base.policy,
            sensitivity: 'protected' as const,
            protectedClass: 'protected' as const,
          },
        }
      : {}),
  };
  const store = new SyntheticMutationStore();
  store.seedAlias({
    brainRecordId: brainRecordId('brn_http_target'),
    provider: 'notion',
    providerRecordId: target.provenance.providerRecordId,
    canonicalLocation: target.canonicalLocation,
    createdAt: brainReadNow,
    updatedAt: brainReadNow,
  });
  const provider = new FakeMutableKnowledgeProvider('notion', [target], {
    configuredAccess: access,
    now: () => brainReadNow,
  });
  let updates = 0;
  const counted = {
    provider: provider.provider,
    search: provider.search.bind(provider),
    fetch: provider.fetch.bind(provider),
    create: provider.create.bind(provider),
    update: (
      ...args: Parameters<FakeMutableKnowledgeProvider['update']>
    ): ReturnType<FakeMutableKnowledgeProvider['update']> => {
      updates += 1;
      return provider.update(...args);
    },
    append: provider.append.bind(provider),
    trash: provider.trash.bind(provider),
    reconcile: provider.reconcile.bind(provider),
  };
  const clock = { now: () => brainReadNow };
  const mutations = new MutationService(
    new AuthorizationEngine(policy, clock),
    new DestructiveClassifier(),
    new CanonicalRouter(policy),
    store,
    [
      counted,
      new FakeMutableKnowledgeProvider('drive', [], {
        configuredAccess: {
          brainScopes: ['family_shared'],
          rootRefs: ['drive.family_shared'],
        },
        now: () => brainReadNow,
      }),
    ],
    [
      { provider: 'notion', containerKey: root, scope: 'family_shared' },
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
  const audited = new AuditedBrainOperations(
    {
      query: {
        searchBrain: () => Promise.reject(new Error('unused')),
        fetchRecord: () => Promise.reject(new Error('unused')),
      },
      mutations,
      approvals: {
        listApprovals: () => Promise.reject(new Error('unused')),
        resolveApproval: () => Promise.reject(new Error('unused')),
      },
    },
    store,
    clock,
  );
  // Bind the audited boundary's methods; the harness merges per method.
  const harness = await apiHarness({
    operations: {
      persistKnowledge: audited.persistKnowledge.bind(audited),
      updateRecord: audited.updateRecord.bind(audited),
      appendToRecord: audited.appendToRecord.bind(audited),
      deleteRecord: audited.deleteRecord.bind(audited),
    },
    clock,
  });
  return { ...harness, store, provider, updates: () => updates };
}

const update = {
  requestId: 'req_client_http_update',
  brainRecordId: 'brn_http_target',
  mutation: { mode: 'patch', patch: { title: 'Synthetic HTTP title' } },
};

describe('HTTP mutation acceptance', () => {
  it('replays a retried update over HTTP without a second provider write', async () => {
    const { app, provider, updates } = await httpComposition();

    const first = await postOperation(app, 'update_record', update);
    const retry = await postOperation(app, 'update_record', update);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      operationId: mutationOperationId(
        'prn_operator',
        'update_record',
        'req_client_http_update',
      ),
      state: 'completed',
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(retry.headers['x-request-id']).not.toBe(
      first.headers['x-request-id'],
    );
    expect(updates()).toBe(1);
    await expect(
      provider.fetch(
        {
          providerRecordId: providerRecordId('notion-record-http-mutation'),
          access,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ title: 'Synthetic HTTP title' });
  });

  it('rejects reuse of a request ID for different content as a 409', async () => {
    const { app, updates } = await httpComposition();

    await postOperation(app, 'update_record', update);
    const conflicting = await postOperation(app, 'update_record', {
      ...update,
      mutation: { mode: 'patch', patch: { title: 'Synthetic other title' } },
    });

    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({
      error: { code: 'idempotency_conflict' },
    });
    expect(conflicting.body).not.toContain('Synthetic other title');
    expect(updates()).toBe(1);
  });

  it('completes a protected parent update only after one-time HTTP elevation', async () => {
    const { app, updates, logs } = await httpComposition(true);

    const challenged = await postOperation(app, 'update_record', update);
    expect(challenged.statusCode).toBe(202);
    const grant = challenged.json<{
      state: string;
      elevation: { challengeId: string; confirmationToken: string };
    }>();
    expect(grant.state).toBe('elevation_required');
    expect(updates()).toBe(0);

    const elevation = {
      challengeId: grant.elevation.challengeId,
      confirmationToken: grant.elevation.confirmationToken,
    };
    const confirmed = await postOperation(app, 'update_record', {
      ...update,
      elevation,
    });
    const reused = await postOperation(app, 'update_record', {
      ...update,
      elevation,
    });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ state: 'completed' });
    expect(reused.json()).toEqual(confirmed.json());
    expect(updates()).toBe(1);
    expect(JSON.stringify(logs())).not.toContain(elevation.confirmationToken);
  });

  it('never lets another principal claim or disturb an operation by reusing its request ID', async () => {
    const { app, updates } = await httpComposition();

    const operator = await postOperation(app, 'update_record', update);
    const participant = await postOperation(app, 'update_record', update, {
      authorization: `Bearer ${addisonToken}`,
    });
    const masonRetry = await postOperation(app, 'update_record', update);

    expect(participant.json<{ operationId: string }>().operationId).not.toBe(
      operator.json<{ operationId: string }>().operationId,
    );
    // Participant's routine Family Shared patch is her own separate operation.
    expect(participant.json()).toMatchObject({ state: 'completed' });
    expect(masonRetry.json()).toEqual(operator.json());
    expect(updates()).toBe(2);
  });

  it('records the client request ID in the audit trail', async () => {
    const { app, store } = await httpComposition();

    await postOperation(app, 'update_record', update);

    expect(
      store.auditEvents.map((event) => [event.eventType, event.requestId]),
    ).toContainEqual(['brain.request.completed', 'req_client_http_update']);
  });
});
