import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { DomainError } from '../domain/errors.js';
import {
  elevationChallengeId,
  type BrainRecordId,
  type ElevationChallengeId,
  type OperationId,
  type ProviderRecordId,
} from '../domain/identifiers.js';
import type {
  BrainOperationName,
  ElevationChallengeGrant,
} from '../domain/operations.js';
import type { BrainPrincipal } from '../domain/principal.js';
import type { KnowledgeProviderName } from '../domain/records.js';
import type { Clock } from '../ports/clock.js';
import type {
  ConsumeElevationChallenge,
  OperationalStateStore,
  StoredOperation,
} from '../ports/operational-state-store.js';

const elevationTtlMs = 5 * 60_000;

export type ElevationStore = Pick<
  OperationalStateStore,
  'getOperation' | 'createElevationChallenge' | 'confirmElevationWithOperation'
>;

export interface ElevationChallengeGenerator {
  challengeId(): ElevationChallengeId;
  confirmationToken(): string;
}

export interface IssueElevationRequest {
  readonly principal: BrainPrincipal;
  readonly operationId: OperationId;
  readonly frozenTargetIds: readonly BrainRecordId[];
}

export type IssuedElevationChallenge = ElevationChallengeGrant;

export interface ConfirmElevationRequest extends IssueElevationRequest {
  readonly challengeId: ElevationChallengeId;
  readonly confirmationToken: string;
  readonly requestFingerprint: string;
  readonly policyVersion: string;
}

export interface ConfirmedElevation {
  readonly challengeId: ElevationChallengeId;
  readonly operationId: OperationId;
  readonly principalId: BrainPrincipal['id'];
  readonly operation: BrainOperationName;
  readonly requestFingerprint: string;
  readonly policyVersion: string;
  readonly frozenTargetIds: readonly BrainRecordId[];
  readonly consumedAt: Date;
}

/** Provider facts frozen when the elevated operation is claimed for execution. */
export interface ElevatedExecutionClaim {
  readonly provider: Exclude<KnowledgeProviderName, 'github'>;
  /** Absent for a create, whose record does not exist until dispatch. */
  readonly providerRecordId?: ProviderRecordId;
  readonly providerVersion?: string;
  readonly reasonCode: string;
}

export interface ClaimedElevation {
  readonly confirmed: ConfirmedElevation;
  readonly operation: StoredOperation;
}

const defaultGenerator: ElevationChallengeGenerator = {
  challengeId: () => elevationChallengeId(`elv_${randomUUID()}`),
  confirmationToken: () => randomBytes(32).toString('base64url'),
};

