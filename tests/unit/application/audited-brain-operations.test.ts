import { describe, expect, it } from 'vitest';

import {
  AuditedBrainOperations,
  type BrainOperationServices,
} from '../../../src/application/audited-brain-operations.js';
import { DomainError } from '../../../src/domain/errors.js';
import {
  approvalRequestId,
  brainRecordId,
  operationId,
  providerRecordId,
  requestId,
} from '../../../src/domain/identifiers.js';
import type { MutationResponse } from '../../../src/domain/operations.js';
import type { AuditEvent } from '../../../src/ports/audit-sink.js';
import type { AuditOutboxRecord } from '../../../src/ports/operational-state-store.js';
import { brainReadPrincipal } from '../../support/brain-read-fixtures.js';

const now = new Date('2043-02-15T16:17:18.000Z');
const confidential = 'Synthetic confidential request text';
const operator = brainReadPrincipal();
const context = {
  requestId: requestId('req_audited'),
  receivedAt: now,
  clientId: 'synthetic-client',
};
const signal = () => new AbortController().signal;

class AuditStore {
  readonly events: AuditEvent[] = [];
  failNext = false;

  enqueueAuditEvent(event: AuditEvent): Promise<AuditOutboxRecord> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('synthetic outbox unavailable'));
    }
    this.events.push(event);
    return Promise.resolve({
      id: String(this.events.length),
      event,
      attempts: 0,
      availableAt: event.timestamp,
    });
  }
}

const completedMutation: MutationResponse = {
  operationId: operationId('op_audited'),
  state: 'completed',
  brainRecordId: brainRecordId('brn_audited_created'),
  record: {
    provider: 'notion',
    providerRecordId: providerRecordId('notion-audited'),
    canonicalLocation: {
      provider: 'notion',
      containerRef: 'notion.family_shared',
    },
  },
};

function services(
  overrides: Partial<{
    [K in keyof BrainOperationServices]: Partial<BrainOperationServices[K]>;
  }> = {},
): BrainOperationServices {
  return {
    query: {
      searchBrain: () =>
        Promise.resolve({
          requestId: context.requestId,
          results: [],
          completeness: { complete: false, providers: [] },
        }),
      fetchRecord: () =>
        Promise.reject(new Error('unexpected synthetic fetch')),
      ...overrides.query,
    },
    mutations: {
      persistKnowledge: () => Promise.resolve(completedMutation),
      updateRecord: () =>
        Promise.resolve({
          operationId: operationId('op_audited'),
          state: 'approval_required',
        }),
      appendToRecord: () =>
        Promise.resolve({
          operationId: operationId('op_audited'),
          state: 'elevation_required',
        }),
      deleteRecord: () =>
        Promise.resolve({
          operationId: operationId('op_audited'),
          state: 'outcome_unknown',
        }),
      ...overrides.mutations,
    },
    approvals: {
      listApprovals: () => Promise.resolve({ approvals: [] }),
      resolveApproval: () =>
        Promise.resolve({
          approvalRequestId: approvalRequestId('apr_audited'),
          operationId: operationId('op_audited_resolved'),
          approvalStatus: 'approved',
          operationState: 'COMPLETED',
        }),
      ...overrides.approvals,
    },
  };
}

const identity = {
  operationId: operationId('op_audited'),
  requestId: context.requestId,
  principalId: operator.principal.id,
  clientId: context.clientId,
};

