import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CanonicalRouter } from '../../../src/domain/routing/canonical-router.js';
import { loadExecutablePolicy } from '../../../src/domain/policy/policy-loader.js';

const policy = loadExecutablePolicy(
  readFileSync(
    new URL('../../../config/policy/family-brain-v1.yaml', import.meta.url),
    'utf8',
  ),
);
const router = new CanonicalRouter(policy);

function metadata(recordType: string) {
  return {
    subject: 'Synthetic household subject',
    domain: 'household',
    recordType,
    durability: 'durable',
    sensitivity: 'family_shared' as const,
    provenance: 'synthetic_test',
  };
}

describe('CanonicalRouter', () => {
  it.each(['structured_record', 'knowledge', 'decision', 'procedure'] as const)(
    'routes %s to the governed Notion container',
    (recordType) => {
      expect(
        router.route({
          operation: 'persist_knowledge',
          semanticMetadata: metadata(recordType),
        }),
      ).toEqual({
        provider: 'notion',
        containerKey: 'notion.family_shared',
        operation: 'persist_knowledge',
        policyVersion: 'family-brain-v1.2.0',
        routingReason: `record_type_${recordType}`,
      });
    },
  );

  it.each(['source_document', 'file_artifact', 'legal_record'] as const)(
    'routes %s to the governed Drive container',
    (recordType) => {
      const semanticMetadata = {
        ...metadata(recordType),
        sensitivity:
          recordType === 'legal_record'
            ? ('protected' as const)
            : ('family_shared' as const),
      };
      expect(
        router.route({
          operation: 'persist_knowledge',
          semanticMetadata,
        }),
      ).toMatchObject({
        provider: 'drive',
        containerKey:
          recordType === 'legal_record'
            ? 'drive.protected'
            : 'drive.family_shared',
        routingReason: `record_type_${recordType}`,
      });
    },
  );

  it('returns all missing safety metadata in one structured retryable error', () => {
    expect(() =>
      router.route({
        operation: 'persist_knowledge',
        semanticMetadata: { subject: 'Synthetic subject' },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'insufficient_metadata',
        retryable: true,
        details: {
          missing: ['record_type', 'durability', 'sensitivity'],
        },
      }),
    );
  });

  it('rejects a conflicting non-authoritative provider hint as ambiguous', () => {
    expect(() =>
      router.route({
        operation: 'persist_knowledge',
        semanticMetadata: {
          ...metadata('decision'),
          canonicalHint: { provider: 'drive' },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'routing_ambiguous',
        retryable: true,
        details: {
          candidates: ['notion', 'drive'],
          required_decision:
            'Confirm whether this is durable structured knowledge or a canonical source file.',
        },
      }),
    );
  });

  it('does not let a matching provider hint override the governed container', () => {
    expect(() =>
      router.route({
        operation: 'persist_knowledge',
        semanticMetadata: {
          ...metadata('decision'),
          canonicalHint: {
            provider: 'notion',
            containerRef: 'unregistered-notion-container',
          },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'routing_ambiguous',
        details: {
          candidates: ['notion'],
          reason: 'canonical_container_hint_conflict',
          required_decision: 'Remove the unregistered container hint.',
        },
      }),
    );
  });

  it('asks the client to resolve an unknown record type without guessing', () => {
    expect(() =>
      router.route({
        operation: 'persist_knowledge',
        semanticMetadata: metadata('mystery_artifact'),
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'routing_ambiguous',
        details: {
          candidates: ['notion', 'drive'],
          reason: 'unsupported_record_type',
          required_decision:
            'Confirm whether this is durable structured knowledge or a canonical source file.',
        },
      }),
    );
  });

  it('never produces a GitHub mutation route from a client hint', () => {
    expect(() =>
      router.route({
        operation: 'persist_knowledge',
        semanticMetadata: {
          ...metadata('source_document'),
          canonicalHint: { provider: 'github' },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'provider_capability_unsupported',
        retryable: false,
        details: { provider: 'github', reason: 'github_read_only' },
      }),
    );
  });

  it('routes existing Notion and Drive targets by authoritative location and rejects GitHub', () => {
    for (const provider of ['notion', 'drive'] as const) {
      expect(
        router.routeExisting({
          operation: 'update_record',
          canonicalLocation: {
            provider,
            containerRef: `${provider}.family_shared`,
          },
        }),
      ).toMatchObject({ provider, operation: 'update_record' });
    }

    expect(() =>
      router.routeExisting({
        operation: 'delete_record',
        canonicalLocation: {
          provider: 'github',
          containerRef: 'github.synthetic',
        },
      }),
    ).toThrow(
      expect.objectContaining({ code: 'provider_capability_unsupported' }),
    );
  });

  it('rejects an existing record location outside the governed containers', () => {
    expect(() =>
      router.routeExisting({
        operation: 'update_record',
        canonicalLocation: {
          provider: 'notion',
          containerRef: 'notion.unregistered-container',
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'provider_capability_unsupported',
        details: {
          provider: 'notion',
          reason: 'canonical_container_not_governed',
        },
      }),
    );
  });
});