function sortedTargets(
  targetIds: readonly BrainRecordId[],
): readonly BrainRecordId[] {
  const sorted = [...targetIds].sort();
  if (sorted.length === 0 || new Set(sorted).size !== sorted.length) {
    throw new DomainError('invalid_request', false, {
      reason: 'invalid_elevation_targets',
    });
  }
  return sorted;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function assertCanElevate(principal: BrainPrincipal): void {
  if (principal.status !== 'active') {
    throw new DomainError('unauthorized', false, {
      reason: 'principal_disabled',
    });
  }
  if (principal.role === 'family_participant') {
    throw new DomainError('unauthorized', false, {
      reason: 'family_participant_cannot_elevate',
    });
  }
}

export class ElevationService {
  constructor(
    private readonly store: ElevationStore,
    private readonly clock: Clock,
    private readonly generator: ElevationChallengeGenerator = defaultGenerator,
  ) {}

  private async loadOperation(
    request: IssueElevationRequest,
  ): Promise<StoredOperation & { readonly policyVersion: string }> {
    let operation: StoredOperation | null;
    try {
      operation = await this.store.getOperation(request.operationId);
    } catch (error) {
      // A dropped connection is retryable, never internal; nothing was issued.
      if (error instanceof DomainError) throw error;
      throw new DomainError('provider_unavailable', true, {
        reason: 'elevation_state_unavailable',
      });
    }
    if (
      operation === null ||
      operation.principalId !== request.principal.id ||
      operation.state !== 'ELEVATION_PENDING' ||
      operation.policyVersion === undefined
    ) {
      throw new DomainError('elevation_required', false, {
        reason: 'elevation_operation_mismatch',
      });
    }
    return { ...operation, policyVersion: operation.policyVersion };
  }

  async issue(
    request: IssueElevationRequest,
  ): Promise<IssuedElevationChallenge> {
    assertCanElevate(request.principal);
    const operation = await this.loadOperation(request);
    const targets = sortedTargets(request.frozenTargetIds);
    if (
      operation.targetBrainRecordId !== undefined &&
      !targets.includes(operation.targetBrainRecordId)
    ) {
      throw new DomainError('elevation_required', false, {
        reason: 'elevation_target_mismatch',
      });
    }

    const createdAt = this.clock.now();
    const expiresAt = new Date(createdAt.getTime() + elevationTtlMs);
    const challengeIdValue = this.generator.challengeId();
    const confirmationToken = this.generator.confirmationToken();
    if (confirmationToken.length < 32) {
      throw new DomainError('internal_error', false, {
        reason: 'invalid_elevation_token_generator',
      });
    }

    await this.store.createElevationChallenge({
      id: challengeIdValue,
      operationId: operation.operationId,
      principalId: request.principal.id,
      confirmationTokenHash: tokenHash(confirmationToken),
      requestFingerprint: operation.requestFingerprint,
      policyVersion: operation.policyVersion,
      frozenTargetIds: targets,
      createdAt,
      expiresAt,
    });

    return { challengeId: challengeIdValue, confirmationToken, expiresAt };
  }

  private async consumption(request: ConfirmElevationRequest): Promise<{
    readonly operation: StoredOperation & { readonly policyVersion: string };
    readonly consume: ConsumeElevationChallenge;
  }> {
    assertCanElevate(request.principal);
    const operation = await this.loadOperation(request);
    const targets = sortedTargets(request.frozenTargetIds);
    if (
      request.requestFingerprint !== operation.requestFingerprint ||
      request.policyVersion !== operation.policyVersion ||
      (operation.targetBrainRecordId !== undefined &&
        !targets.includes(operation.targetBrainRecordId))
    ) {
      throw new DomainError('elevation_required', false, {
        reason: 'elevation_operation_mismatch',
      });
    }
    return {
      operation,
      consume: {
        challengeId: request.challengeId,
        operationId: operation.operationId,
        principalId: request.principal.id,
        confirmationTokenHash: tokenHash(request.confirmationToken),
        requestFingerprint: request.requestFingerprint,
        policyVersion: request.policyVersion,
        frozenTargetIds: targets,
        consumedAt: this.clock.now(),
      },
    };
  }

  private confirmed(
    operation: StoredOperation & { readonly policyVersion: string },
    consume: ConsumeElevationChallenge,
    frozenTargetIds: readonly BrainRecordId[],
  ): ConfirmedElevation {
    return {
      challengeId: consume.challengeId,
      operationId: operation.operationId,
      principalId: consume.principalId,
      operation: operation.operation,
      requestFingerprint: operation.requestFingerprint,
      policyVersion: operation.policyVersion,
      frozenTargetIds,
      consumedAt: consume.consumedAt,
    };
  }

  /**
   * Consume the challenge and claim its pending operation for execution in
   * one store transaction. Callers revalidate the target before this call.
   */
  async confirmAndClaim(
    request: ConfirmElevationRequest,
    claim: ElevatedExecutionClaim,
  ): Promise<ClaimedElevation> {
    const { operation, consume } = await this.consumption(request);
    const claimed = await this.store.confirmElevationWithOperation({
      consume,
      operationTransition: {
        operationId: operation.operationId,
        expectedStates: ['ELEVATION_PENDING'],
        nextState: 'EXECUTING',
        provider: claim.provider,
        ...(claim.providerRecordId === undefined
          ? {}
          : { providerRecordId: claim.providerRecordId }),
        ...(claim.providerVersion === undefined
          ? {}
          : { providerVersion: claim.providerVersion }),
        policyVersion: operation.policyVersion,
        transitionedAt: consume.consumedAt,
      },
      audit: {
        eventType: 'brain.mutation.transitioned',
        reasonCode: claim.reasonCode,
      },
    });
    return {
      confirmed: this.confirmed(
        operation,
        consume,
        claimed.challenge.frozenTargetIds,
      ),
      operation: claimed.operation,
    };
  }
}
