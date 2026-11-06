import { describe, expect, it } from 'vitest';

import {
  operationId,
  type OperationId,
  type ProviderRecordId,
} from '../../src/domain/identifiers.js';
import type {
  BrainRecord,
  BrainScope,
  KnowledgeProviderName,
  ProviderCompleteness,
} from '../../src/domain/records.js';
import type {
  FetchableKnowledgeProvider,
  MutableKnowledgeProvider,
  ProviderAccessScope,
  RoutedCreate,
} from '../../src/ports/knowledge-provider.js';

export interface FetchableKnowledgeProviderContractOptions {
  readonly name: string;
  readonly provider: KnowledgeProviderName;
  readonly getProvider: () => FetchableKnowledgeProvider;
  readonly visibleRecord: BrainRecord;
  readonly hiddenProviderRecordIds: readonly ProviderRecordId[];
  readonly authorizedAccess: ProviderAccessScope;
  readonly unconfiguredRootRef: string;
  readonly unconfiguredBrainScope: BrainScope;
  readonly matchingQuery: string;
  readonly expectedCompleteness?: ProviderCompleteness;
}

export interface MutableKnowledgeProviderContractOptions extends Omit<
  FetchableKnowledgeProviderContractOptions,
  'getProvider' | 'provider'
> {
  readonly provider: 'notion' | 'drive';
  readonly getProvider: () => MutableKnowledgeProvider;
  readonly unknownCreateOperationId: OperationId;
  readonly createContentType?: string;
}

function summaryOf(record: BrainRecord) {
  const { content: _content, contentType: _contentType, ...summary } = record;
  return summary;
}

function createRequest(
  options: MutableKnowledgeProviderContractOptions,
  id: OperationId,
  overrides: Partial<RoutedCreate> = {},
): RoutedCreate {
  return {
    operationId: id,
    access: options.authorizedAccess,
    title: 'Synthetic created knowledge',
    content: 'Synthetic created body.',
    contentType: options.createContentType ?? 'text/plain',
    canonicalLocation: options.visibleRecord.canonicalLocation,
    policy: options.visibleRecord.policy,
    ...overrides,
  };
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    expect.unreachable('expected provider operation to reject');
  } catch (error) {
    return error;
  }
}

