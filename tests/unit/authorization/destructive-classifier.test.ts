import { describe, expect, it } from 'vitest';

import { DestructiveClassifier } from '../../../src/domain/authorization/destructive-classifier.js';

const classifier = new DestructiveClassifier();

describe('DestructiveClassifier', () => {
  it('fails closed when an update has no classified mutation shape', () => {
    expect(
      classifier.classify({
        operation: 'update_record',
        targetCount: 1,
        selection: 'explicit',
        explicitIntent: true,
        protectedClass: 'none',
      }),
    ).toEqual({
      kind: 'FORBIDDEN_DESTRUCTIVE',
      reasonCode: 'update_mutation_required',
    });
  });

  it('keeps ordinary field patches and append/create operations non-destructive', () => {
    expect(
      classifier.classify({
        operation: 'update_record',
        updateMutation: { mode: 'patch', patch: { title: 'Synthetic' } },
        targetCount: 1,
        selection: 'explicit',
        explicitIntent: true,
        protectedClass: 'none',
      }),
    ).toEqual({ kind: 'NON_DESTRUCTIVE', reasonCode: 'ordinary_update' });

    for (const operation of [
      'persist_knowledge',
      'append_to_record',
    ] as const) {
      expect(
        classifier.classify({
          operation,
          targetCount: operation === 'persist_knowledge' ? 0 : 1,
          selection: 'explicit',
          explicitIntent: true,
          protectedClass: 'none',
        }),
      ).toMatchObject({ kind: 'NON_DESTRUCTIVE' });
    }
  });

  it('classifies a full replacement as destructive and an empty replacement as high blast radius', () => {
    expect(
      classifier.classify({
        operation: 'update_record',
        updateMutation: {
          mode: 'replace',
          replacement: { content: 'Synthetic replacement' },
        },
        targetCount: 1,
        selection: 'explicit',
        explicitIntent: true,
        protectedClass: 'none',
      }),
    ).toEqual({
      kind: 'ROUTINE_DESTRUCTIVE',
      reasonCode: 'explicit_single_replacement',
    });

    expect(
      classifier.classify({
        operation: 'update_record',
        updateMutation: {
          mode: 'replace',
          replacement: { content: '' },
        },
        targetCount: 1,
        selection: 'explicit',
        explicitIntent: true,
        protectedClass: 'none',
      }),
    ).toEqual({
      kind: 'HIGH_BLAST_RADIUS',
      reasonCode: 'empty_body_replacement',
    });
  });

  it('permits only a single explicitly selected delete to remain routine', () => {
    expect(
      classifier.classify({
        operation: 'delete_record',
        targetCount: 1,
        selection: 'explicit',
        explicitIntent: true,
        protectedClass: 'none',
      }),
    ).toEqual({
      kind: 'ROUTINE_DESTRUCTIVE',
      reasonCode: 'explicit_single_delete',
    });
  });

  it.each([
    ['multiple targets', { targetCount: 2 }],
    ['broad selector', { selection: 'broad' as const }],
    ['inferred selector', { selection: 'inferred' as const }],
    ['missing explicit intent', { explicitIntent: false }],
  ])('elevates %s', (_name, override) => {
    expect(
      classifier.classify({
        operation: 'delete_record',
        targetCount: 1,
        selection: 'explicit',
        explicitIntent: true,
        protectedClass: 'none',
        ...override,
      }),
    ).toMatchObject({ kind: 'HIGH_BLAST_RADIUS' });
  });

  it.each(['protected', 'governance', 'security'] as const)(
    'runs %s protection before ordinary delete classification',
    (protectedClass) => {
      expect(
        classifier.classify({
          operation: 'delete_record',
          targetCount: 1,
          selection: 'explicit',
          explicitIntent: true,
          protectedClass,
        }),
      ).toEqual({
        kind: 'PROTECTED_DESTRUCTIVE',
        reasonCode: `${protectedClass}_record_destructive`,
      });
    },
  );

  it('forbids legal-hold destruction before all other rules', () => {
    expect(
      classifier.classify({
        operation: 'delete_record',
        targetCount: 50,
        selection: 'broad',
        explicitIntent: false,
        protectedClass: 'legal_hold',
      }),
    ).toEqual({
      kind: 'FORBIDDEN_DESTRUCTIVE',
      reasonCode: 'legal_hold_destructive_forbidden',
    });
  });
});
