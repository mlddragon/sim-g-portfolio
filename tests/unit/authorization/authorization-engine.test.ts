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
import type {
  AuthorizationDecisionKind,
  BrainOperationName,
  TargetAuthorizationFacts,
} from '../../../src/domain/operations.js';
import type {
  BrainPrincipal,
  PrincipalRole,
} from '../../../src/domain/principal.js';
import { brainScopes, type BrainScope } from '../../../src/domain/records.js';
import { loadExecutablePolicy } from '../../../src/domain/policy/policy-loader.js';

const now = new Date('2042-06-07T08:09:10.000Z');
const policyContent = readFileSync(
  new URL('../../../config/policy/family-brain-v1.yaml', import.meta.url),
  'utf8',
);
const policy = loadExecutablePolicy(policyContent);
const classifier = new DestructiveClassifier();
const engine = new AuthorizationEngine(policy, { now: () => now });

function principal(role: PrincipalRole): BrainPrincipal {
  const key =
    role === 'owner_operator'
      ? 'operator'
      : role === 'parent_steward'
        ? 'steward'
        : 'participant';
  return {
    id: principalId(`prn_${key}`),
    key,
    displayName: key.charAt(0).toUpperCase() + key.slice(1),
    role,
    status: 'active',
  };
}

function target(
  scope: BrainScope,
  owner: BrainPrincipal,
  override: Partial<TargetAuthorizationFacts> = {},
): TargetAuthorizationFacts {
  return {
    scope,
    creatorPrincipalId: owner.id,
    createdAt: new Date(now.getTime() - 60_000),
    protectedClass: 'none',
    ...override,
  };
}

function ordinaryDestructive(operation: BrainOperationName) {
  return classifier.classify({
    operation,
    ...(operation === 'update_record'
      ? {
          updateMutation: {
            mode: 'patch' as const,
            patch: { title: 'Synthetic' },
          },
        }
      : {}),
    targetCount: operation === 'persist_knowledge' ? 0 : 1,
    selection: 'explicit',
    explicitIntent: true,
    protectedClass: 'none',
  });
}

const roles = [
  'owner_operator',
  'parent_steward',
  'family_participant',
] as const;
const operations = [
  'search_brain',
  'fetch_record',
  'persist_knowledge',
  'update_record',
  'append_to_record',
  'delete_record',
  'list_approvals',
  'resolve_approval',
] as const;

function expectedDecision(
  role: PrincipalRole,
  operation: BrainOperationName,
  scope: BrainScope,
): AuthorizationDecisionKind {
  if (operation === 'list_approvals' || operation === 'resolve_approval') {
    return role === 'family_participant' ? 'DENY' : 'ALLOW';
  }

  const scopeAllowed =
    role === 'owner_operator' ||
    (role === 'parent_steward' &&
      ['family_shared', 'parent_and_stewardship', 'legal'].includes(scope)) ||
    (role === 'family_participant' && scope === 'family_shared');
  if (!scopeAllowed) {
    return 'DENY';
  }

  const mutation = [
    'persist_knowledge',
    'update_record',
    'append_to_record',
    'delete_record',
  ].includes(operation);
  if (
    mutation &&
    (scope === 'governance' || scope === 'security' || scope === 'legal')
  ) {
    return role === 'family_participant' ? 'DENY' : 'ELEVATION_REQUIRED';
  }

  return 'ALLOW';
}

