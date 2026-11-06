import type { MutationStateStore } from '../../src/application/mutation-service.js';
import { DomainError } from '../../src/domain/errors.js';
import type { BrainPrincipal } from '../../src/domain/principal.js';
import type {
  AuditOutboxRecord,
  ConsumeElevationChallenge,
  ElevationConfirmationTransaction,
  ElevationConfirmationTransactionResult,
  OperationTransition,
  OperationTransitionAudit,
  ReconciliationAttempt,
  StoredElevationChallenge,
  StoredOperation,
} from '../../src/ports/operational-state-store.js';

function invalidChallenge(): DomainError {
  return new DomainError('elevation_required', false, {
    reason: 'challenge_invalid_expired_or_consumed',
  });
}

/** Deterministic operational-state test double; it stores no Brain content. */
export class SyntheticMutationStore implements MutationStateStore {
  readonly audits: Array<{
    readonly operation: StoredOperation;
    readonly audit: OperationTransitionAudit;
  }> = [];
  readonly reconciliationAttempts: ReconciliationAttempt[] = [];
  readonly auditEvents: AuditOutboxRecord['event'][] = [];
  readonly failAfterCommitStates = new Set<StoredOperation['state']>();
  /** Simulates a crash or lost connection before the transition commits. */
  readonly failBeforeCommitStates = new Set<StoredOperation['state']>();
  afterCommit?: (operation: StoredOperation) => void;
  readonly #operations = new Map<string, StoredOperation>();
  readonly #challenges = new Map<string, StoredElevationChallenge>();
  readonly #idempotency = new Map<string, StoredOperation>();
  readonly #aliases = new Map<
    string,
    Awaited<ReturnType<MutationStateStore['findBrainRecordAlias']>>
  >();

  failNextAlias = false;
  readonly principals = new Map<string, BrainPrincipal>();

  seedPrincipal(principal: BrainPrincipal): void {
    this.principals.set(principal.id, principal);
  }

  getPrincipalById(id: BrainPrincipal['id']): Promise<BrainPrincipal | null> {
    return Promise.resolve(this.principals.get(id) ?? null);
  }

  aliasFor(
    provider: string,
    providerRecordIdValue: string | undefined,
  ):
    | NonNullable<
        Awaited<ReturnType<MutationStateStore['findBrainRecordAlias']>>
      >
    | undefined {
    return (
      [...this.#aliases.values()].find(
        (alias) =>
          alias?.provider === provider &&
          alias.providerRecordId === providerRecordIdValue,
      ) ?? undefined
    );
  }

  aliasCount(): number {
    return this.#aliases.size;
  }

  ensureBrainRecordAlias(
    candidate: NonNullable<
      Awaited<ReturnType<MutationStateStore['findBrainRecordAlias']>>
    >,
  ): ReturnType<MutationStateStore['ensureBrainRecordAlias']> {
    if (this.failNextAlias) {
      this.failNextAlias = false;
      return Promise.reject(
        new DomainError('provider_unavailable', true, {
          reason: 'synthetic_alias_unavailable',
        }),
      );
    }
    const existing = this.aliasFor(
      candidate.provider,
      candidate.providerRecordId,
    );
    if (existing !== undefined) {
      if (
        existing.creatorPrincipalId === undefined &&
        candidate.creatorPrincipalId !== undefined
      ) {
        const filled = {
          ...existing,
          creatorPrincipalId: candidate.creatorPrincipalId,
        };
        this.#aliases.set(filled.brainRecordId, filled);
        return Promise.resolve(filled);
      }
      return Promise.resolve(existing);
    }
    if (this.#aliases.has(candidate.brainRecordId)) {
      return Promise.reject(new DomainError('idempotency_conflict', false));
    }
    this.#aliases.set(candidate.brainRecordId, candidate);
    return Promise.resolve(candidate);
  }

  seedAlias(
    candidate: NonNullable<
      Awaited<ReturnType<MutationStateStore['findBrainRecordAlias']>>
    >,
  ): void {
    this.#aliases.set(candidate.brainRecordId, candidate);
  }

