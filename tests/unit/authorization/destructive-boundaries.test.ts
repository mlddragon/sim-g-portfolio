import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AuthorizationEngine } from '../../../src/domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from '../../../src/domain/authorization/destructive-classifier.js';
import {
  brainRecordId,
  elevationChallengeId,
  operationId,
  principalId,
} from '../../../src/domain/identifiers.js';
import type { UpdateMutation } from '../../../src/domain/operations.js';
import { loadExecutablePolicy } from '../../../src/domain/policy/policy-loader.js';
import type { BrainPrincipal } from '../../../src/domain/principal.js';
import type {
  BrainScope,
  ProtectedClass,
} from '../../../src/domain/records.js';

const now = new Date('2042-06-07T08:09:10.000Z');
const policy = loadExecutablePolicy(
  readFileSync('config/policy/family-brain-v1.yaml', 'utf8'),
);
const classifier = new DestructiveClassifier();
const engine = new AuthorizationEngine(policy, { now: () => now });
const participant: BrainPrincipal = {
  id: principalId('prn_participant'),
  key: 'participant',
  displayName: 'Participant',
  role: 'family_participant',
  status: 'active',
};

function classify(mutation: unknown, protectedClass: ProtectedClass = 'none') {
  return classifier.classify({
    operation: 'update_record',
    updateMutation: mutation as UpdateMutation,
    targetCount: 1,
    selection: 'explicit',
    explicitIntent: true,
    protectedClass,
  });
}

describe('destructive policy boundaries', () => {
  it.each([
    ['replacement', 'Synthetic replacement', 'ROUTINE_DESTRUCTIVE'],
    ['empty replacement', '', 'HIGH_BLAST_RADIUS'],
  ] as const)(
    'classifies a patch containing %s by its effect',
    (_name, content, kind) => {
      const patch = classify({ mode: 'patch', patch: { content } });
      const replacement = classify({
        mode: 'replace',
        replacement: { content },
      });

      expect(patch.kind).toBe(kind);
      expect(patch).toEqual(replacement);
    },
  );

  it.each([
    [899_999, 'prn_participant', 'ALLOW'],
    [900_000, 'prn_participant', 'ALLOW'],
    [900_001, 'prn_participant', 'APPROVAL_REQUIRED'],
    [60_000, 'prn_operator', 'APPROVAL_REQUIRED'],
  ] as const)(
    'applies the creator window to a content patch at %i ms for %s',
    (elapsed, creator, expected) => {
      expect(
        engine.evaluate({
          principal: participant,
          operation: 'update_record',
          scope: 'family_shared',
          target: {
            scope: 'family_shared',
            creatorPrincipalId: principalId(creator),
            createdAt: new Date(now.getTime() - elapsed),
            protectedClass: 'none',
          },
          destructive: classify({
            mode: 'patch',
            patch: { content: 'Synthetic new body' },
          }),
        }).kind,
      ).toBe(expected);
    },
  );

  it('forbids replacing legal-hold content through a patch', () => {
    expect(
      classify(
        { mode: 'patch', patch: { content: 'Synthetic replacement' } },
        'legal_hold',
      ),
    ).toMatchObject({
      kind: 'FORBIDDEN_DESTRUCTIVE',
      reasonCode: 'legal_hold_destructive_forbidden',
    });
  });

  it.each([
    { mode: 'patch', patch: { scope: 'family_shared' } },
    { mode: 'patch', patch: { protectedClass: 'none' } },
    { mode: 'patch', patch: { creatorPrincipalId: 'prn_participant' } },
    { mode: 'patch', patch: { createdAt: now.toISOString() } },
    { mode: 'patch', patch: { properties: { archived: true } } },
    { mode: 'patch', patch: { title: 'Synthetic', content: null } },
    { mode: 'patch', patch: { content: { blocks: [] } } },
    { mode: 'patch', patch: {} },
    { mode: 'patch', patch: null },
    { mode: 'patch', patch: [] },
    {
      mode: 'patch',
      patch: { title: 'Synthetic' },
      replacement: { content: '' },
    },
    { mode: 'replace', replacement: { content: null } },
    { mode: 'provider_raw', patch: { trash: true } },
  ])('rejects malformed or non-ordinary update payload %#', (mutation) => {
    expect(classify(mutation)).toMatchObject({
      kind: 'FORBIDDEN_DESTRUCTIVE',
      reasonCode: 'invalid_update_mutation',
    });
  });

  it('preserves routine ordinary title corrections outside the creator window', () => {
    expect(
      engine.evaluate({
        principal: participant,
        operation: 'update_record',
        scope: 'family_shared',
        target: {
          scope: 'family_shared',
          creatorPrincipalId: principalId('prn_operator'),
          createdAt: new Date('2040-01-01T00:00:00.000Z'),
          protectedClass: 'none',
        },
        destructive: classify({
          mode: 'patch',
          patch: { title: 'Synthetic correction' },
        }),
      }).kind,
    ).toBe('ALLOW');
  });

  const protectedTargets: readonly {
    scope: BrainScope;
    protectedClass: ProtectedClass;
  }[] = [
    { scope: 'family_shared', protectedClass: 'protected' },
    { scope: 'family_shared', protectedClass: 'governance' },
    { scope: 'family_shared', protectedClass: 'security' },
    { scope: 'governance', protectedClass: 'none' },
    { scope: 'security', protectedClass: 'none' },
    { scope: 'legal', protectedClass: 'none' },
  ];

  it.each(protectedTargets)(
    'keeps forbidden actions denied even with elevation in $scope/$protectedClass',
    ({ scope, protectedClass }) => {
      const operator: BrainPrincipal = {
        ...participant,
        id: principalId('prn_operator'),
        key: 'operator',
        displayName: 'Operator',
        role: 'owner_operator',
      };
      const opId = operationId('op_synthetic_forbidden_update');
      const targetId = brainRecordId('brn_synthetic_forbidden_update');
      const request = {
        principal: operator,
        operation: 'update_record' as const,
        scope,
        target: { scope, protectedClass, createdAt: now },
        destructive: {
          kind: 'FORBIDDEN_DESTRUCTIVE' as const,
          reasonCode: 'invalid_update_mutation',
        },
        operationContext: {
          operationId: opId,
          requestFingerprint: 'a'.repeat(64),
          targetIds: [targetId],
        },
      };
      const expected = { kind: 'DENY', reasonCode: 'invalid_update_mutation' };
      expect(engine.evaluate(request)).toMatchObject(expected);
      expect(
        engine.evaluate({
          ...request,
          confirmedElevation: {
            challengeId: elevationChallengeId('elv_synthetic_forbidden_update'),
            principalId: operator.id,
            operationId: opId,
            operation: 'update_record',
            requestFingerprint: 'a'.repeat(64),
            policyVersion: policy.version,
            frozenTargetIds: [targetId],
            consumedAt: now,
          },
        }),
      ).toMatchObject(expected);
    },
  );
});
