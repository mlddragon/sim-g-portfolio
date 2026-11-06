import { describe, expect, it } from 'vitest';

import { ElevationService } from '../../../src/application/elevation-service.js';
import { DomainError } from '../../../src/domain/errors.js';
import {
  brainRecordId,
  elevationChallengeId,
  operationId,
  principalId,
  providerRecordId,
  requestId,
} from '../../../src/domain/identifiers.js';
import type { BrainPrincipal } from '../../../src/domain/principal.js';
import type {
  ConsumeElevationChallenge,
  ElevationConfirmationTransaction,
  StoredElevationChallenge,
  StoredOperation,
} from '../../../src/ports/operational-state-store.js';

const initialNow = new Date('2042-06-07T08:09:10.000Z');
const operator: BrainPrincipal = {
  id: principalId('prn_operator'),
  key: 'operator',
  displayName: 'Operator',
  role: 'owner_operator',
  status: 'active',
};
const participant: BrainPrincipal = {
  id: principalId('prn_participant'),
  key: 'participant',
  displayName: 'Participant',
  role: 'family_participant',
  status: 'active',
};

function storedOperation(): StoredOperation {
  return {
    operationId: operationId('op_synthetic_elevation'),
    requestId: requestId('req_synthetic_elevation'),
    principalId: operator.id,
    operation: 'delete_record',
    requestFingerprint: 'a'.repeat(64),
    targetBrainRecordId: brainRecordId('brn_synthetic_elevation'),
    state: 'ELEVATION_PENDING',
    policyVersion: 'family-brain-v1.2.0',
    createdAt: initialNow,
    updatedAt: initialNow,
  };
}

class FakeElevationStore {
  operation: StoredOperation = storedOperation();
  challenge?: StoredElevationChallenge;

  getOperation(id: StoredOperation['operationId']) {
    return Promise.resolve(
      id === this.operation.operationId ? this.operation : null,
    );
  }

  createElevationChallenge(challenge: StoredElevationChallenge) {
    this.challenge = challenge;
    return Promise.resolve(challenge);
  }

  consumeElevationChallenge(request: ConsumeElevationChallenge) {
    const challenge = this.challenge;
    if (challenge === undefined) {
      return Promise.reject(
        new DomainError('elevation_required', false, {
          reason: 'challenge_invalid_expired_or_consumed',
        }),
      );
    }
    const matches =
      challenge.id === request.challengeId &&
      challenge.operationId === request.operationId &&
      challenge.principalId === request.principalId &&
      challenge.confirmationTokenHash === request.confirmationTokenHash &&
      challenge.requestFingerprint === request.requestFingerprint &&
      challenge.policyVersion === request.policyVersion &&
      JSON.stringify(challenge.frozenTargetIds) ===
        JSON.stringify(request.frozenTargetIds) &&
      challenge.consumedAt === undefined &&
      request.consumedAt >= challenge.createdAt &&
      request.consumedAt <= challenge.expiresAt;
    if (!matches) {
      return Promise.reject(
        new DomainError('elevation_required', false, {
          reason: 'challenge_invalid_expired_or_consumed',
        }),
      );
    }
    this.challenge = { ...challenge, consumedAt: request.consumedAt };
    return Promise.resolve(this.challenge);
  }

  async confirmElevationWithOperation(
    request: ElevationConfirmationTransaction,
  ) {
    if (this.operation.state !== 'ELEVATION_PENDING') {
      throw new DomainError('elevation_required', false, {
        reason: 'elevation_operation_mismatch',
      });
    }
    const challenge = await this.consumeElevationChallenge(request.consume);
    this.operation = {
      ...this.operation,
      state: request.operationTransition.nextState,
      updatedAt: request.operationTransition.transitionedAt,
    };
    return { challenge, operation: this.operation };
  }
}

const claim = {
  provider: 'notion' as const,
  providerRecordId: providerRecordId('notion-synthetic-elevation'),
  reasonCode: 'elevated_action_confirmed',
};

function confirm(
  service: ElevationService,
  request: Parameters<ElevationService['confirmAndClaim']>[0],
) {
  return service
    .confirmAndClaim(request, claim)
    .then(({ confirmed }) => confirmed);
}

function setup() {
  let currentTime = initialNow;
  const store = new FakeElevationStore();
  const service = new ElevationService(
    store,
    { now: () => currentTime },
    {
      challengeId: () => elevationChallengeId('elv_synthetic_elevation'),
      confirmationToken: () => 'synthetic-one-time-elevation-token',
    },
  );
  return {
    store,
    service,
    setTime: (time: Date) => {
      currentTime = time;
    },
  };
}

