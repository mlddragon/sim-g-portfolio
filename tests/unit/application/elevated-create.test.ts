import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  containerRecordPolicy,
  registeredSurfaces,
} from '../../../src/domain/policy/container-policy.js';
import type { RecordPolicyMetadata } from '../../../src/domain/records.js';
import { ElevationService } from '../../../src/application/elevation-service.js';
import { MutationService } from '../../../src/application/mutation-service.js';
import type { RegisteredKnowledgeSurface } from '../../../src/domain/authorization/authorization-engine.js';
import { AuthorizationEngine } from '../../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../../src/domain/authorization/destructive-classifier.js';
import {
  elevationChallengeId,
  operationId,
  requestId,
} from '../../../src/domain/identifiers.js';
import type {
  MutationResponse,
  PersistKnowledgeRequest,
  SemanticMetadata,
} from '../../../src/domain/operations.js';
import {
  loadExecutablePolicy,
  type ExecutablePolicy,
} from '../../../src/domain/policy/policy-loader.js';
import type { AuthenticatedPrincipal } from '../../../src/domain/principal.js';
import { CanonicalRouter } from '../../../src/domain/routing/canonical-router.js';
import type { MutableKnowledgeProvider } from '../../../src/ports/knowledge-provider.js';
import { brainReadPrincipal } from '../../support/brain-read-fixtures.js';
import { FakeMutableKnowledgeProvider } from '../../support/fake-knowledge-providers.js';
import { SyntheticMutationStore } from '../../support/synthetic-mutation-store.js';

const start = new Date('2043-01-14T15:16:17.000Z');
const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);
// Synthetic registrations: `protected` sensitivity routes to the legal scope and
// `restricted` routes to the governance control plane.
const surfaces: readonly RegisteredKnowledgeSurface[] = [
  {
    provider: 'notion',
    containerKey: 'notion.family_shared',
    scope: 'family_shared',
  },
  { provider: 'notion', containerKey: 'notion.protected', scope: 'legal' },
  {
    provider: 'notion',
    containerKey: 'notion.restricted',
    scope: 'governance',
  },
  {
    provider: 'drive',
    containerKey: 'drive.family_shared',
    scope: 'family_shared',
  },
];
const legalMetadata: SemanticMetadata = {
  subject: 'synthetic lease renewal',
  recordType: 'knowledge',
  durability: 'durable',
  sensitivity: 'protected',
};
const body = 'Synthetic confidential lease renewal note';

function request(
  principal: AuthenticatedPrincipal,
  overrides: Partial<PersistKnowledgeRequest> = {},
): PersistKnowledgeRequest {
  return {
    operationId: operationId(`op_${principal.principal.key}_create`),
    requestId: requestId(`req_${principal.principal.key}_create`),
    principalId: principal.principal.id,
    clientId: 'synthetic-client',
    title: 'Synthetic lease renewal',
    content: body,
    semanticMetadata: legalMetadata,
    ...overrides,
  };
}

function context(principal: AuthenticatedPrincipal) {
  return {
    requestId: requestId(`req_${principal.principal.key}_create`),
    receivedAt: start,
    clientId: 'synthetic-client',
  };
}