export function fetchableKnowledgeProviderContract(
  options: FetchableKnowledgeProviderContractOptions,
): void {
  describe(`${options.name} fetchable KnowledgeProvider contract`, () => {
    const expectedCompleteness = options.expectedCompleteness ?? {
      provider: options.provider,
      state: 'complete',
    };

    it('returns normalized summaries with stable provenance and completeness', async () => {
      const provider = options.getProvider();
      const signal = new AbortController().signal;

      const first = await provider.search(
        {
          query: options.matchingQuery,
          limit: 10,
          access: options.authorizedAccess,
        },
        signal,
      );
      const second = await provider.search(
        {
          query: options.matchingQuery.toUpperCase(),
          limit: 10,
          access: options.authorizedAccess,
        },
        signal,
      );

      expect(provider.provider).toBe(options.provider);
      expect(first).toEqual({
        records: [summaryOf(options.visibleRecord)],
        completeness: expectedCompleteness,
      });
      expect(second).toEqual(first);
      expect(first.records[0]?.provenance).toEqual(
        options.visibleRecord.provenance,
      );
      expect(first.records[0]).not.toHaveProperty('content');
      expect(first.records[0]).not.toHaveProperty('contentType');
      expect(JSON.stringify(first)).not.toContain('providerRawObject');
    });

    it('returns an authorized normalized full record by provider record ID', async () => {
      const fetched = await options.getProvider().fetch(
        {
          providerRecordId: options.visibleRecord.provenance.providerRecordId,
          access: options.authorizedAccess,
        },
        new AbortController().signal,
      );

      expect(fetched).toEqual(options.visibleRecord);
      expect(fetched.provenance.provider).toBe(options.provider);
      expect(fetched.canonicalLocation.provider).toBe(options.provider);
      expect(JSON.stringify(fetched)).not.toContain('providerRawObject');
    });

    it('does not reveal records outside the requested governed root or Brain scope', async () => {
      const provider = options.getProvider();

      for (const providerRecordId of options.hiddenProviderRecordIds) {
        const error = await captureError(() =>
          provider.fetch(
            { providerRecordId, access: options.authorizedAccess },
            new AbortController().signal,
          ),
        );
        expect(error).toMatchObject({
          code: 'not_found',
          retryable: false,
          details: { reason: 'record_not_found' },
        });
      }
    });

    it('rejects any access expansion beyond its configured roots or scopes', async () => {
      const provider = options.getProvider();
      const expandedAccess = {
        brainScopes: [
          ...options.authorizedAccess.brainScopes,
          options.unconfiguredBrainScope,
        ],
        rootRefs: [
          ...options.authorizedAccess.rootRefs,
          options.unconfiguredRootRef,
        ],
      };

      const attempts = [
        () =>
          provider.search(
            {
              query: options.matchingQuery,
              limit: 10,
              access: expandedAccess,
            },
            new AbortController().signal,
          ),
        () =>
          provider.fetch(
            {
              providerRecordId:
                options.visibleRecord.provenance.providerRecordId,
              access: expandedAccess,
            },
            new AbortController().signal,
          ),
      ];

      for (const attempt of attempts) {
        const error = await captureError(attempt);
        expect(error).toMatchObject({
          code: 'unauthorized',
          retryable: false,
          details: { reason: 'provider_scope_rejected' },
        });
        expect(JSON.stringify(error)).not.toContain(
          options.unconfiguredRootRef,
        );
      }
    });

    it('returns no result for a nonmatching query without weakening completeness', async () => {
      await expect(
        options.getProvider().search(
          {
            query: 'synthetic query with no matching fixture',
            limit: 10,
            access: options.authorizedAccess,
          },
          new AbortController().signal,
        ),
      ).resolves.toEqual({
        records: [],
        completeness: expectedCompleteness,
      });
    });

    it('honors cancellation without exposing the caller abort reason', async () => {
      const controller = new AbortController();
      controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));
      const provider = options.getProvider();

      for (const run of [
        () =>
          provider.search(
            {
              query: options.matchingQuery,
              limit: 10,
              access: options.authorizedAccess,
            },
            controller.signal,
          ),
        () =>
          provider.fetch(
            {
              providerRecordId:
                options.visibleRecord.provenance.providerRecordId,
              access: options.authorizedAccess,
            },
            controller.signal,
          ),
      ]) {
        const error = await captureError(run);
        expect(error).toMatchObject({ name: 'AbortError' });
        expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_ABORT_REASON');
        expect(JSON.stringify(error)).not.toContain(
          'SYNTHETIC_PRIVATE_ABORT_REASON',
        );
      }
    });
  });
}

