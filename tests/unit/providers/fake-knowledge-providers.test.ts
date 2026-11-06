import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  brainRecordId,
  operationId,
  providerRecordId,
} from '../../../src/domain/identifiers.js';
import type {
  BrainRecord,
  BrainScope,
  KnowledgeProviderName,
} from '../../../src/domain/records.js';
import type {
  FetchableKnowledgeProvider,
  MutableKnowledgeProvider,
  ProviderAccessScope,
} from '../../../src/ports/knowledge-provider.js';
import {
  fetchableKnowledgeProviderContract,
  mutableKnowledgeProviderContract,
} from '../../contract/knowledge-provider.contract.js';
import {
  FakeFetchableKnowledgeProvider,
  FakeMutableKnowledgeProvider,
} from '../../support/fake-knowledge-providers.js';

const fixedTime = new Date('2042-01-02T03:04:05.000Z');

interface Fixture {
  readonly access: ProviderAccessScope;
  readonly visible: BrainRecord;
  readonly records: readonly BrainRecord[];
  readonly hiddenProviderRecordIds: readonly ReturnType<
    typeof providerRecordId
  >[];
  readonly unconfiguredRootRef: string;
  readonly unconfiguredBrainScope: BrainScope;
}

function record(
  provider: KnowledgeProviderName,
  suffix: string,
  rootRef: string,
  scope: BrainScope,
  title: string,
): BrainRecord {
  return {
    brainRecordId: brainRecordId(`brn_${provider}_${suffix}`),
    title,
    excerpt: `Fictional ${provider} excerpt for ${suffix}.`,
    content: `Synthetic ${provider} content for ${suffix}.`,
    contentType: provider === 'github' ? 'text/markdown' : 'text/plain',
    canonicalLocation: {
      provider,
      containerRef: rootRef,
      displayPath: `/synthetic/${suffix}`,
    },
    provenance: {
      provider,
      providerRecordId: providerRecordId(`${provider}_${suffix}`),
      providerVersion: `${provider}_version_${suffix}`,
      createdAt: fixedTime,
      updatedAt: fixedTime,
      integrityHash: `sha256:synthetic_${provider}_${suffix}`,
    },
    policy: {
      scope,
      sensitivity: scope === 'family_shared' ? 'family_shared' : 'restricted',
      protectedClass: scope === 'legal' ? 'legal_hold' : 'none',
    },
  };
}

function fixture(provider: KnowledgeProviderName): Fixture {
  const rootRef =
    provider === 'github'
      ? 'repo:example/synthetic-project'
      : `${provider}:synthetic-family-shared`;
  const unconfiguredRootRef =
    provider === 'github'
      ? 'repo:example/unregistered-project'
      : `${provider}:synthetic-unregistered-root`;
  const visible = record(
    provider,
    'visible_checklist',
    rootRef,
    'family_shared',
    'Synthetic shared checklist',
  );
  const hiddenRoot = record(
    provider,
    'hidden_root_checklist',
    unconfiguredRootRef,
    'family_shared',
    'Synthetic hidden-root checklist',
  );
  const hiddenScope = record(
    provider,
    'hidden_scope_checklist',
    rootRef,
    'legal',
    'Synthetic hidden-scope checklist',
  );
  const providerTaintedVisible = Object.assign({}, visible, {
    providerRawObject: {
      token: 'SYNTHETIC_PROVIDER_PRIVATE_VALUE',
    },
  }) as BrainRecord;

  return {
    access: { brainScopes: ['family_shared'], rootRefs: [rootRef] },
    visible,
    records: [providerTaintedVisible, hiddenRoot, hiddenScope],
    hiddenProviderRecordIds: [
      hiddenRoot.provenance.providerRecordId,
      hiddenScope.provenance.providerRecordId,
    ],
    unconfiguredRootRef,
    unconfiguredBrainScope: 'legal',
  };
}

for (const provider of ['notion', 'drive', 'github'] as const) {
  const data = fixture(provider);
  fetchableKnowledgeProviderContract({
    name: `synthetic ${provider}`,
    provider,
    getProvider: () =>
      new FakeFetchableKnowledgeProvider(provider, data.records, {
        configuredAccess: data.access,
      }),
    visibleRecord: data.visible,
    hiddenProviderRecordIds: data.hiddenProviderRecordIds,
    authorizedAccess: data.access,
    unconfiguredRootRef: data.unconfiguredRootRef,
    unconfiguredBrainScope: data.unconfiguredBrainScope,
    matchingQuery: 'checklist',
  });
}

for (const provider of ['notion', 'drive'] as const) {
  const data = fixture(provider);
  const unknownCreateOperationId = operationId(
    `op_contract_${provider}_unknown_create`,
  );
  mutableKnowledgeProviderContract({
    name: `synthetic ${provider}`,
    provider,
    getProvider: () =>
      new FakeMutableKnowledgeProvider(provider, data.records, {
        configuredAccess: data.access,
        now: () => fixedTime,
        unknownOperationIds: [unknownCreateOperationId],
      }),
    visibleRecord: data.visible,
    hiddenProviderRecordIds: data.hiddenProviderRecordIds,
    authorizedAccess: data.access,
    unconfiguredRootRef: data.unconfiguredRootRef,
    unconfiguredBrainScope: data.unconfiguredBrainScope,
    matchingQuery: 'checklist',
    unknownCreateOperationId,
  });
}

describe('knowledge-provider fake capability shape', () => {
  it('keeps GitHub read-only by type and runtime surface', () => {
    const data = fixture('github');
    const github = new FakeFetchableKnowledgeProvider('github', data.records, {
      configuredAccess: data.access,
    });

    expectTypeOf(github).toExtend<FetchableKnowledgeProvider>();
    expectTypeOf(github).not.toExtend<MutableKnowledgeProvider>();
    expect(github).not.toHaveProperty('create');
    expect(github).not.toHaveProperty('update');
    expect(github).not.toHaveProperty('append');
    expect(github).not.toHaveProperty('trash');
    expect(github).not.toHaveProperty('reconcile');
  });

  it('limits mutable fake providers to Notion and Drive at compile time', () => {
    expectTypeOf<
      ConstructorParameters<typeof FakeMutableKnowledgeProvider>[0]
    >().toEqualTypeOf<'notion' | 'drive'>();
  });

  it('rejects GitHub mutable construction when runtime input bypasses TypeScript', () => {
    const data = fixture('github');

    expect(
      () =>
        new FakeMutableKnowledgeProvider('github' as never, data.records, {
          configuredAccess: data.access,
        }),
    ).toThrow('invalid_fake_knowledge_provider_configuration');
  });
});