  openOperation(
    request: Parameters<MutationStateStore['openOperation']>[0],
  ): ReturnType<MutationStateStore['openOperation']> {
    const key = `${request.principalId}:${request.operation}:${request.requestId}`;
    const existing = this.#idempotency.get(key);
    if (existing !== undefined) {
      if (existing.requestFingerprint !== request.requestFingerprint) {
        return Promise.reject(
          new DomainError('idempotency_conflict', false, {
            reason: 'request_key_or_fingerprint_conflict',
          }),
        );
      }
      return Promise.resolve({ disposition: 'existing', operation: existing });
    }
    // Like the PostgreSQL primary key: an operation ID is global, so a
    // different principal or request can never claim or overwrite it.
    if (this.#operations.has(request.operationId)) {
      return Promise.reject(
        new DomainError('idempotency_conflict', false, {
          reason: 'request_key_or_fingerprint_conflict',
        }),
      );
    }
    const created: StoredOperation = {
      ...request,
      state: 'RECEIVED',
      updatedAt: request.createdAt,
    };
    this.#operations.set(created.operationId, created);
    this.#idempotency.set(key, created);
    return Promise.resolve({ disposition: 'created', operation: created });
  }

  getOperation(
    id: Parameters<MutationStateStore['getOperation']>[0],
  ): ReturnType<MutationStateStore['getOperation']> {
    return Promise.resolve(this.#operations.get(id) ?? null);
  }

  findBrainRecordAlias(
    id: Parameters<MutationStateStore['findBrainRecordAlias']>[0],
  ): ReturnType<MutationStateStore['findBrainRecordAlias']> {
    return Promise.resolve(this.#aliases.get(id) ?? null);
  }

  transitionOperationWithAudit(
    transition: OperationTransition,
    audit: OperationTransitionAudit,
  ): ReturnType<MutationStateStore['transitionOperationWithAudit']> {
    const current = this.#operations.get(transition.operationId);
    if (this.failBeforeCommitStates.delete(transition.nextState)) {
      return Promise.reject(new Error('synthetic_connection_lost'));
    }
    if (
      current === undefined ||
      !transition.expectedStates.includes(current.state) ||
      transition.expectedStates.includes(transition.nextState) ||
      (transition.mutationPayload !== undefined &&
        (transition.nextState !== 'AUTHORIZATION_REQUIRED' ||
          current.operation !== 'append_to_record' ||
          current.mutationPayload !== undefined))
    ) {
      return Promise.reject(
        new DomainError('invalid_request', false, {
          reason: 'operation_state_conflict',
        }),
      );
    }
    const { mutationPayload: retainedPayload, ...withoutPayload } = current;
    const terminal = [
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'SUPERSEDED',
    ].includes(transition.nextState);
    const next: StoredOperation = {
      ...withoutPayload,
      // Terminal operations never retain a pending mutation payload.
      ...(terminal || retainedPayload === undefined
        ? {}
        : { mutationPayload: retainedPayload }),
      state: transition.nextState,
      ...(transition.provider === undefined
        ? {}
        : { provider: transition.provider }),
      ...(transition.providerRecordId === undefined
        ? {}
        : { providerRecordId: transition.providerRecordId }),
      ...(transition.providerVersion === undefined
        ? {}
        : { providerVersion: transition.providerVersion }),
      ...(transition.resultMetadata === undefined
        ? {}
        : { resultMetadata: transition.resultMetadata }),
      ...(transition.errorCode === undefined
        ? {}
        : { errorCode: transition.errorCode }),
      ...(transition.policyVersion === undefined
        ? {}
        : { policyVersion: transition.policyVersion }),
      ...(transition.mutationPayload === undefined
        ? {}
        : { mutationPayload: transition.mutationPayload }),
      updatedAt: transition.transitionedAt,
    };
    this.#operations.set(next.operationId, next);
    const key = `${next.principalId}:${next.operation}:${next.requestId}`;
    this.#idempotency.set(key, next);
    this.audits.push({ operation: next, audit });
    this.afterCommit?.(next);
    if (this.failAfterCommitStates.delete(next.state)) {
      return Promise.reject(new Error('synthetic_commit_acknowledgement_lost'));
    }
    return Promise.resolve(next);
  }

  elevationChallenges(): readonly StoredElevationChallenge[] {
    return [...this.#challenges.values()];
  }

  createElevationChallenge(
    challenge: StoredElevationChallenge,
  ): Promise<StoredElevationChallenge> {
    const existing = this.#challenges.get(challenge.id);
    if (existing !== undefined) {
      return existing.confirmationTokenHash === challenge.confirmationTokenHash
        ? Promise.resolve(existing)
        : Promise.reject(new DomainError('idempotency_conflict', false));
    }
    const operation = this.#operations.get(challenge.operationId);
    if (
      operation?.principalId !== challenge.principalId ||
      operation.state !== 'ELEVATION_PENDING'
    ) {
      return Promise.reject(
        new DomainError('elevation_required', false, {
          reason: 'elevation_operation_mismatch',
        }),
      );
    }
    for (const candidate of this.#challenges.values()) {
      if (
        candidate.operationId === challenge.operationId &&
        candidate.consumedAt === undefined &&
        candidate.supersededAt === undefined
      ) {
        this.#challenges.set(candidate.id, {
          ...candidate,
          supersededAt: challenge.createdAt,
        });
      }
    }
    this.#challenges.set(challenge.id, challenge);
    return Promise.resolve(challenge);
  }

  #liveChallenge(
    request: ConsumeElevationChallenge,
  ): StoredElevationChallenge | undefined {
    const challenge = this.#challenges.get(request.challengeId);
    if (
      challenge === undefined ||
      challenge.operationId !== request.operationId ||
      challenge.principalId !== request.principalId ||
      challenge.confirmationTokenHash !== request.confirmationTokenHash ||
      challenge.requestFingerprint !== request.requestFingerprint ||
      challenge.policyVersion !== request.policyVersion ||
      JSON.stringify(challenge.frozenTargetIds) !==
        JSON.stringify(request.frozenTargetIds) ||
      challenge.consumedAt !== undefined ||
      challenge.supersededAt !== undefined ||
      request.consumedAt < challenge.createdAt ||
      request.consumedAt > challenge.expiresAt
    ) {
      return undefined;
    }
    return challenge;
  }