function setup(
  options: { readonly unknownOperationIds?: readonly string[] } = {},
) {
  let now = start;
  const clock = { now: () => now };
  const store = new SyntheticMutationStore();
  const calls = {
    create: 0,
    reconcile: 0,
    policies: [] as RecordPolicyMetadata[],
  };
  let notionBase: FakeMutableKnowledgeProvider | undefined;
  const providers: MutableKnowledgeProvider[] = (
    ['notion', 'drive'] as const
  ).map((provider) => {
    const base = new FakeMutableKnowledgeProvider(provider, [], {
      configuredAccess: {
        brainScopes: ['family_shared', 'legal', 'governance'],
        rootRefs: Object.values(policy.routing.containers[provider]),
      },
      now: () => now,
      ...(options.unknownOperationIds === undefined
        ? {}
        : {
            unknownOperationIds: options.unknownOperationIds.map((id) =>
              operationId(id),
            ),
          }),
    });
    if (provider === 'notion') notionBase = base;
    return {
      provider: base.provider,
      search: base.search.bind(base),
      fetch: base.fetch.bind(base),
      create: (createRequest, signal) => {
        calls.create += 1;
        calls.policies.push(createRequest.policy);
        return base.create(createRequest, signal);
      },
      update: base.update.bind(base),
      append: base.append.bind(base),
      trash: base.trash.bind(base),
      reconcile: (reconcileRequest, signal) => {
        calls.reconcile += 1;
        return base.reconcile(reconcileRequest, signal);
      },
    };
  });
  let generated = 0;
  const makeService = (
    selectedPolicy: ExecutablePolicy = policy,
    selectedSurfaces: readonly RegisteredKnowledgeSurface[] = surfaces,
  ) =>
    new MutationService(
      new AuthorizationEngine(selectedPolicy, clock),
      new DestructiveClassifier(),
      new CanonicalRouter(selectedPolicy),
      store,
      providers,
      selectedSurfaces,
      clock,
      undefined,
      new ElevationService(store, clock, {
        challengeId: () => {
          generated += 1;
          return elevationChallengeId(`elv_create_${String(generated)}`);
        },
        confirmationToken: () =>
          `synthetic-create-token-${String(generated)}-${'c'.repeat(32)}`,
      }),
    );
  const records = async () => {
    if (notionBase === undefined) throw new Error('missing synthetic notion');
    return (
      await notionBase.search(
        {
          query: 'lease',
          limit: 10,
          access: {
            brainScopes: ['family_shared', 'legal', 'governance'],
            rootRefs: Object.values(policy.routing.containers.notion),
          },
        },
        new AbortController().signal,
      )
    ).records;
  };
  const operator = brainReadPrincipal();
  store.seedPrincipal(operator.principal);
  return {
    store,
    calls,
    operator,
    service: makeService(),
    makeService,
    records,
    advance: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

const signal = () => new AbortController().signal;

function grantOf(response: MutationResponse) {
  if (response.elevation === undefined) {
    throw new Error('missing synthetic elevation grant');
  }
  return {
    challengeId: response.elevation.challengeId,
    confirmationToken: response.elevation.confirmationToken,
  };
}

describe('MutationService elevated persist_knowledge', () => {
  it('challenges a legal-scope create, then creates exactly once after confirmation', async () => {
    const harness = setup();
    const { operator } = harness;

    const challenged = await harness.service.persistKnowledge(
      operator,
      context(operator),
      request(operator),
      signal(),
    );
    expect(challenged).toMatchObject({
      operationId: operationId('op_operator_create'),
      state: 'elevation_required',
      elevation: { expiresAt: new Date(start.getTime() + 5 * 60_000) },
    });
    expect(harness.calls.create).toBe(0);
    const pending = await harness.store.getOperation(
      operationId('op_operator_create'),
    );
    expect(pending).toMatchObject({ state: 'ELEVATION_PENDING' });
    expect(pending?.mutationPayload).toBeUndefined();
    const [challenge] = harness.store.elevationChallenges();
    expect(challenge?.frozenTargetIds).toHaveLength(1);
    expect(String(challenge?.frozenTargetIds[0])).toMatch(/^brn_route_/u);

    const created = await harness.service.persistKnowledge(
      operator,
      context(operator),
      request(operator, { elevation: grantOf(challenged) }),
      signal(),
    );

    expect(created).toMatchObject({
      state: 'completed',
      record: {
        provider: 'notion',
        canonicalLocation: { containerRef: 'notion.protected' },
      },
    });
    expect(created.brainRecordId).toMatch(/^brn_notion_/u);
    expect(harness.calls.create).toBe(1);
    expect(await harness.records()).toMatchObject([
      { policy: { scope: 'legal', protectedClass: 'none' } },
    ]);
    expect(harness.store.audits.map(({ audit }) => audit.reasonCode)).toEqual([
      'explicit_elevation_required',
      'elevated_action_confirmed',
      'provider_mutation_completed',
    ]);
    expect(
      JSON.stringify([
        harness.store.audits.map(({ audit }) => audit),
        harness.store.auditEvents,
      ]),
    ).not.toContain(body);

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator, { elevation: grantOf(challenged) }),
        signal(),
      ),
    ).resolves.toEqual(created);
    expect(harness.calls.create).toBe(1);
  });

  it('creates in the protected legal container with the policy the root carries', async () => {
    const harness = setup();
    const service = harness.makeService(policy, registeredSurfaces(policy));
    const { operator } = harness;

    const challenged = await service.persistKnowledge(
      operator,
      context(operator),
      request(operator),
      signal(),
    );
    expect(challenged).toMatchObject({ state: 'elevation_required' });
    const created = await service.persistKnowledge(
      operator,
      context(operator),
      request(operator, { elevation: grantOf(challenged) }),
      signal(),
    );

    expect(created).toMatchObject({
      state: 'completed',
      record: { canonicalLocation: { containerRef: 'notion.protected' } },
    });
    // Providers require the request policy to equal the governed root's.
    expect(harness.calls.policies).toEqual([
      containerRecordPolicy(policy, 'notion.protected'),
    ]);
  });

  it('rejects a forged token without creating, then accepts the real one', async () => {
    const harness = setup();
    const { operator } = harness;
    const grant = grantOf(
      await harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator),
        signal(),
      ),
    );

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator, {
          elevation: {
            ...grant,
            confirmationToken: `forged-${'x'.repeat(40)}`,
          },
        }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'elevation_required' });
    expect(harness.calls.create).toBe(0);
    await expect(
      harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator, { elevation: grant }),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
  });

  it('supersedes an earlier challenge when the pending create is replayed', async () => {
    const harness = setup();
    const { operator } = harness;
    const first = grantOf(
      await harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator),
        signal(),
      ),
    );
    const second = grantOf(
      await harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator),
        signal(),
      ),
    );

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator, { elevation: first }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'elevation_required' });
    await expect(
      harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator, { elevation: second }),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls.create).toBe(1);
  });

  it('rejects an expired challenge', async () => {
    const harness = setup();
    const { operator } = harness;
    const grant = grantOf(
      await harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator),
        signal(),
      ),
    );
    harness.advance(5 * 60_000 + 1);

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator, { elevation: grant }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'elevation_required' });
    expect(harness.calls.create).toBe(0);
  });

  it('rejects a confirmation that resends different content', async () => {
    const harness = setup();
    const { operator } = harness;
    const grant = grantOf(
      await harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator),
        signal(),
      ),
    );

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator, {
          content: 'Synthetic swapped body',
          elevation: grant,
        }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(harness.store.elevationChallenges()[0]?.consumedAt).toBeUndefined();
  });

  it.each([
    [
      'a canonical route remap',
      (harness: ReturnType<typeof setup>) =>
        harness.makeService({
          ...policy,
          routing: {
            ...policy.routing,
            containers: {
              ...policy.routing.containers,
              notion: {
                ...policy.routing.containers.notion,
                protected: 'notion.family_shared',
              },
            },
          },
        }),
    ],
    [
      'an executable policy version change',
      (harness: ReturnType<typeof setup>) =>
        harness.makeService({
          ...policy,
          version: 'family-brain-v1.1.1-synthetic',
        }),
    ],
    [
      'a scope re-registration',
      (harness: ReturnType<typeof setup>) =>
        harness.makeService(policy, [
          ...surfaces.filter(
            ({ containerKey }) => containerKey !== 'notion.protected',
          ),
          {
            provider: 'notion',
            containerKey: 'notion.protected',
            scope: 'parent_and_stewardship',
          },
        ]),
    ],
  ])('supersedes a pending elevated create after %s', async (_, changed) => {
    const harness = setup();
    const { operator } = harness;
    const grant = grantOf(
      await harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator),
        signal(),
      ),
    );

    await expect(
      changed(harness).persistKnowledge(
        operator,
        context(operator),
        request(operator, { elevation: grant }),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(
      (await harness.store.getOperation(operationId('op_operator_create')))
        ?.state,
    ).toBe('SUPERSEDED');
    expect(harness.calls.create).toBe(0);
    expect(harness.store.elevationChallenges()[0]?.consumedAt).toBeUndefined();
  });

  it('fails closed after the creator loses the routed surface', async () => {
    const harness = setup();
    const { operator } = harness;
    const grant = grantOf(
      await harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator),
        signal(),
      ),
    );

    await expect(
      harness
        .makeService(
          policy,
          surfaces.filter(
            ({ containerKey }) => containerKey !== 'notion.protected',
          ),
        )
        .persistKnowledge(
          operator,
          context(operator),
          request(operator, { elevation: grant }),
          signal(),
        ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(harness.calls.create).toBe(0);
  });

  it('applies control-plane policy: Steward is denied, Operator must elevate', async () => {
    const harness = setup();
    const steward = brainReadPrincipal('parent_steward');
    const governance = { ...legalMetadata, sensitivity: 'restricted' as const };

    await expect(
      harness.service.persistKnowledge(
        steward,
        context(steward),
        request(steward, { semanticMetadata: governance }),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(harness.store.elevationChallenges()).toHaveLength(0);

    const owner = setup();
    await expect(
      owner.service.persistKnowledge(
        owner.operator,
        context(owner.operator),
        request(owner.operator, { semanticMetadata: governance }),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'elevation_required' });
  });

  it('never lets Participant obtain an elevation challenge for a create', async () => {
    const harness = setup();
    const participant = brainReadPrincipal('family_participant');

    await expect(
      harness.service.persistKnowledge(
        participant,
        context(participant),
        request(participant),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(harness.store.elevationChallenges()).toHaveLength(0);
    expect(harness.calls.create).toBe(0);
  });

  it('reconciles an uncertain elevated create under its consumed challenge', async () => {
    const harness = setup({ unknownOperationIds: ['op_operator_create'] });
    const { operator } = harness;
    const grant = grantOf(
      await harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator),
        signal(),
      ),
    );
    await expect(
      harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator, { elevation: grant }),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'outcome_unknown' });

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator),
        signal(),
      ),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(harness.calls.create).toBe(1);
  });

  it('recovers a stranded elevated create by its marker only', async () => {
    const harness = setup();
    const { operator } = harness;
    const grant = grantOf(
      await harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator),
        signal(),
      ),
    );
    harness.store.failBeforeCommitStates.add('COMPLETED');
    await expect(
      harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator, { elevation: grant }),
        signal(),
      ),
    ).rejects.toBeInstanceOf(Error);
    harness.advance(15 * 60_000);

    await expect(
      harness.service.recoverStrandedExecution(
        operator,
        {
          requestId: requestId('req_operator_recover_create'),
          receivedAt: start,
          clientId: 'synthetic-operator',
        },
        {
          operationId: operationId('op_operator_create'),
          staleAfterMs: 15 * 60_000,
        },
        signal(),
      ),
    ).resolves.toMatchObject({ disposition: 'completed' });
    expect(harness.calls.create).toBe(1);
  });

  it('never creates when the confirmation commit acknowledgement is lost', async () => {
    const harness = setup();
    const { operator } = harness;
    const grant = grantOf(
      await harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator),
        signal(),
      ),
    );
    harness.store.failAfterCommitStates.add('EXECUTING');

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator, { elevation: grant }),
        signal(),
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      details: { reason: 'operation_in_progress' },
    });
    expect(harness.calls.create).toBe(0);
  });

  it('rejects a grant issued for a different create operation', async () => {
    const harness = setup();
    const { operator } = harness;
    const other = {
      operationId: operationId('op_operator_other_create'),
      requestId: requestId('req_operator_other_create'),
      title: 'Synthetic other lease note',
    };
    const otherGrant = grantOf(
      await harness.service.persistKnowledge(
        operator,
        { ...context(operator), requestId: other.requestId },
        request(operator, other),
        signal(),
      ),
    );
    await harness.service.persistKnowledge(
      operator,
      context(operator),
      request(operator),
      signal(),
    );

    await expect(
      harness.service.persistKnowledge(
        operator,
        context(operator),
        request(operator, { elevation: otherGrant }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'elevation_required' });
    expect(harness.calls.create).toBe(0);
  });
});
