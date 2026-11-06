import type { ConfirmedElevation } from '../../application/elevation-service.js';
import type { Clock } from '../../ports/clock.js';
import type { ExecutablePolicy } from '../policy/policy-loader.js';
import type { BrainRecordId, OperationId } from '../identifiers.js';
import type {
  AuthorizationDecision,
  BrainOperationName,
  TargetAuthorizationFacts,
} from '../operations.js';
import type { BrainPrincipal } from '../principal.js';
import type {
  BrainScope,
  KnowledgeProviderName,
  ProtectedClass,
} from '../records.js';
import type { DestructiveClassification } from './destructive-classifier.js';

const mutationOperations = new Set<BrainOperationName>([
  'persist_knowledge',
  'update_record',
  'append_to_record',
  'delete_record',
]);
const authoritativeTargetOperations = new Set<BrainOperationName>([
  'fetch_record',
  'update_record',
  'append_to_record',
  'delete_record',
]);

export interface RegisteredKnowledgeSurface {
  readonly provider: KnowledgeProviderName;
  readonly scope: BrainScope;
  readonly containerKey: string;
  /** From the executable policy's container policy; `none` when omitted. */
  readonly protectedClass?: ProtectedClass;
}

export interface AuthorizationOperationContext {
  readonly operationId: OperationId;
  readonly requestFingerprint: string;
  readonly targetIds: readonly BrainRecordId[];
}

export interface AuthorizationRequest {
  readonly principal: BrainPrincipal;
  readonly operation: BrainOperationName;
  readonly scope?: BrainScope;
  readonly target?: TargetAuthorizationFacts;
  readonly destructive?: DestructiveClassification;
  readonly operationContext?: AuthorizationOperationContext;
  readonly confirmedElevation?: ConfirmedElevation;
}

function decision(
  kind: AuthorizationDecision['kind'],
  reasonCode: string,
  policyVersion: string,
): AuthorizationDecision {
  return { kind, reasonCode, policyVersion };
}

function sameTargets(
  first: readonly BrainRecordId[],
  second: readonly BrainRecordId[],
): boolean {
  const sortedFirst = [...first].sort();
  const sortedSecond = [...second].sort();
  return (
    sortedFirst.length === sortedSecond.length &&
    sortedFirst.every((value, index) => value === sortedSecond[index])
  );
}

export class AuthorizationEngine {
  constructor(
    private readonly policy: ExecutablePolicy,
    private readonly clock: Clock,
  ) {}

  private allowedScopes(principal: BrainPrincipal): readonly BrainScope[] {
    return this.policy.roleScopes[principal.role];
  }

  private hasExactElevation(request: AuthorizationRequest): boolean {
    const elevation = request.confirmedElevation;
    const context = request.operationContext;
    return (
      request.principal.role !== 'family_participant' &&
      elevation !== undefined &&
      context !== undefined &&
      elevation.principalId === request.principal.id &&
      elevation.operationId === context.operationId &&
      elevation.operation === request.operation &&
      elevation.requestFingerprint === context.requestFingerprint &&
      elevation.policyVersion === this.policy.version &&
      sameTargets(elevation.frozenTargetIds, context.targetIds)
    );
  }

  private elevationDecision(
    request: AuthorizationRequest,
  ): AuthorizationDecision {
    return this.hasExactElevation(request)
      ? decision('ALLOW', 'elevated_action_confirmed', this.policy.version)
      : decision(
          'ELEVATION_REQUIRED',
          'explicit_elevation_required',
          this.policy.version,
        );
  }

