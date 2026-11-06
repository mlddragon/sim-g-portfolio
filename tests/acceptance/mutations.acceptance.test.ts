import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ElevationService } from '../../src/application/elevation-service.js';
import { MutationService } from '../../src/application/mutation-service.js';
import { AuthorizationEngine } from '../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../src/domain/authorization/destructive-classifier.js';
import {
  brainRecordId,
  operationId,
  providerRecordId,
} from '../../src/domain/identifiers.js';
import { loadExecutablePolicy } from '../../src/domain/policy/policy-loader.js';
import { CanonicalRouter } from '../../src/domain/routing/canonical-router.js';
import { FakeMutableKnowledgeProvider } from '../support/fake-knowledge-providers.js';
import {
  brainReadContext,
  brainReadNow,
  brainReadPrincipal,
  brainReadRecord,
  brainReadSummary,
} from '../support/brain-read-fixtures.js';
import { SyntheticMutationStore } from '../support/synthetic-mutation-store.js';

const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);
const roots = {
  notion: 'notion.family_shared',
  drive: 'drive.family_shared',
} as const;

function acceptanceService(
  unknown = false,
  protectedTarget = false,
  now: () => Date = () => brainReadNow,
) {
  const base = brainReadRecord(
    brainReadSummary('notion', 'acceptance-mutation'),
  );
  const target = {
    ...base,
    brainRecordId: brainRecordId('brn_provider_acceptance'),
    canonicalLocation: {
      provider: 'notion' as const,
      containerRef: roots.notion,
    },
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
    brainRecordId: brainRecordId('brn_acceptance_target'),
    provider: 'notion',
    providerRecordId: target.provenance.providerRecordId,
    canonicalLocation: target.canonicalLocation,
    createdAt: brainReadNow,
    updatedAt: brainReadNow,
  });
  const providers = (['notion', 'drive'] as const).map(
    (provider) =>
      new FakeMutableKnowledgeProvider(
        provider,
        provider === 'notion' ? [target] : [],
        {
          configuredAccess: {
            brainScopes: ['family_shared'],
            rootRefs: [roots[provider]],
          },
          now: () => brainReadNow,
          ...(unknown
            ? { unknownOperationIds: [operationId('op_acceptance_update')] }
            : {}),
        },
      ),
  );
  const clock = { now };
  const provider = providers.find(
    (candidate) => candidate.provider === 'notion',
  );
  if (provider === undefined)
    throw new Error('missing synthetic notion provider');
  return {
    store,
    provider,
    service: new MutationService(
      new AuthorizationEngine(policy, clock),
      new DestructiveClassifier(),
      new CanonicalRouter(policy),
      store,
      providers,
      [
        {
          provider: 'notion',
          containerKey: roots.notion,
          scope: 'family_shared',
        },
        {
          provider: 'drive',
          containerKey: roots.drive,
          scope: 'family_shared',
        },
      ],
      clock,
      undefined,
      new ElevationService(store, clock),
    ),
  };
}

const request = {
  operationId: operationId('op_acceptance_update'),
  requestId: brainReadContext('acceptance_update').requestId,
  principalId: brainReadPrincipal().principal.id,
  clientId: 'synthetic-test-client',
  brainRecordId: brainRecordId('brn_acceptance_target'),
  mutation: {
    mode: 'patch' as const,
    patch: { title: 'Synthetic accepted title' },
  },
};

