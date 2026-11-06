import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ApprovalRequestCoordinator,
  ApprovalService,
} from '../../src/application/approval-service.js';
import { MutationService } from '../../src/application/mutation-service.js';
import { AuthorizationEngine } from '../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../src/domain/authorization/destructive-classifier.js';
import {
  brainRecordId,
  operationId,
  principalId,
  providerRecordId,
  requestId,
} from '../../src/domain/identifiers.js';
import { loadExecutablePolicy } from '../../src/domain/policy/policy-loader.js';
import { CanonicalRouter } from '../../src/domain/routing/canonical-router.js';
import type { BrainRecord } from '../../src/domain/records.js';
import type { ApprovalProjectionPort } from '../../src/ports/approval-projection.js';
import type { MutableKnowledgeProvider } from '../../src/ports/knowledge-provider.js';
import {
  brainReadNow,
  brainReadPrincipal,
} from '../support/brain-read-fixtures.js';
import { FakeMutableKnowledgeProvider } from '../support/fake-knowledge-providers.js';
import { SyntheticApprovalStore } from '../support/synthetic-approval-store.js';

const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);

function approvalHarness(
  target: BrainRecord,
  control: { fetchOverride?: (record: BrainRecord) => BrainRecord } = {},
) {
  const store = new SyntheticApprovalStore();
  const participant = brainReadPrincipal('family_participant');
  const parent = brainReadPrincipal('parent_steward');
  store.seedPrincipal(participant.principal);
  store.seedPrincipal(parent.principal);
  store.seedAlias({
    brainRecordId: brainRecordId('brn_acceptance_approval'),
    provider: 'notion',
    providerRecordId: target.provenance.providerRecordId,
    canonicalLocation: target.canonicalLocation,
    createdAt: brainReadNow,
    updatedAt: brainReadNow,
  });
  const notion = new FakeMutableKnowledgeProvider('notion', [target], {
    configuredAccess: {
      brainScopes: ['family_shared'],
      rootRefs: ['notion.family_shared'],
    },
    now: () => brainReadNow,
  });
  let trashes = 0;
  let appends = 0;
  const countingNotion: MutableKnowledgeProvider = {
    provider: 'notion',
    search: notion.search.bind(notion),
    fetch: async (request, signal) => {
      const fetched = await notion.fetch(request, signal);
      return control.fetchOverride?.(fetched) ?? fetched;
    },
    create: notion.create.bind(notion),
    update: notion.update.bind(notion),
    append: (request, signal) => {
      appends += 1;
      return notion.append(request, signal);
    },
    trash: (request, signal) => {
      trashes += 1;
      return notion.trash(request, signal);
    },
    reconcile: notion.reconcile.bind(notion),
  };
  const drive = new FakeMutableKnowledgeProvider('drive', [], {
    configuredAccess: {
      brainScopes: ['family_shared'],
      rootRefs: ['drive.family_shared'],
    },
  });
  const projection: ApprovalProjectionPort = {
    findByApprovalRequestId: () => Promise.resolve(null),
    create: () =>
      Promise.resolve({
        providerRecordId: providerRecordId(
          '40000000-0000-4000-8000-000000000031',
        ),
      }),
    update: () => Promise.resolve(),
  };
  const clock = { now: () => brainReadNow };
  const authorization = new AuthorizationEngine(policy, clock);
  const mutation = new MutationService(
    authorization,
    new DestructiveClassifier(),
    new CanonicalRouter(policy),
    store,
    [countingNotion, drive],
    [
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
    ],
    clock,
    new ApprovalRequestCoordinator(store, projection, clock),
  );
  const approvals = new ApprovalService(
    authorization,
    store,
    projection,
    mutation,
    clock,
  );
  return {
    store,
    participant,
    parent,
    notion,
    mutation,
    approvals,
    trashes: () => trashes,
    appends: () => appends,
  };
}

