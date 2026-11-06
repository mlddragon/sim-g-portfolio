import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  brainRecordId,
  providerRecordId,
} from '../../src/domain/identifiers.js';
import type { BrainRecord } from '../../src/domain/records.js';
import type { ApprovalProjectionPort } from '../../src/ports/approval-projection.js';
import type { AuditSink } from '../../src/ports/audit-sink.js';
import type { Clock } from '../../src/ports/clock.js';
import type { GovernanceSource } from '../../src/ports/governance-source.js';
import type { IdentityProvider } from '../../src/ports/identity-provider.js';
import type {
  FetchableKnowledgeProvider,
  MutableKnowledgeProvider,
  ProviderFetchRequest,
  ProviderSearchRequest,
} from '../../src/ports/knowledge-provider.js';
import type {
  OperationalStateStore,
  StoredElevationChallenge,
} from '../../src/ports/operational-state-store.js';
import type { SecretProvider } from '../../src/ports/secret-provider.js';
import type { TelemetrySink } from '../../src/ports/telemetry-sink.js';

const githubRecord: BrainRecord = {
  brainRecordId: brainRecordId('brn_test_project_readme'),
  title: 'Synthetic project README',
  excerpt: 'Fictional architecture notes.',
  content: '# Synthetic project',
  contentType: 'text/markdown',
  canonicalLocation: {
    provider: 'github',
    containerRef: 'repo:example/synthetic-project',
  },
  provenance: {
    provider: 'github',
    providerRecordId: providerRecordId('README.md@0123456789abcdef'),
    providerVersion: '0123456789abcdef',
    createdAt: new Date('2042-01-02T03:04:05.000Z'),
    updatedAt: new Date('2042-01-03T03:04:05.000Z'),
  },
  policy: {
    scope: 'family_shared',
    sensitivity: 'family_shared',
    protectedClass: 'none',
  },
};

const githubReadProvider = {
  provider: 'github',
  search(request: ProviderSearchRequest, _signal: AbortSignal) {
    return Promise.resolve({
      records: request.limit > 0 ? [githubRecord] : [],
      completeness: {
        provider: 'github',
        state: 'complete',
      },
    } as const);
  },
  fetch(_request: ProviderFetchRequest, _signal: AbortSignal) {
    return Promise.resolve(githubRecord);
  },
} satisfies FetchableKnowledgeProvider;

function typescriptFiles(root: string): readonly string[] {
  const files: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...typescriptFiles(path));
    } else if (extname(entry.name) === '.ts') {
      files.push(path);
    }
  }

  return files;
}

describe('core portability boundaries', () => {
  it('keeps GitHub read-only by capability and by runtime shape', () => {
    expectTypeOf(githubReadProvider).toExtend<FetchableKnowledgeProvider>();
    expectTypeOf(githubReadProvider).not.toExtend<MutableKnowledgeProvider>();
    expectTypeOf<'github'>().not.toExtend<
      MutableKnowledgeProvider['provider']
    >();
    expect(githubReadProvider).not.toHaveProperty('create');
    expect(githubReadProvider).not.toHaveProperty('update');
    expect(githubReadProvider).not.toHaveProperty('append');
    expect(githubReadProvider).not.toHaveProperty('trash');
  });

  it('declares every infrastructure dependency as an inward-facing port', () => {
    expectTypeOf<IdentityProvider>().toBeObject();
    expectTypeOf<OperationalStateStore>().toBeObject();
    expectTypeOf<OperationalStateStore>().toHaveProperty(
      'setApprovalProjectionReference',
    );
    expectTypeOf<StoredElevationChallenge>().toHaveProperty(
      'confirmationTokenHash',
    );
    expectTypeOf<AuditSink>().toBeObject();
    expectTypeOf<TelemetrySink>().toBeObject();
    expectTypeOf<SecretProvider>().toBeObject();
    expectTypeOf<ApprovalProjectionPort>().toBeObject();
    expectTypeOf<GovernanceSource>().toBeObject();
    expectTypeOf<Clock>().toBeObject();
  });

  it('does not import transport, database, cloud, or provider SDKs in core', () => {
    const coreRoots = [
      'src/domain',
      'src/application',
      'src/ports',
      'src/config',
    ].filter((root) => existsSync(root));
    const forbiddenImports = [
      '@google-cloud/',
      '@notionhq/',
      '@octokit/',
      'googleapis',
      "from 'fastify'",
      'from "fastify"',
      "from 'pg'",
      'from "pg"',
    ];

    const violations = coreRoots.flatMap((root) =>
      typescriptFiles(root).flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        return forbiddenImports
          .filter((forbiddenImport) => source.includes(forbiddenImport))
          .map((forbiddenImport) => ({ path, forbiddenImport }));
      }),
    );

    expect(violations).toEqual([]);
  });
});