describe('idempotent mutation acceptance', () => {
  it('freshly authorizes, version-guards and durably replays a Notion update', async () => {
    const { provider, service, store } = acceptanceService();
    const context = brainReadContext('acceptance_update');
    const principal = brainReadPrincipal();

    const first = await service.updateRecord(
      principal,
      context,
      request,
      new AbortController().signal,
    );
    const replay = await service.updateRecord(
      principal,
      context,
      { ...request, operationId: operationId('op_ignored_replay') },
      new AbortController().signal,
    );

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      state: 'completed',
      record: { provider: 'notion' },
    });
    await expect(
      provider.fetch(
        {
          providerRecordId: providerRecordId(
            'notion-record-acceptance-mutation',
          ),
          access: { brainScopes: ['family_shared'], rootRefs: [roots.notion] },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ title: 'Synthetic accepted title' });
    expect(store.audits.map(({ operation }) => operation.state)).toEqual([
      'EXECUTING',
      'COMPLETED',
    ]);
  });

  it('executes a protected parent update only after one-time explicit elevation', async () => {
    const { provider, service, store } = acceptanceService(false, true);
    const context = brainReadContext('acceptance_update');
    const principal = brainReadPrincipal();

    const challenged = await service.updateRecord(
      principal,
      context,
      request,
      new AbortController().signal,
    );
    expect(challenged).toMatchObject({ state: 'elevation_required' });
    if (challenged.elevation === undefined) {
      throw new Error('missing synthetic elevation grant');
    }
    const elevation = {
      challengeId: challenged.elevation.challengeId,
      confirmationToken: challenged.elevation.confirmationToken,
    };

    await expect(
      service.updateRecord(
        principal,
        context,
        { ...request, elevation },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    await expect(
      service.updateRecord(
        principal,
        context,
        { ...request, elevation },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    await expect(
      provider.fetch(
        {
          providerRecordId: providerRecordId(
            'notion-record-acceptance-mutation',
          ),
          access: { brainScopes: ['family_shared'], rootRefs: [roots.notion] },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ title: 'Synthetic accepted title' });
    expect(store.audits.map(({ audit }) => audit.reasonCode)).toEqual([
      'explicit_elevation_required',
      'elevated_action_confirmed',
      'provider_mutation_completed',
    ]);
  });

  it('persists routed Family Shared knowledge once and replays its stable alias', async () => {
    const { service, store } = acceptanceService();
    const participant = brainReadPrincipal('family_participant');
    const context = brainReadContext('acceptance_persist');
    const persist = {
      operationId: operationId('op_acceptance_persist'),
      requestId: context.requestId,
      principalId: participant.principal.id,
      clientId: 'synthetic-test-client',
      title: 'Synthetic accepted chore chart',
      content: 'Synthetic accepted chore chart body',
      semanticMetadata: {
        recordType: 'knowledge',
        durability: 'durable',
        sensitivity: 'family_shared' as const,
      },
    };

    const created = await service.persistKnowledge(
      participant,
      context,
      persist,
      new AbortController().signal,
    );
    const replay = await service.persistKnowledge(
      participant,
      context,
      persist,
      new AbortController().signal,
    );

    expect(created).toMatchObject({
      state: 'completed',
      record: {
        provider: 'notion',
        canonicalLocation: { containerRef: roots.notion },
      },
    });
    expect(created.brainRecordId).toMatch(/^brn_notion_/u);
    expect(replay).toEqual(created);
    expect(store.aliasCount()).toBe(2);
    await expect(
      service.persistKnowledge(
        participant,
        brainReadContext('acceptance_parent_only'),
        {
          ...persist,
          operationId: operationId('op_acceptance_parent_only'),
          requestId: brainReadContext('acceptance_parent_only').requestId,
          semanticMetadata: {
            ...persist.semanticMetadata,
            sensitivity: 'parent_and_stewardship' as const,
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(
      await store.getOperation(operationId('op_acceptance_parent_only')),
    ).toMatchObject({ state: 'FAILED', errorCode: 'unauthorized' });
    expect(store.aliasCount()).toBe(2);
  });

  it('appends to an existing record once without replacing its body', async () => {
    const { provider, service } = acceptanceService();
    const context = brainReadContext('acceptance_append');
    const principal = brainReadPrincipal();
    const append = {
      operationId: operationId('op_acceptance_append'),
      requestId: context.requestId,
      principalId: principal.principal.id,
      clientId: 'synthetic-test-client',
      brainRecordId: brainRecordId('brn_acceptance_target'),
      content: '\nSynthetic accepted addendum.',
    };

    const first = await service.appendToRecord(
      principal,
      context,
      append,
      new AbortController().signal,
    );
    await expect(
      service.appendToRecord(
        principal,
        context,
        append,
        new AbortController().signal,
      ),
    ).resolves.toEqual(first);
    expect(first).toMatchObject({ state: 'completed' });
    await expect(
      provider.fetch(
        {
          providerRecordId: providerRecordId(
            'notion-record-acceptance-mutation',
          ),
          access: { brainScopes: ['family_shared'], rootRefs: [roots.notion] },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      content: 'Synthetic full body.\nSynthetic accepted addendum.',
    });
  });

  it('lets the owner recover a stranded update from its provider marker without writing again', async () => {
    let now = brainReadNow;
    const { service, store, provider } = acceptanceService(
      false,
      false,
      () => now,
    );
    const principal = brainReadPrincipal();
    store.seedPrincipal(principal.principal);
    const context = brainReadContext('acceptance_update');
    store.failBeforeCommitStates.add('COMPLETED');
    await expect(
      service.updateRecord(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(Error);
    now = new Date(brainReadNow.getTime() + 15 * 60_000);

    await expect(
      service.recoverStrandedExecution(
        principal,
        brainReadContext('acceptance_recover'),
        {
          operationId: operationId('op_acceptance_update'),
          staleAfterMs: 15 * 60_000,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ disposition: 'completed' });
    await expect(
      service.updateRecord(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    await expect(
      provider.fetch(
        {
          providerRecordId: providerRecordId(
            'notion-record-acceptance-mutation',
          ),
          access: { brainScopes: ['family_shared'], rootRefs: [roots.notion] },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ title: 'Synthetic accepted title' });
  });

  it('reconciles an uncertain provider result before replaying any write', async () => {
    const { service, store } = acceptanceService(true);
    const context = brainReadContext('acceptance_update');
    const principal = brainReadPrincipal();

    await expect(
      service.updateRecord(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });
    await expect(
      service.updateRecord(
        principal,
        context,
        request,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(store.reconciliationAttempts).toHaveLength(1);
  });
});