  evaluate(request: AuthorizationRequest): AuthorizationDecision {
    const { principal, operation } = request;
    if (principal.status !== 'active') {
      return decision('DENY', 'principal_disabled', this.policy.version);
    }

    if (
      !(
        this.policy.roleOperations[
          principal.role
        ] as readonly BrainOperationName[]
      ).includes(operation)
    ) {
      return decision('DENY', 'role_operation_forbidden', this.policy.version);
    }

    if (operation === 'list_approvals' || operation === 'resolve_approval') {
      return decision(
        'ALLOW',
        'parent_approval_authority',
        this.policy.version,
      );
    }

    if (
      request.scope === undefined ||
      !this.allowedScopes(principal).includes(request.scope)
    ) {
      return decision('DENY', 'role_scope_forbidden', this.policy.version);
    }

    if (
      authoritativeTargetOperations.has(operation) &&
      request.target === undefined
    ) {
      return decision(
        'DENY',
        'authoritative_target_required',
        this.policy.version,
      );
    }
    if (
      request.target !== undefined &&
      request.target.scope !== request.scope
    ) {
      return decision('DENY', 'target_scope_mismatch', this.policy.version);
    }

    const mutation = mutationOperations.has(operation);
    if (mutation && request.destructive === undefined) {
      return decision(
        'DENY',
        'destructive_classification_required',
        this.policy.version,
      );
    }

    const protectedClass = request.target?.protectedClass ?? 'none';
    const destructiveKind = request.destructive?.kind ?? 'NON_DESTRUCTIVE';
    const destructive = destructiveKind !== 'NON_DESTRUCTIVE';

    // Original evidence under legal hold is immutable through the gateway
    // (policy `legalHoldEvidence: immutable`, the only value the schema admits):
    // no edit, title change, append, replacement or trash, even with approval
    // or elevation. New evidence and commentary are separate linked records.
    if (mutation && protectedClass === 'legal_hold') {
      return decision(
        'DENY',
        'legal_hold_evidence_immutable',
        this.policy.version,
      );
    }

    // Approval and elevation can authorize only otherwise-permitted actions.
    // A malformed or forbidden mutation cannot be rescued by protected scope.
    if (destructiveKind === 'FORBIDDEN_DESTRUCTIVE') {
      return decision(
        'DENY',
        request.destructive?.reasonCode ?? 'destructive_action_forbidden',
        this.policy.version,
      );
    }

    // Unreachable for mutations since the immutability rule above; kept as a
    // defense in depth should a destructive non-mutation operation appear.
    if (destructive && protectedClass === 'legal_hold') {
      return decision(
        'DENY',
        'legal_hold_destructive_forbidden',
        this.policy.version,
      );
    }
    if (protectedClass === 'governance' || protectedClass === 'security') {
      if (principal.role !== 'owner_operator') {
        return decision(
          'DENY',
          'control_plane_owner_only',
          this.policy.version,
        );
      }
      if (mutation) {
        return this.elevationDecision(request);
      }
    }
    if (mutation && protectedClass === 'protected') {
      if (principal.role === 'family_participant') {
        return decision(
          'APPROVAL_REQUIRED',
          'protected_action_parent_approval_required',
          this.policy.version,
        );
      }
      return this.elevationDecision(request);
    }

    if (
      mutation &&
      (this.policy.controlPlaneScopes as readonly BrainScope[]).includes(
        request.scope,
      )
    ) {
      if (principal.role !== 'owner_operator') {
        return decision(
          'DENY',
          'control_plane_owner_only',
          this.policy.version,
        );
      }
      return this.elevationDecision(request);
    }
    if (
      mutation &&
      (this.policy.protectedMutationScopes as readonly BrainScope[]).includes(
        request.scope,
      )
    ) {
      return this.elevationDecision(request);
    }

    if (principal.role === 'family_participant') {
      if (
        destructiveKind === 'HIGH_BLAST_RADIUS' ||
        destructiveKind === 'PROTECTED_DESTRUCTIVE'
      ) {
        return decision(
          'APPROVAL_REQUIRED',
          'participant_parent_approval_required',
          this.policy.version,
        );
      }
      if (destructiveKind === 'ROUTINE_DESTRUCTIVE') {
        const createdAt = request.target?.createdAt;
        const creator = request.target?.creatorPrincipalId;
        const elapsed =
          createdAt === undefined
            ? Number.POSITIVE_INFINITY
            : this.clock.now().getTime() - createdAt.getTime();
        if (
          creator === principal.id &&
          elapsed >= 0 &&
          elapsed <= this.policy.correctionWindowMs
        ) {
          return decision(
            'ALLOW',
            'participant_creator_correction_window',
            this.policy.version,
          );
        }
        return decision(
          'APPROVAL_REQUIRED',
          'participant_parent_approval_required',
          this.policy.version,
        );
      }
    }

    if (
      destructiveKind === 'HIGH_BLAST_RADIUS' ||
      destructiveKind === 'PROTECTED_DESTRUCTIVE'
    ) {
      return this.elevationDecision(request);
    }

    return decision('ALLOW', 'routine_authorized', this.policy.version);
  }

  authorizedSearchSurfaces(
    principal: BrainPrincipal,
    surfaces: readonly RegisteredKnowledgeSurface[],
  ): readonly RegisteredKnowledgeSurface[] {
    if (principal.status !== 'active') {
      return [];
    }
    const scopes = this.allowedScopes(principal);
    return surfaces.filter((surface) => scopes.includes(surface.scope));
  }
}