describe('ElevationService', () => {
  it('reports an unreachable operation store as retryable before issuing anything', async () => {
    const { service, store } = setup();
    store.getOperation = () =>
      Promise.reject(new Error('synthetic connection terminated'));

    await expect(
      service.issue({
        principal: operator,
        operationId: operationId('op_synthetic_elevation'),
        frozenTargetIds: [brainRecordId('brn_synthetic_elevation')],
      }),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'elevation_state_unavailable' },
    });
    expect(store.challenge).toBeUndefined();
  });

  it('issues a five-minute one-time challenge bound to the operation and sorted exact targets', async () => {
    const { service, store } = setup();
    const issued = await service.issue({
      principal: operator,
      operationId: operationId('op_synthetic_elevation'),
      frozenTargetIds: [
        brainRecordId('brn_synthetic_z'),
        brainRecordId('brn_synthetic_elevation'),
      ],
    });

    expect(issued).toEqual({
      challengeId: elevationChallengeId('elv_synthetic_elevation'),
      confirmationToken: 'synthetic-one-time-elevation-token',
      expiresAt: new Date(initialNow.getTime() + 5 * 60_000),
    });
    expect(store.challenge).toMatchObject({
      operationId: operationId('op_synthetic_elevation'),
      principalId: operator.id,
      requestFingerprint: 'a'.repeat(64),
      policyVersion: 'family-brain-v1.2.0',
      frozenTargetIds: [
        brainRecordId('brn_synthetic_elevation'),
        brainRecordId('brn_synthetic_z'),
      ],
    });
    expect(store.challenge?.confirmationTokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(store.challenge?.confirmationTokenHash).not.toContain(
      issued.confirmationToken,
    );
  });

  it('confirms the exact challenge once and returns server-owned evidence', async () => {
    const { service } = setup();
    const targets = [brainRecordId('brn_synthetic_elevation')];
    const issued = await service.issue({
      principal: operator,
      operationId: operationId('op_synthetic_elevation'),
      frozenTargetIds: targets,
    });

    const confirmed = await confirm(service, {
      principal: operator,
      operationId: operationId('op_synthetic_elevation'),
      challengeId: issued.challengeId,
      confirmationToken: issued.confirmationToken,
      requestFingerprint: 'a'.repeat(64),
      policyVersion: 'family-brain-v1.2.0',
      frozenTargetIds: targets,
    });
    expect(confirmed).toMatchObject({
      operation: 'delete_record',
      operationId: operationId('op_synthetic_elevation'),
      principalId: operator.id,
      consumedAt: initialNow,
    });

    await expect(
      confirm(service, {
        principal: operator,
        operationId: operationId('op_synthetic_elevation'),
        challengeId: issued.challengeId,
        confirmationToken: issued.confirmationToken,
        requestFingerprint: 'a'.repeat(64),
        policyVersion: 'family-brain-v1.2.0',
        frozenTargetIds: targets,
      }),
    ).rejects.toMatchObject({ code: 'elevation_required' });
  });

  it.each([
    ['token', { confirmationToken: 'different-token' }],
    ['fingerprint', { requestFingerprint: 'b'.repeat(64) }],
    ['policy', { policyVersion: 'different-policy' }],
    ['target', { frozenTargetIds: [brainRecordId('brn_different')] }],
  ])('rejects a challenge %s mismatch', async (_name, override) => {
    const { service } = setup();
    const targets = [brainRecordId('brn_synthetic_elevation')];
    const issued = await service.issue({
      principal: operator,
      operationId: operationId('op_synthetic_elevation'),
      frozenTargetIds: targets,
    });
    await expect(
      confirm(service, {
        principal: operator,
        operationId: operationId('op_synthetic_elevation'),
        challengeId: issued.challengeId,
        confirmationToken: issued.confirmationToken,
        requestFingerprint: 'a'.repeat(64),
        policyVersion: 'family-brain-v1.2.0',
        frozenTargetIds: targets,
        ...override,
      }),
    ).rejects.toMatchObject({ code: 'elevation_required' });
  });

  it('rejects an expired challenge', async () => {
    const { service, setTime } = setup();
    const targets = [brainRecordId('brn_synthetic_elevation')];
    const issued = await service.issue({
      principal: operator,
      operationId: operationId('op_synthetic_elevation'),
      frozenTargetIds: targets,
    });
    setTime(new Date(initialNow.getTime() + 5 * 60_000 + 1));
    await expect(
      confirm(service, {
        principal: operator,
        operationId: operationId('op_synthetic_elevation'),
        challengeId: issued.challengeId,
        confirmationToken: issued.confirmationToken,
        requestFingerprint: 'a'.repeat(64),
        policyVersion: 'family-brain-v1.2.0',
        frozenTargetIds: targets,
      }),
    ).rejects.toMatchObject({ code: 'elevation_required' });
  });

  it('rejects a principal or operation mismatch before consuming the challenge', async () => {
    const { service } = setup();
    const targets = [brainRecordId('brn_synthetic_elevation')];
    const issued = await service.issue({
      principal: operator,
      operationId: operationId('op_synthetic_elevation'),
      frozenTargetIds: targets,
    });
    await expect(
      confirm(service, {
        principal: operator,
        operationId: operationId('op_different_operation'),
        challengeId: issued.challengeId,
        confirmationToken: issued.confirmationToken,
        requestFingerprint: 'a'.repeat(64),
        policyVersion: 'family-brain-v1.2.0',
        frozenTargetIds: targets,
      }),
    ).rejects.toMatchObject({ code: 'elevation_required' });

    await expect(
      service.issue({
        principal: participant,
        operationId: operationId('op_synthetic_elevation'),
        frozenTargetIds: targets,
      }),
    ).rejects.toMatchObject({
      code: 'unauthorized',
      details: { reason: 'family_participant_cannot_elevate' },
    });
  });
});