export function mutableKnowledgeProviderContract(
  options: MutableKnowledgeProviderContractOptions,
): void {
  describe(`${options.name} mutable KnowledgeProvider contract`, () => {
    it('creates a normalized record in the routed canonical container', async () => {
      const provider = options.getProvider();
      const request = createRequest(
        options,
        operationId(`op_contract_${options.provider}_create`),
      );
      const result = await provider.create(
        request,
        new AbortController().signal,
      );

      expect(result).toMatchObject({
        outcome: 'completed',
        record: {
          provider: options.provider,
          canonicalLocation: {
            provider: request.canonicalLocation.provider,
            containerRef: request.canonicalLocation.containerRef,
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain('providerRawObject');
      if (result.outcome !== 'completed') {
        expect.unreachable('expected completed create');
      }

      const fetched = await provider.fetch(
        {
          providerRecordId: result.record.providerRecordId,
          access: options.authorizedAccess,
        },
        new AbortController().signal,
      );
      expect(fetched).toMatchObject({
        title: request.title,
        content: request.content,
        contentType: request.contentType,
        canonicalLocation: {
          provider: request.canonicalLocation.provider,
          containerRef: request.canonicalLocation.containerRef,
        },
        policy: request.policy,
        provenance: {
          provider: options.provider,
          providerRecordId: result.record.providerRecordId,
          providerVersion: result.record.providerVersion,
        },
      });
    });

    it('updates and appends while preserving the stable provider record ID', async () => {
      const provider = options.getProvider();
      const providerRecordId =
        options.visibleRecord.provenance.providerRecordId;
      const update = await provider.update(
        {
          operationId: operationId(`op_contract_${options.provider}_update`),
          access: options.authorizedAccess,
          providerRecordId,
          ...(options.visibleRecord.provenance.providerVersion === undefined
            ? {}
            : {
                expectedProviderVersion:
                  options.visibleRecord.provenance.providerVersion,
              }),
          mutation: {
            mode: 'patch',
            patch: {
              title: 'Synthetic updated title',
              content: 'Synthetic updated body.',
            },
          },
        },
        new AbortController().signal,
      );
      expect(update).toMatchObject({
        outcome: 'completed',
        record: { provider: options.provider, providerRecordId },
      });
      if (
        update.outcome !== 'completed' ||
        update.record.providerVersion === undefined
      ) {
        expect.unreachable('expected completed update with provider version');
      }

      const append = await provider.append(
        {
          operationId: operationId(`op_contract_${options.provider}_append`),
          access: options.authorizedAccess,
          providerRecordId,
          expectedProviderVersion: update.record.providerVersion,
          content: '\nSynthetic appended body.',
        },
        new AbortController().signal,
      );
      expect(append).toMatchObject({
        outcome: 'completed',
        record: { provider: options.provider, providerRecordId },
      });

      const fetched = await provider.fetch(
        { providerRecordId, access: options.authorizedAccess },
        new AbortController().signal,
      );
      expect(fetched.title).toBe('Synthetic updated title');
      expect(fetched.content).toBe(
        'Synthetic updated body.\nSynthetic appended body.',
      );
      expect(fetched.provenance.providerRecordId).toBe(providerRecordId);
      expect(fetched.provenance.providerVersion).not.toBe(
        options.visibleRecord.provenance.providerVersion,
      );
    });

    it('rejects a stale expected provider version without mutating the record', async () => {
      const provider = options.getProvider();
      const staleVersion = 'SYNTHETIC_STALE_PROVIDER_VERSION';
      const providerRecordId =
        options.visibleRecord.provenance.providerRecordId;

      const error = await captureError(() =>
        provider.update(
          {
            operationId: operationId(
              `op_contract_${options.provider}_stale_update`,
            ),
            access: options.authorizedAccess,
            providerRecordId,
            expectedProviderVersion: staleVersion,
            mutation: {
              mode: 'replace',
              replacement: { content: 'Synthetic replacement.' },
            },
          },
          new AbortController().signal,
        ),
      );
      expect(error).toMatchObject({
        code: 'idempotency_conflict',
        retryable: false,
        details: { reason: 'provider_version_mismatch' },
      });
      expect(JSON.stringify(error)).not.toContain(staleVersion);
      await expect(
        provider.fetch(
          { providerRecordId, access: options.authorizedAccess },
          new AbortController().signal,
        ),
      ).resolves.toEqual(options.visibleRecord);
    });

    it('rejects stale append and trash versions without mutation or reconciliation evidence', async () => {
      const staleVersion = 'SYNTHETIC_STALE_PROVIDER_VERSION';
      const providerRecordId =
        options.visibleRecord.provenance.providerRecordId;

      for (const operation of ['append', 'trash'] as const) {
        const provider = options.getProvider();
        const id = operationId(
          `op_contract_${options.provider}_stale_${operation}`,
        );
        const run =
          operation === 'append'
            ? () =>
                provider.append(
                  {
                    operationId: id,
                    access: options.authorizedAccess,
                    providerRecordId,
                    expectedProviderVersion: staleVersion,
                    content: '\nSynthetic stale append.',
                  },
                  new AbortController().signal,
                )
            : () =>
                provider.trash(
                  {
                    operationId: id,
                    access: options.authorizedAccess,
                    providerRecordId,
                    expectedProviderVersion: staleVersion,
                  },
                  new AbortController().signal,
                );

        const error = await captureError(run);
        expect(error).toMatchObject({
          code: 'idempotency_conflict',
          retryable: false,
          details: { reason: 'provider_version_mismatch' },
        });
        expect(JSON.stringify(error)).not.toContain(staleVersion);
        await expect(
          provider.fetch(
            { providerRecordId, access: options.authorizedAccess },
            new AbortController().signal,
          ),
        ).resolves.toEqual(options.visibleRecord);
        await expect(
          provider.reconcile(
            {
              operationId: id,
              operation,
              access: options.authorizedAccess,
              providerRecordId,
            },
            new AbortController().signal,
          ),
        ).resolves.toEqual({ outcome: 'not_found' });
      }
    });

    it('uses recoverable trash semantics and preserves reconciliation evidence', async () => {
      const provider = options.getProvider();
      const operation = operationId(`op_contract_${options.provider}_trash`);
      const providerRecordId =
        options.visibleRecord.provenance.providerRecordId;
      const result = await provider.trash(
        {
          operationId: operation,
          access: options.authorizedAccess,
          providerRecordId,
          ...(options.visibleRecord.provenance.providerVersion === undefined
            ? {}
            : {
                expectedProviderVersion:
                  options.visibleRecord.provenance.providerVersion,
              }),
        },
        new AbortController().signal,
      );

      expect(result).toMatchObject({
        outcome: 'completed',
        record: { provider: options.provider, providerRecordId },
      });
      await expect(
        provider.fetch(
          { providerRecordId, access: options.authorizedAccess },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        provider.reconcile(
          {
            operationId: operation,
            operation: 'trash',
            access: options.authorizedAccess,
            providerRecordId,
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        outcome: 'completed',
        record: { provider: options.provider, providerRecordId },
      });
    });

    it('reconciles an uncertain provider outcome without repeating the mutation', async () => {
      const provider = options.getProvider();
      const request = createRequest(options, options.unknownCreateOperationId, {
        title: 'Synthetic uncertain create',
      });
      const result = await provider.create(
        request,
        new AbortController().signal,
      );

      expect(result.outcome).toBe('unknown');
      expect(JSON.stringify(result)).not.toContain(request.content);
      if (result.outcome !== 'unknown') {
        expect.unreachable('expected uncertain create');
      }
      expect(typeof result.reconciliationKey).toBe('string');

      await expect(
        provider.create(request, new AbortController().signal),
      ).rejects.toMatchObject({
        code: 'idempotency_conflict',
        retryable: false,
        details: { reason: 'provider_operation_repeated' },
      });

      const reconciled = await provider.reconcile(
        {
          operationId: request.operationId,
          operation: 'create',
          access: options.authorizedAccess,
          ...(result.reconciliationKey === undefined
            ? {}
            : { reconciliationKey: result.reconciliationKey }),
        },
        new AbortController().signal,
      );
      expect(reconciled).toMatchObject({
        outcome: 'completed',
        record: { provider: options.provider },
      });
      if (reconciled.outcome !== 'completed') {
        expect.unreachable('expected completed reconciliation');
      }
      await expect(
        provider.fetch(
          {
            providerRecordId: reconciled.record.providerRecordId,
            access: options.authorizedAccess,
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ title: request.title });
    });

    it('rejects configured-access expansion across every mutable operation', async () => {
      const provider = options.getProvider();
      const privateContent = 'SYNTHETIC_PRIVATE_CONTENT';
      const providerRecordId =
        options.visibleRecord.provenance.providerRecordId;
      const expandedAccess = {
        brainScopes: [
          ...options.authorizedAccess.brainScopes,
          options.unconfiguredBrainScope,
        ],
        rootRefs: [
          ...options.authorizedAccess.rootRefs,
          options.unconfiguredRootRef,
        ],
      };
      const createId = operationId(
        `op_contract_${options.provider}_scope_rejection_create`,
      );
      const updateId = operationId(
        `op_contract_${options.provider}_scope_rejection_update`,
      );
      const appendId = operationId(
        `op_contract_${options.provider}_scope_rejection_append`,
      );
      const trashId = operationId(
        `op_contract_${options.provider}_scope_rejection_trash`,
      );
      const create = createRequest(options, createId, {
        access: expandedAccess,
        content: privateContent,
      });
      const attempts = [
        {
          operation: 'create',
          run: () => provider.create(create, new AbortController().signal),
        },
        {
          operation: 'update',
          run: () =>
            provider.update(
              {
                operationId: updateId,
                access: expandedAccess,
                providerRecordId,
                mutation: {
                  mode: 'replace',
                  replacement: { content: privateContent },
                },
              },
              new AbortController().signal,
            ),
        },
        {
          operation: 'append',
          run: () =>
            provider.append(
              {
                operationId: appendId,
                access: expandedAccess,
                providerRecordId,
                content: privateContent,
              },
              new AbortController().signal,
            ),
        },
        {
          operation: 'trash',
          run: () =>
            provider.trash(
              {
                operationId: trashId,
                access: expandedAccess,
                providerRecordId,
              },
              new AbortController().signal,
            ),
        },
        {
          operation: 'reconcile',
          run: () =>
            provider.reconcile(
              {
                operationId: updateId,
                operation: 'update',
                access: expandedAccess,
                providerRecordId,
              },
              new AbortController().signal,
            ),
        },
      ];

      for (const attempt of attempts) {
        const error = await captureError(attempt.run);
        expect(error).toMatchObject({
          code: 'unauthorized',
          retryable: false,
          details: { reason: 'provider_scope_rejected' },
        });
        expect(JSON.stringify(error)).not.toContain(privateContent);
        expect(JSON.stringify(error)).not.toContain(
          options.unconfiguredRootRef,
        );
      }

      await expect(
        provider.fetch(
          { providerRecordId, access: options.authorizedAccess },
          new AbortController().signal,
        ),
      ).resolves.toEqual(options.visibleRecord);
      for (const [operationId, operation] of [
        [createId, 'create'],
        [updateId, 'update'],
        [appendId, 'append'],
        [trashId, 'trash'],
      ] as const) {
        await expect(
          provider.reconcile(
            {
              operationId,
              operation,
              access: options.authorizedAccess,
              ...(operation === 'create' ? {} : { providerRecordId }),
            },
            new AbortController().signal,
          ),
        ).resolves.toEqual({ outcome: 'not_found' });
      }
    });

    it('honors cancellation across every mutation and reconciliation operation', async () => {
      const providerRecordId =
        options.visibleRecord.provenance.providerRecordId;
      const controller = new AbortController();
      controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));
      const createId = operationId(
        `op_contract_${options.provider}_cancelled_create`,
      );
      const updateId = operationId(
        `op_contract_${options.provider}_cancelled_update`,
      );
      const appendId = operationId(
        `op_contract_${options.provider}_cancelled_append`,
      );
      const trashId = operationId(
        `op_contract_${options.provider}_cancelled_trash`,
      );
      const attempts = [
        {
          operationId: createId,
          operation: 'create',
          run: (provider: MutableKnowledgeProvider) =>
            provider.create(
              createRequest(options, createId),
              controller.signal,
            ),
        },
        {
          operationId: updateId,
          operation: 'update',
          run: (provider: MutableKnowledgeProvider) =>
            provider.update(
              {
                operationId: updateId,
                access: options.authorizedAccess,
                providerRecordId,
                mutation: {
                  mode: 'replace',
                  replacement: { content: 'Synthetic cancelled update.' },
                },
              },
              controller.signal,
            ),
        },
        {
          operationId: appendId,
          operation: 'append',
          run: (provider: MutableKnowledgeProvider) =>
            provider.append(
              {
                operationId: appendId,
                access: options.authorizedAccess,
                providerRecordId,
                content: '\nSynthetic cancelled append.',
              },
              controller.signal,
            ),
        },
        {
          operationId: trashId,
          operation: 'trash',
          run: (provider: MutableKnowledgeProvider) =>
            provider.trash(
              {
                operationId: trashId,
                access: options.authorizedAccess,
                providerRecordId,
              },
              controller.signal,
            ),
        },
      ] as const;

      for (const attempt of attempts) {
        const provider = options.getProvider();
        const error = await captureError(() => attempt.run(provider));
        expect(error).toMatchObject({ name: 'AbortError' });
        expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_ABORT_REASON');
        expect(JSON.stringify(error)).not.toContain(
          'SYNTHETIC_PRIVATE_ABORT_REASON',
        );
        await expect(
          provider.fetch(
            { providerRecordId, access: options.authorizedAccess },
            new AbortController().signal,
          ),
        ).resolves.toEqual(options.visibleRecord);
        await expect(
          provider.reconcile(
            {
              operationId: attempt.operationId,
              operation: attempt.operation,
              access: options.authorizedAccess,
              ...(attempt.operation === 'create' ? {} : { providerRecordId }),
            },
            new AbortController().signal,
          ),
        ).resolves.toEqual({ outcome: 'not_found' });
      }

      const reconcileError = await captureError(() =>
        options.getProvider().reconcile(
          {
            operationId: operationId(
              `op_contract_${options.provider}_cancelled_reconcile`,
            ),
            operation: 'update',
            access: options.authorizedAccess,
            providerRecordId,
          },
          controller.signal,
        ),
      );
      expect(reconcileError).toMatchObject({ name: 'AbortError' });
      expect(String(reconcileError)).not.toContain(
        'SYNTHETIC_PRIVATE_ABORT_REASON',
      );
      expect(JSON.stringify(reconcileError)).not.toContain(
        'SYNTHETIC_PRIVATE_ABORT_REASON',
      );
    });
  });
}