function protectedAppendTarget(): BrainRecord {
  return {
    brainRecordId: brainRecordId('brn_provider_acceptance_append'),
    title: 'Synthetic protected packing list',
    excerpt: 'Synthetic protected list.',
    content: 'Synthetic protected list.',
    contentType: 'text/markdown',
    canonicalLocation: {
      provider: 'notion',
      containerRef: 'notion.family_shared',
    },
    provenance: {
      provider: 'notion',
      providerRecordId: providerRecordId('notion-acceptance-append'),
      providerVersion: 'notion-acceptance-append-version',
      creatorPrincipalId: principalId('prn_operator'),
      createdAt: new Date(brainReadNow.getTime() - 60 * 60_000),
      updatedAt: new Date(brainReadNow.getTime() - 60_000),
    },
    policy: {
      scope: 'family_shared',
      sensitivity: 'protected',
      protectedClass: 'protected',
    },
  };
}

async function queueAddisonAppend(harness: ReturnType<typeof approvalHarness>) {
  const context = {
    requestId: requestId('req_acceptance_append'),
    receivedAt: brainReadNow,
    clientId: 'synthetic-test-client',
  };
  await expect(
    harness.mutation.appendToRecord(
      harness.participant,
      context,
      {
        operationId: operationId('op_acceptance_append'),
        requestId: context.requestId,
        principalId: harness.participant.principal.id,
        clientId: context.clientId,
        brainRecordId: brainRecordId('brn_acceptance_approval'),
        content: '\n- Synthetic approved flashlight',
      },
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({ state: 'approval_required' });
  const listed = await harness.approvals.listApprovals(
    harness.parent,
    {
      requestId: requestId('req_acceptance_append_list'),
      receivedAt: brainReadNow,
    },
    new AbortController().signal,
  );
  const pending = listed.approvals[0];
  if (pending === undefined) throw new Error('missing pending approval');
  return () =>
    harness.approvals.resolveApproval(
      harness.parent,
      {
        requestId: requestId('req_acceptance_append_resolve'),
        receivedAt: brainReadNow,
      },
      { approvalRequestId: pending.approvalRequestId, resolution: 'approve' },
      new AbortController().signal,
    );
}

const appendAccess = {
  brainScopes: ['family_shared' as const],
  rootRefs: ['notion.family_shared'],
};

describe('approval workflow acceptance', () => {
  it.each(['impossible', 'superseded'] as const)(
    'replays an approve that durably ended %s instead of rejecting the retry',
    async (status) => {
      const control: { fetchOverride?: (record: BrainRecord) => BrainRecord } =
        {};
      const harness = approvalHarness(protectedAppendTarget(), control);
      const resolve = await queueAddisonAppend(harness);
      if (status === 'impossible') {
        harness.store.seedPrincipal({
          ...harness.participant.principal,
          status: 'disabled',
        });
      } else {
        control.fetchOverride = (record) => ({
          ...record,
          policy: { ...record.policy, protectedClass: 'legal_hold' },
        });
      }

      const first = await resolve();
      expect(first).toMatchObject({ approvalStatus: status });
      // The caller lost the first response (for example an audit outage).
      await expect(resolve()).resolves.toEqual(first);
      expect(harness.appends()).toBe(0);
    },
  );

  it('clears an approval-pending append body once a parent declines it', async () => {
    const harness = approvalHarness(protectedAppendTarget());
    await queueAddisonAppend(harness);
    expect(
      (await harness.store.getOperation(operationId('op_acceptance_append')))
        ?.mutationPayload,
    ).toEqual({ content: '\n- Synthetic approved flashlight' });
    const [pending] = await harness.store.listPendingApprovals();
    if (pending === undefined) throw new Error('missing pending approval');

    await expect(
      harness.approvals.resolveApproval(
        harness.parent,
        {
          requestId: requestId('req_acceptance_append_decline'),
          receivedAt: brainReadNow,
        },
        { approvalRequestId: pending.id, resolution: 'decline' },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ approvalStatus: 'declined' });
    expect(harness.appends()).toBe(0);
    expect(
      (await harness.store.getOperation(operationId('op_acceptance_append')))
        ?.mutationPayload,
    ).toBeUndefined();
  });

  it('supersedes an approved append whose target became legal-hold evidence', async () => {
    const control: { fetchOverride?: (record: BrainRecord) => BrainRecord } =
      {};
    const harness = approvalHarness(protectedAppendTarget(), control);
    const resolve = await queueAddisonAppend(harness);
    control.fetchOverride = (record) => ({
      ...record,
      policy: { ...record.policy, protectedClass: 'legal_hold' },
    });

    await expect(resolve()).resolves.toMatchObject({
      approvalStatus: 'superseded',
      operationState: 'SUPERSEDED',
    });
    expect(harness.appends()).toBe(0);
    expect(
      (await harness.store.getOperation(operationId('op_acceptance_append')))
        ?.mutationPayload,
    ).toBeUndefined();
  });

  it('queues an Participant append to a protected record and appends once after parent approval', async () => {
    const target = protectedAppendTarget();
    const harness = approvalHarness(target);
    const resolve = await queueAddisonAppend(harness);

    await expect(resolve()).resolves.toMatchObject({
      approvalStatus: 'approved',
      operationState: 'COMPLETED',
    });
    await expect(resolve()).resolves.toMatchObject({
      approvalStatus: 'approved',
    });
    await expect(
      harness.notion.fetch(
        {
          providerRecordId: target.provenance.providerRecordId,
          access: appendAccess,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      content: 'Synthetic protected list.\n- Synthetic approved flashlight',
    });
  });

  it('queues an Participant delete outside her window and trashes it once after parent approval', async () => {
    const target: BrainRecord = {
      brainRecordId: brainRecordId('brn_provider_acceptance_delete'),
      title: 'Synthetic outdated chore chart',
      excerpt: 'Synthetic outdated',
      content: 'Synthetic outdated',
      contentType: 'text/markdown',
      canonicalLocation: {
        provider: 'notion',
        containerRef: 'notion.family_shared',
      },
      provenance: {
        provider: 'notion',
        providerRecordId: providerRecordId('notion-acceptance-delete'),
        providerVersion: 'notion-acceptance-delete-version',
        creatorPrincipalId: principalId('prn_operator'),
        createdAt: new Date(brainReadNow.getTime() - 60 * 60_000),
        updatedAt: new Date(brainReadNow.getTime() - 60_000),
      },
      policy: {
        scope: 'family_shared',
        sensitivity: 'family_shared',
        protectedClass: 'none',
      },
    };
    const harness = approvalHarness(target);
    const context = {
      requestId: requestId('req_acceptance_delete'),
      receivedAt: brainReadNow,
      clientId: 'synthetic-test-client',
    };

    await expect(
      harness.mutation.deleteRecord(
        harness.participant,
        context,
        {
          operationId: operationId('op_acceptance_delete'),
          requestId: context.requestId,
          principalId: harness.participant.principal.id,
          clientId: context.clientId,
          brainRecordId: brainRecordId('brn_acceptance_approval'),
          explicitIntent: true,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      operationId: operationId('op_acceptance_delete'),
      state: 'approval_required',
    });
    expect(harness.trashes()).toBe(0);
    const listed = await harness.approvals.listApprovals(
      harness.parent,
      {
        requestId: requestId('req_acceptance_delete_list'),
        receivedAt: brainReadNow,
      },
      new AbortController().signal,
    );
    const pending = listed.approvals[0];
    if (pending === undefined) throw new Error('missing pending approval');
    const resolve = () =>
      harness.approvals.resolveApproval(
        harness.parent,
        {
          requestId: requestId('req_acceptance_delete_resolve'),
          receivedAt: brainReadNow,
        },
        { approvalRequestId: pending.approvalRequestId, resolution: 'approve' },
        new AbortController().signal,
      );

    await expect(resolve()).resolves.toMatchObject({
      approvalStatus: 'approved',
      operationState: 'COMPLETED',
    });
    await expect(resolve()).resolves.toMatchObject({
      approvalStatus: 'approved',
    });
    expect(harness.trashes()).toBe(1);
    await expect(
      harness.notion.fetch(
        {
          providerRecordId: target.provenance.providerRecordId,
          access: {
            brainScopes: ['family_shared'],
            rootRefs: ['notion.family_shared'],
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it('queues Participant safely and lets a parent execute the freshly validated update', async () => {
    const store = new SyntheticApprovalStore();
    const participant = brainReadPrincipal('family_participant');
    const parent = brainReadPrincipal('parent_steward');
    store.seedPrincipal(participant.principal);
    store.seedPrincipal(parent.principal);
    const target = {
      brainRecordId: brainRecordId('brn_provider_acceptance_approval'),
      title: 'Synthetic astronomy checklist',
      excerpt: 'Synthetic starting content',
      content: 'Synthetic starting content',
      contentType: 'text/markdown',
      canonicalLocation: {
        provider: 'notion' as const,
        containerRef: 'notion.family_shared',
      },
      provenance: {
        provider: 'notion' as const,
        providerRecordId: providerRecordId('notion-acceptance-approval'),
        providerVersion: 'notion-acceptance-version-1',
        creatorPrincipalId: principalId('prn_participant'),
        createdAt: new Date(brainReadNow.getTime() - 15 * 60_000 - 1),
        updatedAt: new Date(brainReadNow.getTime() - 60_000),
      },
      policy: {
        scope: 'family_shared' as const,
        sensitivity: 'family_shared' as const,
        protectedClass: 'none' as const,
      },
    };
    store.seedAlias({
      brainRecordId: brainRecordId('brn_acceptance_approval'),
      provider: 'notion',
      providerRecordId: target.provenance.providerRecordId,
      canonicalLocation: target.canonicalLocation,
      createdAt: brainReadNow,
      updatedAt: brainReadNow,
    });
    const notion = new FakeMutableKnowledgeProvider('notion', [target], {
      configuredAccess: {
        brainScopes: ['family_shared'],
        rootRefs: ['notion.family_shared'],
      },
      now: () => brainReadNow,
    });
    const drive = new FakeMutableKnowledgeProvider('drive', [], {
      configuredAccess: {
        brainScopes: ['family_shared'],
        rootRefs: ['drive.family_shared'],
      },
    });
    const projectionCalls: Parameters<ApprovalProjectionPort['create']>[0][] =
      [];
    const projection: ApprovalProjectionPort = {
      findByApprovalRequestId: () => Promise.resolve(null),
      create: (request) => {
        projectionCalls.push(request);
        return Promise.resolve({
          providerRecordId: providerRecordId(
            '40000000-0000-4000-8000-000000000003',
          ),
        });
      },
      update: () => Promise.resolve(),
    };
    const clock = { now: () => brainReadNow };
    const authorization = new AuthorizationEngine(policy, clock);
    const coordinator = new ApprovalRequestCoordinator(
      store,
      projection,
      clock,
    );
    const mutation = new MutationService(
      authorization,
      new DestructiveClassifier(),
      new CanonicalRouter(policy),
      store,
      [notion, drive],
      [
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
      ],
      clock,
      coordinator,
    );
    const approvals = new ApprovalService(
      authorization,
      store,
      projection,
      mutation,
      clock,
    );
    const context = {
      requestId: requestId('req_acceptance_approval'),
      receivedAt: brainReadNow,
      clientId: 'synthetic-test-client',
    };

    await expect(
      mutation.updateRecord(
        participant,
        context,
        {
          operationId: operationId('op_acceptance_approval'),
          requestId: context.requestId,
          principalId: participant.principal.id,
          clientId: context.clientId,
          brainRecordId: brainRecordId('brn_acceptance_approval'),
          mutation: {
            mode: 'replace',
            replacement: { content: 'Synthetic parent-approved content' },
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      operationId: operationId('op_acceptance_approval'),
      state: 'approval_required',
    });
    expect(JSON.stringify(projectionCalls)).not.toContain(
      'Synthetic parent-approved content',
    );
    await expect(
      approvals.listApprovals(
        participant,
        {
          requestId: requestId('req_acceptance_participant_list'),
          receivedAt: brainReadNow,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    const listed = await approvals.listApprovals(
      parent,
      {
        requestId: requestId('req_acceptance_parent_list'),
        receivedAt: brainReadNow,
      },
      new AbortController().signal,
    );
    expect(listed.approvals).toHaveLength(1);
    const pending = listed.approvals[0];
    if (pending === undefined) throw new Error('missing pending approval');
    await expect(
      approvals.resolveApproval(
        parent,
        {
          requestId: requestId('req_acceptance_parent_resolve'),
          receivedAt: brainReadNow,
        },
        {
          approvalRequestId: pending.approvalRequestId,
          resolution: 'approve',
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      approvalStatus: 'approved',
      operationState: 'COMPLETED',
    });
    await expect(
      notion.fetch(
        {
          providerRecordId: target.provenance.providerRecordId,
          access: {
            brainScopes: ['family_shared'],
            rootRefs: ['notion.family_shared'],
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ content: 'Synthetic parent-approved content' });
  });
});