describe('AuthorizationEngine', () => {
  it.each(
    roles.flatMap((role) =>
      operations.flatMap((operation) =>
        brainScopes.map((scope) => ({ role, operation, scope })),
      ),
    ),
  )(
    'applies the v1 matrix for $role $operation in $scope',
    ({ role, operation, scope }) => {
      const actor = principal(role);
      const decision = engine.evaluate({
        principal: actor,
        operation,
        scope,
        target: target(scope, actor),
        destructive: ordinaryDestructive(operation),
      });

      expect(decision.kind).toBe(expectedDecision(role, operation, scope));
      expect(decision.policyVersion).toBe('family-brain-v1.2.0');
    },
  );

  it.each([
    'fetch_record',
    'update_record',
    'append_to_record',
    'delete_record',
  ] as const)(
    'denies %s without authoritative target metadata',
    (operation) => {
      const operator = principal('owner_operator');
      expect(
        engine.evaluate({
          principal: operator,
          operation,
          scope: 'family_shared',
          ...(operation === 'fetch_record'
            ? {}
            : { destructive: ordinaryDestructive(operation) }),
        }),
      ).toMatchObject({
        kind: 'DENY',
        reasonCode: 'authoritative_target_required',
      });
    },
  );

  it('denies a target whose authoritative scope differs from the evaluated scope', () => {
    const operator = principal('owner_operator');
    expect(
      engine.evaluate({
        principal: operator,
        operation: 'fetch_record',
        scope: 'family_shared',
        target: target('parent_and_stewardship', operator),
      }),
    ).toMatchObject({
      kind: 'DENY',
      reasonCode: 'target_scope_mismatch',
    });
  });

  it.each([
    [14 * 60_000 + 59_999, 'ALLOW'],
    [15 * 60_000, 'ALLOW'],
    [15 * 60_000 + 1, 'APPROVAL_REQUIRED'],
  ] as const)(
    'evaluates Participant delete at elapsed %i milliseconds as %s',
    (elapsedMs, expected) => {
      const participant = principal('family_participant');
      expect(
        engine.evaluate({
          principal: participant,
          operation: 'delete_record',
          scope: 'family_shared',
          target: target('family_shared', participant, {
            createdAt: new Date(now.getTime() - elapsedMs),
          }),
          destructive: classifier.classify({
            operation: 'delete_record',
            targetCount: 1,
            selection: 'explicit',
            explicitIntent: true,
            protectedClass: 'none',
          }),
        }).kind,
      ).toBe(expected);
    },
  );

  it.each([
    [14 * 60_000 + 59_999, 'ALLOW'],
    [15 * 60_000, 'ALLOW'],
    [15 * 60_000 + 1, 'APPROVAL_REQUIRED'],
  ] as const)(
    'applies the same exact boundary to Participant full replacement at %i milliseconds',
    (elapsedMs, expected) => {
      const participant = principal('family_participant');
      expect(
        engine.evaluate({
          principal: participant,
          operation: 'update_record',
          scope: 'family_shared',
          target: target('family_shared', participant, {
            createdAt: new Date(now.getTime() - elapsedMs),
          }),
          destructive: classifier.classify({
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
        }).kind,
      ).toBe(expected);
    },
  );

  it('requires approval when an Participant destructive target is not hers', () => {
    const participant = principal('family_participant');
    const operator = principal('owner_operator');
    expect(
      engine.evaluate({
        principal: participant,
        operation: 'delete_record',
        scope: 'family_shared',
        target: target('family_shared', operator),
        destructive: classifier.classify({
          operation: 'delete_record',
          targetCount: 1,
          selection: 'explicit',
          explicitIntent: true,
          protectedClass: 'none',
        }),
      }),
    ).toMatchObject({
      kind: 'APPROVAL_REQUIRED',
      reasonCode: 'participant_parent_approval_required',
    });
  });

  it.each([
    ['protected', 'APPROVAL_REQUIRED'],
    ['legal_hold', 'DENY'],
    ['governance', 'DENY'],
    ['security', 'DENY'],
  ] as const)(
    'runs %s protection before Participant creator-window logic',
    (protectedClass, expected) => {
      const participant = principal('family_participant');
      const destructive = classifier.classify({
        operation: 'delete_record',
        targetCount: 1,
        selection: 'explicit',
        explicitIntent: true,
        protectedClass,
      });
      expect(
        engine.evaluate({
          principal: participant,
          operation: 'delete_record',
          scope: 'family_shared',
          target: target('family_shared', participant, { protectedClass }),
          destructive,
        }).kind,
      ).toBe(expected);
    },
  );

  describe('legal-hold original evidence is immutable', () => {
    const titlePatch = {
      mode: 'patch' as const,
      patch: { title: 'Synthetic' },
    };
    const mutations = [
      ['title patch', 'update_record', titlePatch],
      [
        'replacement',
        'update_record',
        { mode: 'replace' as const, replacement: { content: 'Synthetic' } },
      ],
      ['append', 'append_to_record', undefined],
      ['delete', 'delete_record', undefined],
    ] as const;

    it('declares the immutability rule in the versioned executable policy', () => {
      expect(policy.version).toBe('family-brain-v1.2.0');
      expect(policy.legalHoldEvidence).toBe('immutable');
    });

    it.each(
      mutations.flatMap(([name, operation, updateMutation]) =>
        (
          ['owner_operator', 'parent_steward', 'family_participant'] as const
        ).map((role) => [name, role, operation, updateMutation] as const),
      ),
    )(
      'denies a %s by %s before approval, elevation or creator-window logic',
      (_, role, operation, updateMutation) => {
        const actor = principal(role);
        const targetId = brainRecordId('brn_synthetic_evidence');
        const opId = operationId('op_synthetic_evidence');
        const destructive = classifier.classify({
          operation,
          ...(updateMutation === undefined ? {} : { updateMutation }),
          targetCount: 1,
          selection: 'explicit',
          explicitIntent: true,
          protectedClass: 'legal_hold',
        });
        expect(
          engine.evaluate({
            principal: actor,
            operation,
            scope: 'family_shared',
            target: target('family_shared', actor, {
              protectedClass: 'legal_hold',
            }),
            destructive,
            operationContext: {
              operationId: opId,
              requestFingerprint: 'a'.repeat(64),
              targetIds: [targetId],
            },
            confirmedElevation: {
              challengeId: elevationChallengeId('elv_synthetic_evidence'),
              operationId: opId,
              principalId: actor.id,
              operation,
              requestFingerprint: 'a'.repeat(64),
              policyVersion: policy.version,
              frozenTargetIds: [targetId],
              consumedAt: now,
            },
          }),
        ).toMatchObject({
          kind: 'DENY',
          reasonCode: 'legal_hold_evidence_immutable',
        });
      },
    );

    it.each(
      (['owner_operator', 'parent_steward'] as const).flatMap((role) =>
        (
          [
            ['title patch', 'update_record'],
            ['append', 'append_to_record'],
          ] as const
        ).map(([name, operation]) => [role, name, operation] as const),
      ),
    )(
      'denies %s a legal-scope %s that exact elevation would otherwise allow',
      (role, _, operation) => {
        const actor = principal(role);
        const targetId = brainRecordId('brn_synthetic_legal_evidence');
        const opId = operationId('op_synthetic_legal_evidence');
        const request = (protectedClass: 'none' | 'legal_hold') => ({
          principal: actor,
          operation,
          scope: 'legal' as const,
          target: target('legal', actor, { protectedClass }),
          destructive: classifier.classify({
            operation,
            ...(operation === 'update_record'
              ? {
                  updateMutation: {
                    mode: 'patch' as const,
                    patch: { title: 'Synthetic' },
                  },
                }
              : {}),
            targetCount: 1,
            selection: 'explicit',
            explicitIntent: true,
            protectedClass,
          }),
          operationContext: {
            operationId: opId,
            requestFingerprint: 'a'.repeat(64),
            targetIds: [targetId],
          },
          confirmedElevation: {
            challengeId: elevationChallengeId('elv_synthetic_legal_evidence'),
            operationId: opId,
            principalId: actor.id,
            operation,
            requestFingerprint: 'a'.repeat(64),
            policyVersion: policy.version,
            frozenTargetIds: [targetId],
            consumedAt: now,
          },
        });
        expect(engine.evaluate(request('none')).kind).toBe('ALLOW');
        expect(engine.evaluate(request('legal_hold'))).toMatchObject({
          kind: 'DENY',
          reasonCode: 'legal_hold_evidence_immutable',
        });
      },
    );

    it.each([
      'owner_operator',
      'parent_steward',
      'family_participant',
    ] as const)('still lets %s read legal-hold evidence', (role) => {
      const actor = principal(role);
      expect(
        engine.evaluate({
          principal: actor,
          operation: 'fetch_record',
          scope: 'family_shared',
          target: target('family_shared', actor, {
            protectedClass: 'legal_hold',
          }),
        }).kind,
      ).toBe('ALLOW');
    });
  });

  it('forbids a legal-hold delete for Operator even with otherwise matching elevation', () => {
    const operator = principal('owner_operator');
    const targetId = brainRecordId('brn_synthetic_legal_hold');
    const opId = operationId('op_synthetic_legal_hold');
    expect(
      engine.evaluate({
        principal: operator,
        operation: 'delete_record',
        scope: 'legal',
        target: target('legal', operator, { protectedClass: 'legal_hold' }),
        destructive: classifier.classify({
          operation: 'delete_record',
          targetCount: 1,
          selection: 'explicit',
          explicitIntent: true,
          protectedClass: 'legal_hold',
        }),
        operationContext: {
          operationId: opId,
          requestFingerprint: 'a'.repeat(64),
          targetIds: [targetId],
        },
        confirmedElevation: {
          challengeId: elevationChallengeId('elv_synthetic_legal_hold'),
          operationId: opId,
          principalId: operator.id,
          operation: 'delete_record',
          requestFingerprint: 'a'.repeat(64),
          policyVersion: policy.version,
          frozenTargetIds: [targetId],
          consumedAt: now,
        },
      }).kind,
    ).toBe('DENY');
  });

  it.each(['owner_operator', 'parent_steward'] as const)(
    'allows an exact consumed elevation for %s',
    (role) => {
      const actor = principal(role);
      const opId = operationId(`op_synthetic_elevated_${role}`);
      const targetId = brainRecordId(`brn_synthetic_elevated_${role}`);
      expect(
        engine.evaluate({
          principal: actor,
          operation: 'delete_record',
          scope: 'family_shared',
          target: target('family_shared', actor),
          destructive: {
            kind: 'HIGH_BLAST_RADIUS',
            reasonCode: 'broad_selector',
          },
          operationContext: {
            operationId: opId,
            requestFingerprint: 'b'.repeat(64),
            targetIds: [targetId],
          },
          confirmedElevation: {
            challengeId: elevationChallengeId(`elv_synthetic_elevated_${role}`),
            operationId: opId,
            principalId: actor.id,
            operation: 'delete_record',
            requestFingerprint: 'b'.repeat(64),
            policyVersion: policy.version,
            frozenTargetIds: [targetId],
            consumedAt: now,
          },
        }),
      ).toMatchObject({
        kind: 'ALLOW',
        reasonCode: 'elevated_action_confirmed',
      });
    },
  );

  it.each([
    ['principal', { principalId: principalId('prn_someone_else') }],
    ['operation', { operation: 'update_record' as const }],
    ['fingerprint', { requestFingerprint: 'c'.repeat(64) }],
    ['policy', { policyVersion: 'different-policy' }],
    ['targets', { frozenTargetIds: [brainRecordId('brn_different_target')] }],
  ])('rejects confirmed elevation with mismatched %s', (_name, override) => {
    const operator = principal('owner_operator');
    const opId = operationId('op_synthetic_mismatch');
    const targetId = brainRecordId('brn_synthetic_mismatch');
    expect(
      engine.evaluate({
        principal: operator,
        operation: 'delete_record',
        scope: 'family_shared',
        target: target('family_shared', operator),
        destructive: {
          kind: 'HIGH_BLAST_RADIUS',
          reasonCode: 'broad_selector',
        },
        operationContext: {
          operationId: opId,
          requestFingerprint: 'b'.repeat(64),
          targetIds: [targetId],
        },
        confirmedElevation: {
          challengeId: elevationChallengeId('elv_synthetic_mismatch'),
          operationId: opId,
          principalId: operator.id,
          operation: 'delete_record',
          requestFingerprint: 'b'.repeat(64),
          policyVersion: policy.version,
          frozenTargetIds: [targetId],
          consumedAt: now,
          ...override,
        },
      }).kind,
    ).toBe('ELEVATION_REQUIRED');
  });

  it('never permits Participant to elevate a broad action', () => {
    const participant = principal('family_participant');
    const opId = operationId('op_synthetic_participant_elevation');
    const targetId = brainRecordId('brn_synthetic_participant_elevation');
    expect(
      engine.evaluate({
        principal: participant,
        operation: 'delete_record',
        scope: 'family_shared',
        target: target('family_shared', participant),
        destructive: {
          kind: 'HIGH_BLAST_RADIUS',
          reasonCode: 'broad_selector',
        },
        operationContext: {
          operationId: opId,
          requestFingerprint: 'd'.repeat(64),
          targetIds: [targetId],
        },
        confirmedElevation: {
          challengeId: elevationChallengeId(
            'elv_synthetic_participant_elevation',
          ),
          operationId: opId,
          principalId: participant.id,
          operation: 'delete_record',
          requestFingerprint: 'd'.repeat(64),
          policyVersion: policy.version,
          frozenTargetIds: [targetId],
          consumedAt: now,
        },
      }).kind,
    ).toBe('APPROVAL_REQUIRED');
  });

  it('allows either parent to list and resolve approvals, but never Participant', () => {
    for (const role of ['owner_operator', 'parent_steward'] as const) {
      for (const operation of ['list_approvals', 'resolve_approval'] as const) {
        expect(
          engine.evaluate({ principal: principal(role), operation }).kind,
        ).toBe('ALLOW');
      }
    }
    for (const operation of ['list_approvals', 'resolve_approval'] as const) {
      expect(
        engine.evaluate({
          principal: principal('family_participant'),
          operation,
        }).kind,
      ).toBe('DENY');
    }
  });

  it('intersects principal scope with registered provider surfaces', () => {
    const surfaces = [
      {
        provider: 'notion' as const,
        scope: 'family_shared' as const,
        containerKey: 'notion.family_shared',
      },
      {
        provider: 'notion' as const,
        scope: 'parent_and_stewardship' as const,
        containerKey: 'notion.parent_and_stewardship',
      },
      {
        provider: 'drive' as const,
        scope: 'legal' as const,
        containerKey: 'drive.legal',
      },
      {
        provider: 'github' as const,
        scope: 'governance' as const,
        containerKey: 'github.synthetic',
      },
    ];

    expect(
      engine.authorizedSearchSurfaces(
        principal('family_participant'),
        surfaces,
      ),
    ).toEqual([surfaces[0]]);
    expect(
      engine.authorizedSearchSurfaces(principal('parent_steward'), surfaces),
    ).toEqual(surfaces.slice(0, 3));
    expect(
      engine.authorizedSearchSurfaces(principal('owner_operator'), surfaces),
    ).toEqual(surfaces);
  });

  it('denies disabled principals before all policy evaluation', () => {
    expect(
      engine.evaluate({
        principal: { ...principal('owner_operator'), status: 'disabled' },
        operation: 'search_brain',
        scope: 'family_shared',
      }),
    ).toMatchObject({ kind: 'DENY', reasonCode: 'principal_disabled' });
  });
});