  consumeElevationChallenge(
    request: ConsumeElevationChallenge,
  ): Promise<StoredElevationChallenge> {
    const challenge = this.#liveChallenge(request);
    if (challenge === undefined) return Promise.reject(invalidChallenge());
    const consumed = { ...challenge, consumedAt: request.consumedAt };
    this.#challenges.set(consumed.id, consumed);
    return Promise.resolve(consumed);
  }

  /** Synchronous check-and-commit models the PostgreSQL transaction. */
  confirmElevationWithOperation(
    request: ElevationConfirmationTransaction,
  ): Promise<ElevationConfirmationTransactionResult> {
    const { consume, operationTransition } = request;
    if (
      operationTransition.operationId !== consume.operationId ||
      operationTransition.nextState !== 'EXECUTING' ||
      operationTransition.expectedStates.join() !== 'ELEVATION_PENDING' ||
      operationTransition.policyVersion !== consume.policyVersion
    ) {
      return Promise.reject(new DomainError('invalid_request', false));
    }
    const operation = this.#operations.get(consume.operationId);
    if (
      operation?.principalId !== consume.principalId ||
      operation.state !== 'ELEVATION_PENDING'
    ) {
      return Promise.reject(
        new DomainError('elevation_required', false, {
          reason: 'elevation_operation_mismatch',
        }),
      );
    }
    const challenge = this.#liveChallenge(consume);
    if (challenge === undefined) return Promise.reject(invalidChallenge());
    const consumed = { ...challenge, consumedAt: consume.consumedAt };
    this.#challenges.set(consumed.id, consumed);
    return this.transitionOperationWithAudit(
      operationTransition,
      request.audit,
    ).then((claimed) => ({ challenge: consumed, operation: claimed }));
  }

  findConsumedElevationChallenge(
    id: StoredOperation['operationId'],
  ): Promise<StoredElevationChallenge | null> {
    return Promise.resolve(
      [...this.#challenges.values()]
        .filter(
          (challenge) =>
            challenge.operationId === id && challenge.consumedAt !== undefined,
        )
        .at(-1) ?? null,
    );
  }

  enqueueAuditEvent(
    event: AuditOutboxRecord['event'],
  ): Promise<AuditOutboxRecord> {
    this.auditEvents.push(event);
    return Promise.resolve({
      id: String(this.auditEvents.length),
      event,
      attempts: 0,
      availableAt: event.timestamp,
    });
  }

  recordReconciliationAttempt(attempt: ReconciliationAttempt): Promise<void> {
    this.reconciliationAttempts.push(attempt);
    return Promise.resolve();
  }

  listReconciliationAttempts(
    id: Parameters<MutationStateStore['listReconciliationAttempts']>[0],
  ): ReturnType<MutationStateStore['listReconciliationAttempts']> {
    return Promise.resolve(
      this.reconciliationAttempts.filter(
        (attempt) => attempt.operationId === id,
      ),
    );
  }
}