describe('AuditedBrainOperations', () => {
  it('records exactly one metadata-only event for each of the eight operations', async () => {
    const store = new AuditStore();
    const audited = new AuditedBrainOperations(services(), store, {
      now: () => now,
    });

    await audited.searchBrain(
      operator,
      context,
      { query: confidential, limit: 5 },
      signal(),
    );
    await audited.persistKnowledge(
      operator,
      context,
      {
        ...identity,
        title: confidential,
        content: confidential,
        semanticMetadata: { subject: confidential },
      },
      signal(),
    );
    await audited.updateRecord(
      operator,
      context,
      {
        ...identity,
        brainRecordId: brainRecordId('brn_audited_target'),
        mutation: { mode: 'patch', patch: { title: confidential } },
      },
      signal(),
    );
    await audited.appendToRecord(
      operator,
      context,
      {
        ...identity,
        brainRecordId: brainRecordId('brn_audited_target'),
        content: confidential,
      },
      signal(),
    );
    await audited.deleteRecord(
      operator,
      context,
      {
        ...identity,
        brainRecordId: brainRecordId('brn_audited_target'),
        explicitIntent: true,
      },
      signal(),
    );
    await audited.listApprovals(operator, context, signal());
    await audited.resolveApproval(
      operator,
      context,
      {
        approvalRequestId: approvalRequestId('apr_audited'),
        resolution: 'approve',
        reason: confidential,
      },
      signal(),
    );
    await expect(
      audited.fetchRecord(
        operator,
        context,
        { brainRecordId: brainRecordId('brn_audited_target') },
        signal(),
      ),
    ).rejects.toThrow('unexpected synthetic fetch');

    expect(
      store.events.map(({ eventType, operation, outcome, reasonCode }) => [
        eventType,
        operation,
        outcome,
        reasonCode,
      ]),
    ).toEqual([
      [
        'brain.request.completed',
        'search_brain',
        'COMPLETED',
        'search_partial',
      ],
      [
        'brain.request.completed',
        'persist_knowledge',
        'COMPLETED',
        'mutation_completed',
      ],
      [
        'brain.request.completed',
        'update_record',
        'APPROVAL_PENDING',
        'mutation_approval_required',
      ],
      [
        'brain.request.completed',
        'append_to_record',
        'ELEVATION_PENDING',
        'mutation_elevation_required',
      ],
      [
        'brain.request.completed',
        'delete_record',
        'OUTCOME_UNKNOWN',
        'mutation_outcome_unknown',
      ],
      [
        'brain.request.completed',
        'list_approvals',
        'COMPLETED',
        'approvals_listed',
      ],
      [
        'brain.request.completed',
        'resolve_approval',
        'COMPLETED',
        'approval_approved',
      ],
      ['brain.request.rejected', 'fetch_record', 'FAILED', 'internal_error'],
    ]);
    expect(store.events[1]).toMatchObject({
      requestId: context.requestId,
      principalId: operator.principal.id,
      clientId: 'synthetic-client',
      operationId: operationId('op_audited'),
      brainRecordId: brainRecordId('brn_audited_created'),
      provider: 'notion',
      providerRecordId: providerRecordId('notion-audited'),
      timestamp: now,
    });
    expect(store.events[2]).toMatchObject({
      brainRecordId: brainRecordId('brn_audited_target'),
    });
    expect(store.events[6]).toMatchObject({
      approvalRequestId: approvalRequestId('apr_audited'),
      operationId: operationId('op_audited_resolved'),
    });
    expect(JSON.stringify(store.events)).not.toContain(confidential);
  });

  it.each([
    [
      'an authorization denial',
      new DomainError('unauthorized', false, {
        reason: 'record_access_denied',
      }),
      'DENIED',
      'unauthorized.record_access_denied',
    ],
    [
      'an identity mismatch',
      new DomainError('unauthenticated', false, {
        reason: 'operation_identity_mismatch',
      }),
      'DENIED',
      'unauthenticated.operation_identity_mismatch',
    ],
    [
      'a structured routing error',
      new DomainError('insufficient_metadata', true, {
        missing: ['record_type'],
      }),
      'FAILED',
      'insufficient_metadata',
    ],
    [
      'an unsafe reason detail',
      new DomainError('invalid_request', false, {
        reason: `${confidential} with spaces`,
      }),
      'FAILED',
      'invalid_request',
    ],
  ] as const)(
    'records %s before rethrowing the original error',
    async (_, error, outcome, reasonCode) => {
      const store = new AuditStore();
      const audited = new AuditedBrainOperations(
        services({
          mutations: { persistKnowledge: () => Promise.reject(error) },
        }),
        store,
        { now: () => now },
      );

      await expect(
        audited.persistKnowledge(
          operator,
          context,
          {
            ...identity,
            title: confidential,
            content: confidential,
            semanticMetadata: {},
          },
          signal(),
        ),
      ).rejects.toBe(error);
      expect(store.events).toMatchObject([
        {
          eventType: 'brain.request.rejected',
          operation: 'persist_knowledge',
          operationId: operationId('op_audited'),
          outcome,
          reasonCode,
        },
      ]);
      expect(JSON.stringify(store.events)).not.toContain(confidential);
    },
  );

  it('records a cancelled request without masking the cancellation', async () => {
    const store = new AuditStore();
    const cancellation = new DOMException('cancelled', 'AbortError');
    const audited = new AuditedBrainOperations(
      services({
        approvals: { listApprovals: () => Promise.reject(cancellation) },
      }),
      store,
      { now: () => now },
    );

    await expect(
      audited.listApprovals(operator, context, signal()),
    ).rejects.toBe(cancellation);
    expect(store.events).toMatchObject([
      { outcome: 'FAILED', reasonCode: 'request_cancelled' },
    ]);
  });

  it('records an unauthenticated caller without trusting its claims', async () => {
    const store = new AuditStore();
    const audited = new AuditedBrainOperations(
      services({
        query: {
          searchBrain: () =>
            Promise.reject(new DomainError('unauthenticated', false)),
        },
      }),
      store,
      { now: () => now },
    );

    await expect(
      audited.searchBrain(
        { principal: { id: 'prn_forged' } } as unknown as typeof operator,
        context,
        { query: 'synthetic', limit: 1 },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(store.events).toMatchObject([
      {
        principalId: 'unauthenticated',
        outcome: 'DENIED',
        reasonCode: 'unauthenticated',
      },
    ]);
  });

  it('turns an audit outage after success into a retryable error', async () => {
    const store = new AuditStore();
    store.failNext = true;
    const audited = new AuditedBrainOperations(services(), store, {
      now: () => now,
    });

    await expect(
      audited.listApprovals(operator, context, signal()),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'audit_state_unavailable' },
    });
    await expect(
      audited.listApprovals(operator, context, signal()),
    ).resolves.toEqual({ approvals: [] });
    expect(store.events).toHaveLength(1);
  });

  it('never lets an audit outage mask the original rejection', async () => {
    const store = new AuditStore();
    store.failNext = true;
    const original = new DomainError('not_found', false, {
      reason: 'record_not_found',
    });
    const audited = new AuditedBrainOperations(
      services({ query: { fetchRecord: () => Promise.reject(original) } }),
      store,
      { now: () => now },
    );

    await expect(
      audited.fetchRecord(
        operator,
        context,
        { brainRecordId: brainRecordId('brn_audited_target') },
        signal(),
      ),
    ).rejects.toBe(original);
  });

  it('still records exactly one rejection for a malformed request', async () => {
    const store = new AuditStore();
    const audited = new AuditedBrainOperations(
      services({
        mutations: {
          updateRecord: () =>
            Promise.reject(new DomainError('invalid_request', false)),
        },
      }),
      store,
      { now: () => now },
    );

    await expect(
      audited.updateRecord(
        operator,
        context,
        {
          ...identity,
          operationId: 'x'.repeat(600),
          brainRecordId: 42,
        } as unknown as Parameters<typeof audited.updateRecord>[2],
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      audited.fetchRecord(
        operator,
        context,
        null as unknown as Parameters<typeof audited.fetchRecord>[2],
        signal(),
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(store.events).toHaveLength(2);
    expect(store.events[0]).not.toHaveProperty('operationId');
    expect(store.events[0]).not.toHaveProperty('brainRecordId');
  });
});
