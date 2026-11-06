import { createHash } from 'node:crypto';

import type {
  AuthorizationEngine,
  RegisteredKnowledgeSurface,
} from '../domain/authorization/authorization-engine.js';
import type {
  DestructiveClassificationInput,
  DestructiveClassifier,
} from '../domain/authorization/destructive-classifier.js';
import { DomainError, type DomainErrorCode } from '../domain/errors.js';
import { brainRecordId, elevationChallengeId } from '../domain/identifiers.js';
import type {
  AppendRecordRequest,
  DeleteRecordRequest,
  MutationResponse,
  AuthorizationDecision,
  ElevationConfirmation,
  PersistKnowledgeRequest,
  ProviderMutationReference,
  SemanticMetadata,
  UpdateMutation,
  UpdateRecordRequest,
} from '../domain/operations.js';
import type {
  AuthenticatedPrincipal,
  BrainPrincipal,
} from '../domain/principal.js';
import {
  brainScopes,
  knowledgeProviderNames,
  type BrainRecord,
  type BrainScope,
  type CanonicalLocation,
  type ProtectedClass,
  type Sensitivity,
} from '../domain/records.js';
import type { RequestContext } from '../domain/request-context.js';
import type {
  CanonicalRoute,
  CanonicalRouter,
} from '../domain/routing/canonical-router.js';
import type { Clock } from '../ports/clock.js';
import type {
  MutableKnowledgeProvider,
  ProviderAccessScope,
  ProviderMutationResult,
} from '../ports/knowledge-provider.js';
import type {
  BrainRecordAlias,
  OperationalJsonObject,
  OperationalStateStore,
  StoredElevationChallenge,
  StoredOperation,
} from '../ports/operational-state-store.js';
import { assertActive, assertAuthenticated } from './brain-read-support.js';
import { operationFingerprint } from './operation-fingerprint.js';
import type { ApprovalRequestCoordinator } from './approval-service.js';
import type {
  ConfirmedElevation,
  ElevationService,
} from './elevation-service.js';

export type MutationStateStore = Pick<
  OperationalStateStore,
  | 'openOperation'
  | 'getOperation'
  | 'findBrainRecordAlias'
  | 'transitionOperationWithAudit'
  | 'recordReconciliationAttempt'
  | 'listReconciliationAttempts'
  | 'findConsumedElevationChallenge'
  | 'enqueueAuditEvent'
  | 'ensureBrainRecordAlias'
  | 'getPrincipalById'
>;

/** Authorized provider access to a target, resolvable without fetching it. */
interface TargetAccess {
  readonly alias: BrainRecordAlias;
  readonly containerKey: string;
  readonly provider: MutableKnowledgeProvider;
  readonly access: ProviderAccessScope;
  readonly policyVersion: string;
  readonly current?: BrainRecord;
}

interface PreparedTarget extends TargetAccess {
  readonly current: BrainRecord;
}

interface CreateTarget {
  readonly provider: MutableKnowledgeProvider;
  readonly scope: BrainScope;
  /** The routed container's protected class; providers require an exact match. */
  readonly protectedClass: ProtectedClass;
  readonly access: ProviderAccessScope;
}

/** One governed change to an existing record; append never carries replacement. */
type TargetChange =
  | { readonly operation: 'update_record'; readonly mutation: UpdateMutation }
  | { readonly operation: 'append_to_record'; readonly content: string }
  | { readonly operation: 'delete_record' };

interface NormalizedPersist {
  readonly title: string;
  readonly content: string;
  readonly semanticMetadata: SemanticMetadata;
}

interface ValidatedMutationReference extends Omit<
  ProviderMutationReference,
  'provider' | 'canonicalLocation'
> {
  readonly provider: MutableKnowledgeProvider['provider'];
  readonly canonicalLocation: CanonicalLocation & {
    readonly provider: MutableKnowledgeProvider['provider'];
  };
}

const mutableProviderNames = ['notion', 'drive'] as const;

function invalid(reason: string): DomainError {
  return new DomainError('invalid_request', false, { reason });
}

function operationIdentityMismatch(): DomainError {
  return new DomainError('unauthenticated', false, {
    reason: 'operation_identity_mismatch',
  });
}

function exactOwnDataObject(
  value: unknown,
  allowedKeys: readonly string[],
  reason = 'invalid_update_mutation',
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(reason);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))
  ) {
    throw invalid(reason);
  }
  const keys = ownKeys as string[];
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true
    ) {
      throw invalid(reason);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

const maxConfirmationTokenLength = 512;

/**
 * Text that PostgreSQL `jsonb` and providers can store: no NUL and no lone
 * UTF-16 surrogate. Anything else is a client error, never a storage failure.
 */
function storableText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !value.includes('\u0000') &&
    value.isWellFormed()
  );
}

function normalizeElevation(value: unknown): ElevationConfirmation {
  const candidate = exactOwnDataObject(
    value,
    ['challengeId', 'confirmationToken'],
    'invalid_elevation_confirmation',
  );
  const challenge = candidate['challengeId'];
  const token = candidate['confirmationToken'];
  if (
    typeof challenge !== 'string' ||
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > maxConfirmationTokenLength
  ) {
    throw invalid('invalid_elevation_confirmation');
  }
  try {
    return {
      challengeId: elevationChallengeId(challenge),
      confirmationToken: token,
    };
  } catch {
    throw invalid('invalid_elevation_confirmation');
  }
}

function normalizeMutation(value: unknown): {
  readonly mutation: UpdateMutation;
  readonly payload: OperationalJsonObject;
} {
  const candidate = exactOwnDataObject(value, ['mode', 'patch', 'replacement']);
  if (candidate['mode'] === 'patch') {
    if (
      !Object.hasOwn(candidate, 'patch') ||
      Object.hasOwn(candidate, 'replacement')
    ) {
      throw invalid('invalid_update_mutation');
    }
    const patch = exactOwnDataObject(candidate['patch'], ['title', 'content']);
    if (
      Object.keys(patch).length === 0 ||
      (patch['title'] !== undefined &&
        (!storableText(patch['title']) || patch['title'].length === 0)) ||
      (patch['content'] !== undefined && !storableText(patch['content']))
    ) {
      throw invalid('invalid_update_mutation');
    }
    const normalizedPatch = {
      ...(typeof patch['title'] === 'string' ? { title: patch['title'] } : {}),
      ...(typeof patch['content'] === 'string'
        ? { content: patch['content'] }
        : {}),
    };
    return {
      mutation: { mode: 'patch', patch: normalizedPatch },
      payload: { mode: 'patch', patch: normalizedPatch },
    };
  }
  if (candidate['mode'] === 'replace') {
    if (
      !Object.hasOwn(candidate, 'replacement') ||
      Object.hasOwn(candidate, 'patch')
    ) {
      throw invalid('invalid_update_mutation');
    }
    const replacement = exactOwnDataObject(candidate['replacement'], [
      'title',
      'content',
    ]);
    if (
      !storableText(replacement['content']) ||
      (replacement['title'] !== undefined &&
        (!storableText(replacement['title']) ||
          replacement['title'].length === 0))
    ) {
      throw invalid('invalid_update_mutation');
    }
    const normalizedReplacement = {
      ...(typeof replacement['title'] === 'string'
        ? { title: replacement['title'] }
        : {}),
      content: replacement['content'],
    };
    return {
      mutation: { mode: 'replace', replacement: normalizedReplacement },
      payload: { mode: 'replace', replacement: normalizedReplacement },
    };
  }
  throw invalid('invalid_update_mutation');
}

function resultMetadata(
  reference: ProviderMutationReference,
  reconciliationKey?: string,
): OperationalJsonObject {
  return {
    canonicalContainerRef: reference.canonicalLocation.containerRef,
    ...(reference.canonicalLocation.displayPath === undefined
      ? {}
      : { canonicalDisplayPath: reference.canonicalLocation.displayPath }),
    ...(reference.integrityHash === undefined
      ? {}
      : { integrityHash: reference.integrityHash }),
    ...(reconciliationKey === undefined ? {} : { reconciliationKey }),
  };
}

function reconciliationMetadata(
  reconciliationKey?: string,
): OperationalJsonObject {
  return reconciliationKey === undefined ? {} : { reconciliationKey };
}

function stringMetadata(
  metadata: OperationalJsonObject | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function approvalMetadata(
  prepared: PreparedTarget,
  decision: AuthorizationDecision,
): OperationalJsonObject {
  return {
    approvalDecisionReason: decision.reasonCode,
    approvalProtectedClass: prepared.current.policy.protectedClass,
    approvalScope: prepared.current.policy.scope,
  };
}

function approvalSnapshotMatches(
  operation: StoredOperation,
  prepared: PreparedTarget,
  decision: AuthorizationDecision,
): boolean {
  return (
    decision.kind === 'APPROVAL_REQUIRED' &&
    operation.policyVersion === decision.policyVersion &&
    operation.providerRecordId === prepared.alias.providerRecordId &&
    (operation.providerVersion ?? null) ===
      (prepared.current.provenance.providerVersion ?? null) &&
    stringMetadata(operation.resultMetadata, 'approvalDecisionReason') ===
      decision.reasonCode &&
    stringMetadata(operation.resultMetadata, 'approvalProtectedClass') ===
      prepared.current.policy.protectedClass &&
    stringMetadata(operation.resultMetadata, 'approvalScope') ===
      prepared.current.policy.scope
  );
}

function elevationMetadata(
  prepared: PreparedTarget,
  decision: AuthorizationDecision,
): OperationalJsonObject {
  return {
    elevationDecisionReason: decision.reasonCode,
    elevationProtectedClass: prepared.current.policy.protectedClass,
    elevationScope: prepared.current.policy.scope,
  };
}

/** The confirmed target must be exactly the one the challenge was issued for. */
function elevationSnapshotMatches(
  operation: StoredOperation,
  prepared: PreparedTarget,
  decision: AuthorizationDecision,
): boolean {
  return (
    decision.kind === 'ELEVATION_REQUIRED' &&
    operation.policyVersion === decision.policyVersion &&
    operation.provider === prepared.provider.provider &&
    operation.providerRecordId === prepared.alias.providerRecordId &&
    (operation.providerVersion ?? null) ===
      (prepared.current.provenance.providerVersion ?? null) &&
    stringMetadata(operation.resultMetadata, 'elevationDecisionReason') ===
      decision.reasonCode &&
    stringMetadata(operation.resultMetadata, 'elevationProtectedClass') ===
      prepared.current.policy.protectedClass &&
    stringMetadata(operation.resultMetadata, 'elevationScope') ===
      prepared.current.policy.scope
  );
}

function consumedElevation(
  operation: StoredOperation,
  challenge: StoredElevationChallenge,
): ConfirmedElevation | undefined {
  if (
    challenge.consumedAt === undefined ||
    challenge.operationId !== operation.operationId ||
    challenge.principalId !== operation.principalId
  ) {
    return undefined;
  }
  return {
    challengeId: challenge.id,
    operationId: challenge.operationId,
    principalId: challenge.principalId,
    operation: operation.operation,
    requestFingerprint: challenge.requestFingerprint,
    policyVersion: challenge.policyVersion,
    frozenTargetIds: challenge.frozenTargetIds,
    consumedAt: challenge.consumedAt,
  };
}

function operationInProgress(): DomainError {
  return new DomainError('provider_unavailable', true, {
    reason: 'operation_in_progress',
  });
}

function updateChange(mutation: UpdateMutation): TargetChange {
  return { operation: 'update_record', mutation };
}

function classificationInput(
  change: TargetChange,
  protectedClass: ProtectedClass,
): DestructiveClassificationInput {
  return {
    operation: change.operation,
    ...(change.operation === 'update_record'
      ? { updateMutation: change.mutation }
      : {}),
    targetCount: 1,
    selection: 'explicit',
    explicitIntent: true,
    protectedClass,
  };
}

function providerMutationKind(
  change: TargetChange,
): 'update' | 'append' | 'trash' {
  switch (change.operation) {
    case 'update_record':
      return 'update';
    case 'append_to_record':
      return 'append';
    case 'delete_record':
      return 'trash';
    default: {
      // A new change kind must never default to trash.
      const unreachable: never = change;
      throw new TypeError(`unsupported_target_change:${String(unreachable)}`);
    }
  }
}

/** Update fingerprints are unchanged; append is namespaced separately. */
function changeFingerprint(
  targetId: UpdateRecordRequest['brainRecordId'],
  change: TargetChange,
): string {
  if (change.operation === 'update_record') {
    return operationFingerprint('update_record', {
      brainRecordId: targetId,
      mutation: change.mutation,
    });
  }
  return change.operation === 'append_to_record'
    ? operationFingerprint('append_to_record', {
        brainRecordId: targetId,
        content: change.content,
      })
    : operationFingerprint('delete_record', {
        brainRecordId: targetId,
        explicitIntent: true,
      });
}

/** Rebuild an approved change from durable state: update, append or delete. */
function storedTargetChange(
  operation: StoredOperation,
  reason: string,
): { readonly change: TargetChange; readonly fingerprint: string } {
  const targetId = operation.targetBrainRecordId;
  let change: TargetChange;
  if (
    operation.operation === 'update_record' &&
    targetId !== undefined &&
    operation.mutationPayload !== undefined
  ) {
    change = updateChange(
      normalizeMutation(operation.mutationPayload).mutation,
    );
  } else if (
    operation.operation === 'append_to_record' &&
    targetId !== undefined &&
    typeof operation.mutationPayload?.['content'] === 'string' &&
    operation.mutationPayload['content'].trim().length > 0 &&
    Buffer.byteLength(operation.mutationPayload['content'], 'utf8') <=
      maxPersistContentBytes
  ) {
    change = {
      operation: 'append_to_record',
      content: operation.mutationPayload['content'],
    };
  } else if (
    operation.operation === 'delete_record' &&
    targetId !== undefined
  ) {
    change = { operation: 'delete_record' };
  } else {
    throw invalid(reason);
  }
  const fingerprint = changeFingerprint(targetId, change);
  if (fingerprint !== operation.requestFingerprint) {
    throw new DomainError('idempotency_conflict', false, {
      reason: 'approved_change_fingerprint_mismatch',
    });
  }
  return { change, fingerprint };
}

const maxSemanticValueLength = 512;
const maxPersistTitleLength = 2_000;
const maxPersistContentBytes = 1_048_576;
const semanticStringKeys = [
  'subject',
  'domain',
  'recordType',
  'durability',
  'provenance',
  'projectReference',
] as const;
const sensitivities: readonly Sensitivity[] = [
  'family_shared',
  'parent_and_stewardship',
  'restricted',
  'protected',
];

function boundedSemanticString(value: unknown): string {
  if (
    !storableText(value) ||
    value.length === 0 ||
    value.length > maxSemanticValueLength
  ) {
    throw invalid('invalid_persist_request');
  }
  return value;
}

/** Strict closed shape; creator, scope and protection are never client input. */
function normalizePersist(request: PersistKnowledgeRequest): NormalizedPersist {
  // Read each client field once so a getter cannot change it between checks.
  const { title, content, semanticMetadata } = request;
  if (
    !storableText(title) ||
    title.length === 0 ||
    title.length > maxPersistTitleLength ||
    !storableText(content) ||
    content.length === 0 ||
    Buffer.byteLength(content, 'utf8') > maxPersistContentBytes
  ) {
    throw invalid('invalid_persist_request');
  }
  const candidate = exactOwnDataObject(
    semanticMetadata,
    [...semanticStringKeys, 'sensitivity', 'canonicalHint'],
    'invalid_persist_request',
  );
  const semantic: {
    -readonly [K in keyof SemanticMetadata]: SemanticMetadata[K];
  } = {};
  for (const key of semanticStringKeys) {
    if (candidate[key] !== undefined) {
      semantic[key] = boundedSemanticString(candidate[key]);
    }
  }
  const sensitivity = candidate['sensitivity'];
  if (sensitivity !== undefined) {
    const matched = sensitivities.find((value) => value === sensitivity);
    if (matched === undefined) throw invalid('invalid_persist_request');
    semantic.sensitivity = matched;
  }
  if (candidate['canonicalHint'] !== undefined) {
    const hint = exactOwnDataObject(
      candidate['canonicalHint'],
      ['provider', 'containerRef'],
      'invalid_persist_request',
    );
    const provider = knowledgeProviderNames.find(
      (value) => value === hint['provider'],
    );
    if (
      Object.keys(hint).length === 0 ||
      (hint['provider'] !== undefined && provider === undefined)
    ) {
      throw invalid('invalid_persist_request');
    }
    semantic.canonicalHint = {
      ...(provider === undefined ? {} : { provider }),
      ...(hint['containerRef'] === undefined
        ? {}
        : { containerRef: boundedSemanticString(hint['containerRef']) }),
    };
  }
  return { title, content, semanticMetadata: semantic };
}

/**
 * Creator facts come from gateway metadata or provider provenance, never the
 * client. Disagreeing sources remove the creator so no correction shortcut applies.
 */
function withGatewayCreator(
  record: BrainRecord,
  alias: BrainRecordAlias,
): BrainRecord {
  const gateway = alias.creatorPrincipalId;
  const provider = record.provenance.creatorPrincipalId;
  if (gateway === undefined || gateway === provider) return record;
  const { creatorPrincipalId: _discarded, ...provenance } = record.provenance;
  return {
    ...record,
    provenance:
      provider === undefined
        ? { ...provenance, creatorPrincipalId: gateway }
        : provenance,
  };
}

function referenceMatchesRoute(
  reference: ProviderMutationReference,
  route: CanonicalRoute,
): boolean {
  return (
    reference.provider === route.provider &&
    reference.canonicalLocation.provider === route.provider &&
    reference.canonicalLocation.containerRef === route.containerKey
  );
}

/**
 * A create has no record to freeze, so its elevation binds to the exact
 * deterministic route: provider, container and Brain scope.
 */
function routeToken(route: CanonicalRoute, scope: BrainScope) {
  const digest = createHash('sha256')
    .update(`${route.provider}:${route.containerKey}:${scope}`, 'utf8')
    .digest('hex');
  return brainRecordId(`brn_route_${digest.slice(0, 40)}`);
}

/** Deterministic candidate; an existing alias for the provider record always wins. */
function createdAliasId(
  provider: MutableKnowledgeProvider['provider'],
  providerRecordIdValue: string,
) {
  const digest = createHash('sha256')
    .update(`${provider}:${providerRecordIdValue}`, 'utf8')
    .digest('hex');
  return brainRecordId(`brn_${provider}_${digest.slice(0, 32)}`);
}

function storedResponse(operation: StoredOperation): MutationResponse {
  if (operation.state === 'COMPLETED') {
    const containerRef = stringMetadata(
      operation.resultMetadata,
      'canonicalContainerRef',
    );
    if (
      operation.provider === undefined ||
      operation.provider === 'github' ||
      operation.providerRecordId === undefined ||
      containerRef === undefined
    ) {
      throw new DomainError('internal_error', false, {
        reason: 'stored_mutation_result_invalid',
      });
    }
    const displayPath = stringMetadata(
      operation.resultMetadata,
      'canonicalDisplayPath',
    );
    const integrityHash = stringMetadata(
      operation.resultMetadata,
      'integrityHash',
    );
    return {
      operationId: operation.operationId,
      state: 'completed',
      record: {
        provider: operation.provider,
        providerRecordId: operation.providerRecordId,
        ...(operation.providerVersion === undefined
          ? {}
          : { providerVersion: operation.providerVersion }),
        canonicalLocation: {
          provider: operation.provider,
          containerRef,
          ...(displayPath === undefined ? {} : { displayPath }),
        },
        ...(integrityHash === undefined ? {} : { integrityHash }),
      },
    };
  }
  if (operation.state === 'OUTCOME_UNKNOWN') {
    return { operationId: operation.operationId, state: 'outcome_unknown' };
  }
  if (
    operation.state === 'AUTHORIZATION_REQUIRED' ||
    operation.state === 'APPROVAL_PENDING'
  ) {
    return { operationId: operation.operationId, state: 'approval_required' };
  }
  if (operation.state === 'ELEVATION_PENDING') {
    return { operationId: operation.operationId, state: 'elevation_required' };
  }
  return { operationId: operation.operationId, state: 'failed' };
}

export interface RecoverStrandedExecutionRequest {
  readonly operationId: StoredOperation['operationId'];
  /** Minimum age of the EXECUTING claim; bounds races with a live executor. */
  readonly staleAfterMs: number;
}

export type StrandedRecoveryDisposition =
  | 'completed'
  | 'outcome_unknown'
  | 'not_stale'
  | 'not_executing'
  | 'approval_recovery_required';

export interface StrandedRecoveryResult {
  readonly operationId: StoredOperation['operationId'];
  readonly disposition: StrandedRecoveryDisposition;
  readonly state: StoredOperation['state'];
  readonly reasonCode: string;
}

// Well above any single direct execution (bounded provider calls with
// five-second timeouts), so recovery rarely meets a live executor.
const minimumStaleAfterMs = 15 * 60_000;
// A RECEIVED operation has never dispatched a provider write (dispatch follows
// the EXECUTING claim). Five times the largest configurable request deadline
// (120 s), an original request is almost certainly gone, so a retry settles it
// instead of answering in progress forever. Safety rests on the claim's
// compare-and-set, not on this timing.
const staleReceivedAfterMs = 10 * 60_000;

function recoveryResult(
  operation: StoredOperation,
  disposition: StrandedRecoveryDisposition,
  reasonCode: string,
): StrandedRecoveryResult {
  return {
    operationId: operation.operationId,
    disposition,
    state: operation.state,
    reasonCode,
  };
}

/** Idempotent, freshly authorized persist, update and append with approval and elevation. */
export class MutationService {
  private readonly providers: ReadonlyMap<
    MutableKnowledgeProvider['provider'],
    MutableKnowledgeProvider
  >;

  constructor(
    private readonly authorization: AuthorizationEngine,
    private readonly destructive: DestructiveClassifier,
    private readonly router: CanonicalRouter,
    private readonly store: MutationStateStore,
    providers: readonly MutableKnowledgeProvider[],
    private readonly surfaces: readonly RegisteredKnowledgeSurface[],
    private readonly clock: Clock,
    private readonly approvals?: Pick<
      ApprovalRequestCoordinator,
      'ensurePending'
    >,
    private readonly elevations?: Pick<
      ElevationService,
      'issue' | 'confirmAndClaim'
    >,
  ) {
    const byName = new Map(
      providers.map((provider) => [provider.provider, provider]),
    );
    if (
      providers.length !== mutableProviderNames.length ||
      byName.size !== mutableProviderNames.length ||
      mutableProviderNames.some((provider) => !byName.has(provider))
    ) {
      throw new TypeError('invalid_mutation_provider_configuration');
    }
    this.providers = byName;
  }

  async persistKnowledge(
    authenticated: AuthenticatedPrincipal,
    requestContext: RequestContext,
    request: PersistKnowledgeRequest,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    assertAuthenticated(authenticated);
    assertActive(signal);
    if (
      request.principalId !== authenticated.principal.id ||
      request.requestId !== requestContext.requestId ||
      request.clientId !== requestContext.clientId
    ) {
      throw operationIdentityMismatch();
    }
    const normalized = normalizePersist(request);
    const elevation =
      request.elevation === undefined
        ? undefined
        : normalizeElevation(request.elevation);
    // Deterministic and I/O-free: routing errors stay retryable under this request ID.
    const route = this.router.route({
      operation: 'persist_knowledge',
      semanticMetadata: normalized.semanticMetadata,
    });
    const fingerprint = operationFingerprint('persist_knowledge', {
      title: normalized.title,
      content: normalized.content,
      semanticMetadata: normalized.semanticMetadata,
    });
    const opened = await this.openOperation({
      operationId: request.operationId,
      requestId: request.requestId,
      principalId: authenticated.principal.id,
      ...(request.clientId === undefined ? {} : { clientId: request.clientId }),
      operation: 'persist_knowledge',
      requestFingerprint: fingerprint,
      // No body is stored: nothing resumes a create, and the fingerprint is enough.
      semanticMetadata: normalized.semanticMetadata,
      createdAt: requestContext.receivedAt,
    });
    assertActive(signal);
    if (opened.disposition === 'existing') {
      const existing = opened.operation;
      if (existing.state === 'COMPLETED') return this.completedCreate(existing);
      if (existing.state === 'ELEVATION_PENDING') {
        return elevation === undefined
          ? this.reissueCreateElevation(authenticated.principal, existing)
          : this.confirmElevatedCreate(
              authenticated.principal,
              existing,
              elevation,
              route,
              normalized,
              signal,
            );
      }
      if (existing.state === 'OUTCOME_UNKNOWN') {
        return this.reconcileCreate(
          authenticated.principal,
          existing,
          route,
          signal,
        );
      }
      return this.existingResponse(existing);
    }
    return this.executeCreate(
      authenticated.principal,
      opened.operation,
      route,
      normalized,
      signal,
    );
  }

  /** The routed container must be registered under exactly one Brain scope. */
  private createTarget(route: CanonicalRoute): CreateTarget | undefined {
    const matching = this.surfaces.filter(
      (surface) =>
        surface.provider === route.provider &&
        surface.containerKey === route.containerKey,
    );
    // One unambiguous scope and protected class per routed container.
    const policies = [
      ...new Set(
        matching.map(
          (surface) => `${surface.scope}|${surface.protectedClass ?? 'none'}`,
        ),
      ),
    ];
    const provider = this.providers.get(route.provider);
    const surface = matching[0];
    if (
      policies.length !== 1 ||
      surface === undefined ||
      provider === undefined
    ) {
      return undefined;
    }
    return {
      provider,
      scope: surface.scope,
      protectedClass: surface.protectedClass ?? 'none',
      access: { brainScopes: [surface.scope], rootRefs: [route.containerKey] },
    };
  }

  private evaluateCreate(
    principal: BrainPrincipal,
    target: CreateTarget,
    binding?: {
      readonly operation: StoredOperation;
      readonly route: CanonicalRoute;
      readonly confirmedElevation?: ConfirmedElevation;
    },
  ): AuthorizationDecision {
    return this.authorization.evaluate({
      principal,
      operation: 'persist_knowledge',
      scope: target.scope,
      destructive: this.destructive.classify({
        operation: 'persist_knowledge',
        targetCount: 1,
        selection: 'explicit',
        explicitIntent: true,
        protectedClass: 'none',
      }),
      ...(binding === undefined
        ? {}
        : {
            operationContext: {
              operationId: binding.operation.operationId,
              requestFingerprint: binding.operation.requestFingerprint,
              targetIds: [routeToken(binding.route, target.scope)],
            },
            ...(binding.confirmedElevation === undefined
              ? {}
              : { confirmedElevation: binding.confirmedElevation }),
          }),
    });
  }

  /** The consumed challenge, if any, that authorized this create. */
  private async createElevationBinding(
    operation: StoredOperation,
  ): Promise<{ readonly confirmedElevation?: ConfirmedElevation }> {
    const challenge = await this.store.findConsumedElevationChallenge(
      operation.operationId,
    );
    const confirmed =
      challenge === null ? undefined : consumedElevation(operation, challenge);
    return confirmed === undefined ? {} : { confirmedElevation: confirmed };
  }

  private async executeCreate(
    principal: BrainPrincipal,
    operation: StoredOperation,
    route: CanonicalRoute,
    normalized: NormalizedPersist,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    const target = this.createTarget(route);
    if (target === undefined) {
      const failed = await this.transition(
        operation.operationId,
        ['RECEIVED'],
        {
          state: 'FAILED',
          provider: route.provider,
          errorCode: 'unauthorized',
          policyVersion: route.policyVersion,
          reasonCode: 'route_surface_unregistered',
        },
      );
      return storedResponse(failed);
    }
    const decision = this.evaluateCreate(principal, target, {
      operation,
      route,
    });
    if (
      decision.kind === 'ELEVATION_REQUIRED' &&
      principal.role !== 'family_participant'
    ) {
      if (this.elevations === undefined) {
        // Never strand a create in ELEVATION_PENDING with no way to confirm it.
        const failed = await this.transition(
          operation.operationId,
          ['RECEIVED'],
          {
            state: 'FAILED',
            provider: route.provider,
            errorCode: 'internal_error',
            policyVersion: decision.policyVersion,
            reasonCode: 'elevation_workflow_not_configured',
          },
        );
        return storedResponse(failed);
      }
      const pending = await this.transition(
        operation.operationId,
        ['RECEIVED'],
        {
          state: 'ELEVATION_PENDING',
          provider: route.provider,
          // The frozen route the challenge binds to; no body is stored.
          resultMetadata: {
            canonicalContainerRef: route.containerKey,
            elevationScope: target.scope,
            elevationDecisionReason: decision.reasonCode,
          },
          policyVersion: decision.policyVersion,
          reasonCode: decision.reasonCode,
        },
      );
      return this.issueElevation(principal, pending, [
        routeToken(route, target.scope),
      ]);
    }
    if (decision.kind !== 'ALLOW') {
      // Approval-gated creates do not exist under current policy; Participant
      // never elevates. Both fail closed.
      const failed = await this.transition(
        operation.operationId,
        ['RECEIVED'],
        {
          state: 'FAILED',
          provider: route.provider,
          errorCode:
            decision.kind === 'ELEVATION_REQUIRED'
              ? 'unauthorized'
              : decision.kind === 'APPROVAL_REQUIRED'
                ? 'approval_required'
                : 'unauthorized',
          policyVersion: decision.policyVersion,
          reasonCode:
            decision.kind === 'DENY'
              ? decision.reasonCode
              : decision.kind === 'ELEVATION_REQUIRED'
                ? 'family_participant_cannot_elevate'
                : 'gated_create_not_supported',
        },
      );
      return storedResponse(failed);
    }
    const sensitivity = normalized.semanticMetadata.sensitivity;
    if (sensitivity === undefined) {
      throw new DomainError('internal_error', false, {
        reason: 'routed_sensitivity_missing',
      });
    }
    // Check cancellation before the claim; after it, the adapter maps abort to unknown.
    assertActive(signal);
    const executing = await this.transition(
      operation.operationId,
      ['RECEIVED'],
      {
        state: 'EXECUTING',
        provider: route.provider,
        resultMetadata: { canonicalContainerRef: route.containerKey },
        policyVersion: decision.policyVersion,
        reasonCode: decision.reasonCode,
      },
    );
    try {
      return await this.dispatchCreate(
        operation,
        executing,
        route,
        target,
        normalized,
        sensitivity,
        decision.policyVersion,
        signal,
      );
    } catch (error) {
      return this.yieldToRecovery(operation, error);
    }
  }

  private async dispatchCreate(
    operation: StoredOperation,
    executing: StoredOperation,
    route: CanonicalRoute,
    target: CreateTarget,
    normalized: NormalizedPersist,
    sensitivity: Sensitivity,
    policyVersion: string,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    let result: ProviderMutationResult;
    try {
      result = await target.provider.create(
        {
          operationId: operation.operationId,
          access: target.access,
          title: normalized.title,
          content: normalized.content,
          contentType: 'text/markdown',
          canonicalLocation: {
            provider: route.provider,
            containerRef: route.containerKey,
          },
          policy: {
            scope: target.scope,
            sensitivity,
            protectedClass: target.protectedClass,
          },
        },
        signal,
      );
    } catch (error) {
      if (error instanceof DomainError && error.code !== 'outcome_unknown') {
        const failed = await this.transition(
          operation.operationId,
          ['EXECUTING'],
          {
            state: 'FAILED',
            provider: route.provider,
            errorCode: error.code,
            policyVersion: policyVersion,
            reasonCode: stringMetadata(error.details, 'reason') ?? error.code,
          },
        );
        return storedResponse(failed);
      }
      return this.markCreateUnknown(executing, route);
    }
    if (result.outcome === 'unknown') {
      return this.markCreateUnknown(executing, route, result.reconciliationKey);
    }
    return this.completeCreate(
      executing,
      route,
      result.record,
      ['EXECUTING'],
      'provider_mutation_completed',
    );
  }

  private async completeCreate(
    operation: StoredOperation,
    route: CanonicalRoute,
    reference: ProviderMutationReference,
    expectedStates: readonly ('EXECUTING' | 'OUTCOME_UNKNOWN')[],
    reasonCode: string,
  ): Promise<MutationResponse> {
    if (!referenceMatchesRoute(reference, route)) {
      return expectedStates.includes('EXECUTING')
        ? this.markCreateUnknown(operation, route)
        : storedResponse(operation);
    }
    const completed = await this.transition(
      operation.operationId,
      expectedStates,
      {
        state: 'COMPLETED',
        provider: route.provider,
        providerRecordId: reference.providerRecordId,
        ...(reference.providerVersion === undefined
          ? {}
          : { providerVersion: reference.providerVersion }),
        resultMetadata: resultMetadata(reference),
        ...(operation.policyVersion === undefined
          ? {}
          : { policyVersion: operation.policyVersion }),
        ...(reference.integrityHash === undefined
          ? {}
          : { integrityHash: reference.integrityHash }),
        reasonCode,
      },
    );
    return this.completedCreate(completed);
  }

  /** Completion is durable first; the alias is derived idempotently on every replay. */
  private async completedCreate(
    operation: StoredOperation,
  ): Promise<MutationResponse> {
    const response = storedResponse(operation);
    const record = response.record;
    if (record === undefined || record.provider === 'github') {
      throw new DomainError('internal_error', false, {
        reason: 'stored_mutation_result_invalid',
      });
    }
    let alias: BrainRecordAlias;
    try {
      alias = await this.store.ensureBrainRecordAlias({
        brainRecordId: createdAliasId(record.provider, record.providerRecordId),
        provider: record.provider,
        providerRecordId: record.providerRecordId,
        canonicalLocation: record.canonicalLocation,
        creatorPrincipalId: operation.principalId,
        createdAt: operation.updatedAt,
        updatedAt: operation.updatedAt,
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('provider_unavailable', true, {
        reason: 'created_alias_unavailable',
      });
    }
    if (
      alias.provider !== record.provider ||
      alias.providerRecordId !== record.providerRecordId
    ) {
      throw new DomainError('provider_unavailable', true, {
        reason: 'created_alias_invalid',
      });
    }
    return { ...response, brainRecordId: alias.brainRecordId };
  }

  private async markCreateUnknown(
    operation: StoredOperation,
    route: CanonicalRoute,
    reconciliationKey?: string,
  ): Promise<MutationResponse> {
    const unknown = await this.transition(
      operation.operationId,
      ['EXECUTING'],
      {
        state: 'OUTCOME_UNKNOWN',
        provider: route.provider,
        resultMetadata: {
          canonicalContainerRef: route.containerKey,
          ...reconciliationMetadata(reconciliationKey),
        },
        reasonCode: 'provider_outcome_unknown',
      },
    );
    return storedResponse(unknown);
  }

  /** Reconcile by operation marker under the same route; never re-create. */
  private async reconcileCreate(
    principal: BrainPrincipal,
    operation: StoredOperation,
    route: CanonicalRoute,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    const target = this.createTarget(route);
    if (
      operation.provider !== route.provider ||
      stringMetadata(operation.resultMetadata, 'canonicalContainerRef') !==
        route.containerKey ||
      target === undefined ||
      this.evaluateCreate(principal, target, {
        operation,
        route,
        ...(await this.createElevationBinding(operation)),
      }).kind !== 'ALLOW'
    ) {
      return storedResponse(operation);
    }
    const previous = await this.store.listReconciliationAttempts(
      operation.operationId,
    );
    const attempt = previous.length + 1;
    const reconciliationKey = stringMetadata(
      operation.resultMetadata,
      'reconciliationKey',
    );
    let result;
    try {
      result = await target.provider.reconcile(
        {
          operationId: operation.operationId,
          operation: 'create',
          access: target.access,
          ...(reconciliationKey === undefined ? {} : { reconciliationKey }),
        },
        signal,
      );
    } catch {
      result = undefined;
    }
    const valid =
      result?.outcome !== 'completed' ||
      referenceMatchesRoute(result.record, route);
    await this.store.recordReconciliationAttempt({
      operationId: operation.operationId,
      attempt,
      outcome: result === undefined || !valid ? 'failed' : result.outcome,
      attemptedAt: this.clock.now(),
    });
    if (result?.outcome !== 'completed' || !valid) {
      return storedResponse(operation);
    }
    return this.completeCreate(
      operation,
      route,
      result.record,
      ['OUTCOME_UNKNOWN'],
      'provider_reconciliation_completed',
    );
  }

  async appendToRecord(
    authenticated: AuthenticatedPrincipal,
    requestContext: RequestContext,
    request: AppendRecordRequest,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    this.assertTargetRequest(authenticated, requestContext, request, signal);
    const content = request.content;
    if (
      !storableText(content) ||
      content.trim().length === 0 ||
      Buffer.byteLength(content, 'utf8') > maxPersistContentBytes
    ) {
      throw invalid('invalid_append_request');
    }
    return this.runTargetChange(
      authenticated,
      requestContext,
      request,
      { operation: 'append_to_record', content },
      request.elevation,
      // No body is stored: an elevated confirmation repeats the exact payload.
      undefined,
      signal,
    );
  }

  /** Recoverable trash of one explicitly identified record; never permanent. */
  async deleteRecord(
    authenticated: AuthenticatedPrincipal,
    requestContext: RequestContext,
    request: DeleteRecordRequest,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    this.assertTargetRequest(authenticated, requestContext, request, signal);
    // Inferred or broad deletion is never routine; only a literal true counts.
    if ((request.explicitIntent as unknown) !== true) {
      throw invalid('explicit_delete_intent_required');
    }
    return this.runTargetChange(
      authenticated,
      requestContext,
      request,
      { operation: 'delete_record' },
      request.elevation,
      undefined,
      signal,
    );
  }

  async updateRecord(
    authenticated: AuthenticatedPrincipal,
    requestContext: RequestContext,
    request: UpdateRecordRequest,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    this.assertTargetRequest(authenticated, requestContext, request, signal);
    const normalized = normalizeMutation(request.mutation);
    return this.runTargetChange(
      authenticated,
      requestContext,
      request,
      updateChange(normalized.mutation),
      request.elevation,
      // Approval resumption rebuilds the update from this minimum payload.
      normalized.payload,
      signal,
    );
  }

  private assertTargetRequest(
    authenticated: AuthenticatedPrincipal,
    requestContext: RequestContext,
    request: UpdateRecordRequest | AppendRecordRequest | DeleteRecordRequest,
    signal: AbortSignal,
  ): void {
    assertAuthenticated(authenticated);
    assertActive(signal);
    if (
      request.principalId !== authenticated.principal.id ||
      request.requestId !== requestContext.requestId ||
      request.clientId !== requestContext.clientId
    ) {
      throw operationIdentityMismatch();
    }
  }

  /** One durable, idempotent path for every change to an existing record. */
  private async runTargetChange(
    authenticated: AuthenticatedPrincipal,
    requestContext: RequestContext,
    request: UpdateRecordRequest | AppendRecordRequest | DeleteRecordRequest,
    change: TargetChange,
    rawElevation: unknown,
    mutationPayload: OperationalJsonObject | undefined,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    const elevation =
      rawElevation === undefined ? undefined : normalizeElevation(rawElevation);
    const fingerprint = changeFingerprint(request.brainRecordId, change);
    const opened = await this.openOperation({
      operationId: request.operationId,
      requestId: request.requestId,
      principalId: authenticated.principal.id,
      ...(request.clientId === undefined ? {} : { clientId: request.clientId }),
      operation: change.operation,
      requestFingerprint: fingerprint,
      ...(mutationPayload === undefined ? {} : { mutationPayload }),
      targetBrainRecordId: request.brainRecordId,
      createdAt: requestContext.receivedAt,
    });
    assertActive(signal);
    if (opened.disposition === 'created') {
      return this.executeCreated(
        authenticated,
        opened.operation,
        change,
        fingerprint,
        signal,
      );
    }
    const existing = opened.operation;
    if (existing.state === 'ELEVATION_PENDING') {
      return elevation === undefined
        ? this.issueElevation(authenticated.principal, existing)
        : this.confirmElevatedChange(
            authenticated.principal,
            existing,
            elevation,
            change,
            fingerprint,
            signal,
          );
    }
    if (
      existing.state === 'AUTHORIZATION_REQUIRED' ||
      existing.state === 'APPROVAL_PENDING'
    ) {
      if (this.approvals === undefined) {
        throw new DomainError('internal_error', false, {
          reason: 'approval_workflow_not_configured',
        });
      }
      const approval = await this.approvals.ensurePending(
        authenticated.principal,
        existing,
        signal,
      );
      const pending = await this.pendingAfterApproval(approval.operationId);
      if (pending === null) {
        throw new DomainError('provider_unavailable', true, {
          reason: 'approval_operation_state_unavailable',
        });
      }
      return storedResponse(pending);
    }
    if (existing.state === 'OUTCOME_UNKNOWN') {
      return this.reconcileUnknown(
        authenticated.principal,
        existing,
        change,
        fingerprint,
        signal,
      );
    }
    return this.existingResponse(existing);
  }

  private async executeCreated(
    authenticated: AuthenticatedPrincipal,
    operation: StoredOperation,
    change: TargetChange,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    let prepared: PreparedTarget;
    try {
      prepared = await this.prepareTarget(
        authenticated.principal,
        operation,
        change,
        fingerprint,
        signal,
      );
    } catch (error) {
      const code: DomainErrorCode =
        error instanceof DomainError ? error.code : 'internal_error';
      const failed = await this.transition(
        operation.operationId,
        ['RECEIVED'],
        {
          state: 'FAILED',
          errorCode: code,
          reasonCode:
            error instanceof DomainError
              ? (stringMetadata(error.details, 'reason') ?? error.code)
              : 'mutation_preparation_failed',
        },
      );
      return storedResponse(failed);
    }
    let decision = this.evaluatePrepared(
      authenticated.principal,
      operation,
      prepared,
      change,
      fingerprint,
    );
    if (
      decision.kind === 'ELEVATION_REQUIRED' &&
      authenticated.principal.role === 'family_participant'
    ) {
      // Participant can never hold a challenge; fail closed rather than escalate.
      decision = {
        kind: 'DENY',
        reasonCode: 'family_participant_cannot_elevate',
        policyVersion: decision.policyVersion,
      };
    }
    if (decision.kind !== 'ALLOW') {
      const state =
        decision.kind === 'APPROVAL_REQUIRED'
          ? 'AUTHORIZATION_REQUIRED'
          : decision.kind === 'ELEVATION_REQUIRED'
            ? 'ELEVATION_PENDING'
            : 'FAILED';
      const transitioned = await this.transition(
        operation.operationId,
        ['RECEIVED'],
        {
          state,
          provider: prepared.provider.provider,
          providerRecordId: prepared.alias.providerRecordId,
          ...(prepared.current.provenance.providerVersion === undefined
            ? {}
            : {
                providerVersion: prepared.current.provenance.providerVersion,
              }),
          policyVersion: decision.policyVersion,
          ...(decision.kind === 'APPROVAL_REQUIRED'
            ? { resultMetadata: approvalMetadata(prepared, decision) }
            : {}),
          // An approval-pending append keeps its body as the minimum payload
          // needed to execute after approval; routine appends store none.
          ...(decision.kind === 'APPROVAL_REQUIRED' &&
          change.operation === 'append_to_record'
            ? { mutationPayload: { content: change.content } }
            : {}),
          ...(decision.kind === 'ELEVATION_REQUIRED'
            ? { resultMetadata: elevationMetadata(prepared, decision) }
            : {}),
          ...(decision.kind === 'DENY' ? { errorCode: 'unauthorized' } : {}),
          reasonCode: decision.reasonCode,
        },
      );
      if (decision.kind === 'ELEVATION_REQUIRED') {
        return this.issueElevation(authenticated.principal, transitioned);
      }
      if (decision.kind === 'APPROVAL_REQUIRED') {
        if (this.approvals === undefined) {
          throw new DomainError('internal_error', false, {
            reason: 'approval_workflow_not_configured',
          });
        }
        const approval = await this.approvals.ensurePending(
          authenticated.principal,
          transitioned,
          signal,
        );
        const pending = await this.pendingAfterApproval(approval.operationId);
        if (pending === null) {
          throw new DomainError('provider_unavailable', true, {
            reason: 'approval_operation_state_unavailable',
          });
        }
        return storedResponse(pending);
      }
      return storedResponse(transitioned);
    }

    await this.transition(operation.operationId, ['RECEIVED'], {
      state: 'EXECUTING',
      provider: prepared.provider.provider,
      providerRecordId: prepared.alias.providerRecordId,
      ...(prepared.current.provenance.providerVersion === undefined
        ? {}
        : { providerVersion: prepared.current.provenance.providerVersion }),
      policyVersion: decision.policyVersion,
      reasonCode: decision.reasonCode,
    });
    return this.executeProviderChange(
      operation,
      prepared,
      change,
      decision.policyVersion,
      signal,
    );
  }

  /** Replay of a pending elevated create: a fresh challenge for the frozen route. */
  private reissueCreateElevation(
    principal: BrainPrincipal,
    operation: StoredOperation,
  ): Promise<MutationResponse> {
    const container = stringMetadata(
      operation.resultMetadata,
      'canonicalContainerRef',
    );
    const scope = brainScopes.find(
      (value) =>
        value === stringMetadata(operation.resultMetadata, 'elevationScope'),
    );
    if (
      container === undefined ||
      scope === undefined ||
      operation.provider === undefined ||
      operation.provider === 'github' ||
      operation.policyVersion === undefined
    ) {
      throw new DomainError('internal_error', false, {
        reason: 'elevated_create_snapshot_invalid',
      });
    }
    return this.issueElevation(principal, operation, [
      routeToken(
        {
          provider: operation.provider,
          containerKey: container,
          operation: 'persist_knowledge',
          policyVersion: operation.policyVersion,
          routingReason: 'frozen_elevation_route',
        },
        scope,
      ),
    ]);
  }

  /**
   * Second call of an elevated create: the freshly derived route, scope,
   * decision and policy version must equal the frozen ones before the
   * challenge is consumed and execution claimed atomically.
   */
  private async confirmElevatedCreate(
    principal: BrainPrincipal,
    operation: StoredOperation,
    elevation: ElevationConfirmation,
    route: CanonicalRoute,
    normalized: NormalizedPersist,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    if (this.elevations === undefined) {
      throw new DomainError('internal_error', false, {
        reason: 'elevation_workflow_not_configured',
      });
    }
    if (operation.principalId !== principal.id) {
      throw invalid('elevated_create_operation_invalid');
    }
    const target = this.createTarget(route);
    if (target === undefined) {
      return this.settleElevation(
        operation,
        'FAILED',
        'route_surface_unregistered',
        'unauthorized',
      );
    }
    const decision = this.evaluateCreate(principal, target, {
      operation,
      route,
    });
    if (decision.kind === 'DENY') {
      return this.settleElevation(
        operation,
        'FAILED',
        decision.reasonCode,
        'unauthorized',
      );
    }
    if (
      decision.kind !== 'ELEVATION_REQUIRED' ||
      operation.provider !== route.provider ||
      operation.policyVersion !== decision.policyVersion ||
      stringMetadata(operation.resultMetadata, 'canonicalContainerRef') !==
        route.containerKey ||
      stringMetadata(operation.resultMetadata, 'elevationScope') !==
        target.scope ||
      stringMetadata(operation.resultMetadata, 'elevationDecisionReason') !==
        decision.reasonCode
    ) {
      return this.settleElevation(
        operation,
        'SUPERSEDED',
        'elevation_route_changed',
      );
    }
    const token = routeToken(route, target.scope);
    const elevated = this.evaluateCreate(principal, target, {
      operation,
      route,
      confirmedElevation: {
        challengeId: elevation.challengeId,
        operationId: operation.operationId,
        principalId: principal.id,
        operation: 'persist_knowledge',
        requestFingerprint: operation.requestFingerprint,
        policyVersion: decision.policyVersion,
        frozenTargetIds: [token],
        consumedAt: this.clock.now(),
      },
    });
    if (elevated.kind !== 'ALLOW') {
      return this.settleElevation(
        operation,
        'SUPERSEDED',
        'elevation_confirmation_not_allowed',
      );
    }
    const sensitivity = normalized.semanticMetadata.sensitivity;
    if (sensitivity === undefined) {
      throw new DomainError('internal_error', false, {
        reason: 'routed_sensitivity_missing',
      });
    }
    assertActive(signal);
    let claimed: StoredOperation;
    try {
      ({ operation: claimed } = await this.elevations.confirmAndClaim(
        {
          principal,
          operationId: operation.operationId,
          frozenTargetIds: [token],
          challengeId: elevation.challengeId,
          confirmationToken: elevation.confirmationToken,
          requestFingerprint: operation.requestFingerprint,
          policyVersion: decision.policyVersion,
        },
        { provider: route.provider, reasonCode: elevated.reasonCode },
      ));
    } catch (error) {
      // A lost acknowledgement or a concurrent winner must never dispatch here.
      const current = await this.reloadOrThrow(operation, error);
      if (current.state !== 'ELEVATION_PENDING') {
        return this.currentResponse(current);
      }
      if (error instanceof DomainError && error.code === 'elevation_required') {
        await this.auditRejectedElevation(
          operation,
          stringMetadata(error.details, 'reason') ?? error.code,
        );
      }
      throw error;
    }
    try {
      return await this.dispatchCreate(
        operation,
        claimed,
        route,
        target,
        normalized,
        sensitivity,
        decision.policyVersion,
        signal,
      );
    } catch (error) {
      return this.yieldToRecovery(operation, error);
    }
  }

  private async issueElevation(
    principal: BrainPrincipal,
    operation: StoredOperation,
    frozenTargetIds:
      | readonly BrainRecordAlias['brainRecordId'][]
      | undefined = operation.targetBrainRecordId === undefined
      ? undefined
      : [operation.targetBrainRecordId],
  ): Promise<MutationResponse> {
    if (this.elevations === undefined) {
      throw new DomainError('internal_error', false, {
        reason: 'elevation_workflow_not_configured',
      });
    }
    if (frozenTargetIds === undefined) {
      throw invalid('mutation_target_missing');
    }
    let grant;
    try {
      grant = await this.elevations.issue({
        principal,
        operationId: operation.operationId,
        frozenTargetIds,
      });
    } catch (error) {
      // A concurrent confirmation may have settled the operation meanwhile.
      const current = await this.reloadOrThrow(operation, error);
      if (current.state !== 'ELEVATION_PENDING') {
        return this.currentResponse(current);
      }
      throw error;
    }
    return {
      operationId: operation.operationId,
      state: 'elevation_required',
      elevation: grant,
    };
  }

  /**
   * Second elevation call: freshly revalidate the frozen target, then consume
   * the challenge and claim execution atomically before one provider dispatch.
   */
  private async confirmElevatedChange(
    principal: BrainPrincipal,
    operation: StoredOperation,
    elevation: ElevationConfirmation,
    change: TargetChange,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    if (this.elevations === undefined) {
      throw new DomainError('internal_error', false, {
        reason: 'elevation_workflow_not_configured',
      });
    }
    const targetId = operation.targetBrainRecordId;
    if (targetId === undefined || operation.principalId !== principal.id) {
      throw invalid('elevated_update_operation_invalid');
    }
    let prepared: PreparedTarget;
    try {
      prepared = await this.prepareTarget(
        principal,
        operation,
        change,
        fingerprint,
        signal,
      );
    } catch (error) {
      if (
        error instanceof DomainError &&
        ['not_found', 'unauthorized', 'protected_record'].includes(error.code)
      ) {
        return this.settleElevation(
          operation,
          error.code === 'not_found' ? 'SUPERSEDED' : 'FAILED',
          stringMetadata(error.details, 'reason') ?? error.code,
          error.code === 'not_found' ? undefined : error.code,
        );
      }
      throw error;
    }
    const decision = this.evaluatePrepared(
      principal,
      operation,
      prepared,
      change,
      fingerprint,
    );
    if (decision.kind === 'DENY') {
      // Elevation never overrides an action that policy now forbids.
      return this.settleElevation(
        operation,
        'FAILED',
        decision.reasonCode,
        'unauthorized',
      );
    }
    if (!elevationSnapshotMatches(operation, prepared, decision)) {
      return this.settleElevation(
        operation,
        'SUPERSEDED',
        'elevation_target_changed',
      );
    }
    const elevated = this.evaluatePrepared(
      principal,
      operation,
      prepared,
      change,
      fingerprint,
      {
        challengeId: elevation.challengeId,
        operationId: operation.operationId,
        principalId: principal.id,
        operation: change.operation,
        requestFingerprint: fingerprint,
        policyVersion: decision.policyVersion,
        frozenTargetIds: [targetId],
        consumedAt: this.clock.now(),
      },
    );
    if (elevated.kind !== 'ALLOW') {
      return this.settleElevation(
        operation,
        'SUPERSEDED',
        'elevation_confirmation_not_allowed',
      );
    }
    assertActive(signal);
    let claimed: StoredOperation;
    try {
      ({ operation: claimed } = await this.elevations.confirmAndClaim(
        {
          principal,
          operationId: operation.operationId,
          frozenTargetIds: [targetId],
          challengeId: elevation.challengeId,
          confirmationToken: elevation.confirmationToken,
          requestFingerprint: fingerprint,
          policyVersion: decision.policyVersion,
        },
        {
          provider: prepared.provider.provider,
          providerRecordId: prepared.alias.providerRecordId,
          ...(prepared.current.provenance.providerVersion === undefined
            ? {}
            : { providerVersion: prepared.current.provenance.providerVersion }),
          reasonCode: elevated.reasonCode,
        },
      ));
    } catch (error) {
      // A lost acknowledgement or a concurrent winner must never dispatch here.
      const current = await this.reloadOrThrow(operation, error);
      if (current.state !== 'ELEVATION_PENDING') {
        return this.currentResponse(current);
      }
      if (error instanceof DomainError && error.code === 'elevation_required') {
        await this.auditRejectedElevation(
          operation,
          stringMetadata(error.details, 'reason') ?? error.code,
        );
      }
      throw error;
    }
    return this.executeProviderChange(
      claimed,
      prepared,
      change,
      decision.policyVersion,
      signal,
    );
  }

  private async settleElevation(
    operation: StoredOperation,
    state: 'FAILED' | 'SUPERSEDED',
    reasonCode: string,
    errorCode?: DomainErrorCode,
  ): Promise<MutationResponse> {
    let settled: StoredOperation;
    try {
      settled = await this.transition(
        operation.operationId,
        ['ELEVATION_PENDING'],
        {
          state,
          ...(errorCode === undefined ? {} : { errorCode }),
          reasonCode,
        },
      );
    } catch (error) {
      const current = await this.reloadOrThrow(operation, error);
      if (current.state === 'ELEVATION_PENDING') {
        throw error;
      }
      return this.currentResponse(current);
    }
    return storedResponse(settled);
  }

  /** Reload durable state after a failed write; the original error wins on failure. */
  private async reloadOrThrow(
    operation: StoredOperation,
    original: unknown,
  ): Promise<StoredOperation> {
    let current: StoredOperation | null;
    try {
      current = await this.store.getOperation(operation.operationId);
    } catch {
      throw original;
    }
    if (current === null) throw original;
    return current;
  }

  /**
   * The answer for an existing operation a retry found. A stale RECEIVED one
   * is settled FAILED: no provider write was ever dispatched, so the outcome
   * is certain, and a racing duplicate settle returns the same result. If a
   * lingering original claimed it first, the retry answers from its state.
   */
  private async existingResponse(
    operation: StoredOperation,
  ): Promise<MutationResponse> {
    if (
      operation.state !== 'RECEIVED' ||
      this.clock.now().getTime() - operation.updatedAt.getTime() <
        staleReceivedAfterMs
    ) {
      return this.currentResponse(operation);
    }
    let settled: StoredOperation;
    try {
      settled = await this.transition(operation.operationId, ['RECEIVED'], {
        state: 'FAILED',
        errorCode: 'provider_unavailable',
        reasonCode: 'operation_abandoned_before_dispatch',
      });
    } catch (error) {
      let current: StoredOperation | null;
      try {
        current = await this.store.getOperation(operation.operationId);
      } catch {
        throw error;
      }
      if (current === null || current.state === 'RECEIVED') throw error;
      return this.currentResponse(current);
    }
    return storedResponse(settled);
  }

  private currentResponse(operation: StoredOperation): MutationResponse {
    if (operation.state === 'RECEIVED' || operation.state === 'EXECUTING') {
      throw operationInProgress();
    }
    return storedResponse(operation);
  }

  private async auditRejectedElevation(
    operation: StoredOperation,
    reasonCode: string,
  ): Promise<void> {
    try {
      await this.store.enqueueAuditEvent({
        eventType: 'brain.elevation.rejected',
        requestId: operation.requestId,
        principalId: operation.principalId,
        ...(operation.clientId === undefined
          ? {}
          : { clientId: operation.clientId }),
        operationId: operation.operationId,
        operation: operation.operation,
        ...(operation.targetBrainRecordId === undefined
          ? {}
          : { brainRecordId: operation.targetBrainRecordId }),
        ...(operation.policyVersion === undefined
          ? {}
          : { policyVersion: operation.policyVersion }),
        outcome: 'DENIED',
        reasonCode,
        timestamp: this.clock.now(),
      });
    } catch {
      // The rejection stands even when its metadata-only audit cannot be queued.
    }
  }

  /**
   * Owner-operator recovery of a direct operation stranded in EXECUTING.
   * Reconcile-only: it finalizes COMPLETED solely on this operation's provider
   * marker, otherwise records OUTCOME_UNKNOWN for operator investigation, and
   * never dispatches a mutation. Approval-claimed operations keep their path.
   */
  async recoverStrandedExecution(
    operator: AuthenticatedPrincipal,
    requestContext: RequestContext,
    request: RecoverStrandedExecutionRequest,
    signal: AbortSignal,
  ): Promise<StrandedRecoveryResult> {
    assertAuthenticated(operator);
    assertActive(signal);
    if (
      operator.principal.role !== 'owner_operator' ||
      operator.principal.status !== 'active'
    ) {
      throw new DomainError('unauthorized', false, {
        reason: 'recovery_owner_operator_only',
      });
    }
    if (
      !Number.isSafeInteger(request.staleAfterMs) ||
      request.staleAfterMs < minimumStaleAfterMs
    ) {
      throw invalid('invalid_recovery_threshold');
    }
    const operation = await this.store.getOperation(request.operationId);
    if (operation === null) {
      throw new DomainError('not_found', false, {
        reason: 'operation_not_found',
      });
    }
    if (operation.state !== 'EXECUTING') {
      return recoveryResult(
        operation,
        'not_executing',
        'recovery_not_executing',
      );
    }
    if (
      stringMetadata(operation.resultMetadata, 'approvalDecisionReason') !==
      undefined
    ) {
      return recoveryResult(
        operation,
        'approval_recovery_required',
        'recovery_approval_path_required',
      );
    }
    if (
      this.clock.now().getTime() - operation.updatedAt.getTime() <
      request.staleAfterMs
    ) {
      return recoveryResult(operation, 'not_stale', 'recovery_not_stale');
    }
    const settled = await this.reconcileStranded(operation, signal);
    await this.auditRecovery(operator, requestContext, settled);
    return settled;
  }

  private async reconcileStranded(
    operation: StoredOperation,
    signal: AbortSignal,
  ): Promise<StrandedRecoveryResult> {
    const principal = await this.store.getPrincipalById(operation.principalId);
    if (principal === null || principal.status !== 'active') {
      return this.settleStranded(operation, 'recovery_principal_unavailable');
    }
    if (operation.operation === 'persist_knowledge') {
      return this.reconcileStrandedCreate(principal, operation, signal);
    }
    if (
      operation.operation !== 'update_record' &&
      operation.operation !== 'append_to_record' &&
      operation.operation !== 'delete_record'
    ) {
      throw invalid('recovery_operation_unsupported');
    }
    let access: TargetAccess;
    try {
      access = await this.resolveTargetAccess(
        principal,
        operation,
        operation.operation,
        signal,
      );
    } catch (error) {
      // Cancellation or a transient state failure leaves the claim untouched.
      if (
        signal.aborted ||
        !(error instanceof DomainError) ||
        error.retryable
      ) {
        throw error;
      }
      return this.settleStranded(operation, 'recovery_access_unavailable');
    }
    const kind =
      operation.operation === 'update_record'
        ? 'update'
        : operation.operation === 'append_to_record'
          ? 'append'
          : 'trash';
    const reconciled = await this.strandedReconciliation(
      operation,
      access.provider,
      {
        operationId: operation.operationId,
        operation: kind,
        access: access.access,
        providerRecordId: access.alias.providerRecordId,
      },
      signal,
    );
    if (reconciled.record === undefined) {
      return this.settleStranded(operation, reconciled.reason);
    }
    let reference: ValidatedMutationReference;
    try {
      reference = this.validateReference(reconciled.record, access);
    } catch {
      return this.settleStranded(
        operation,
        'recovery_provider_reference_invalid',
      );
    }
    return this.settleStranded(
      operation,
      'recovery_provider_marker_completed',
      {
        state: 'COMPLETED',
        provider: reference.provider,
        providerRecordId: reference.providerRecordId,
        ...(reference.providerVersion === undefined
          ? {}
          : { providerVersion: reference.providerVersion }),
        resultMetadata: resultMetadata(reference),
        policyVersion: operation.policyVersion ?? access.policyVersion,
        ...(reference.integrityHash === undefined
          ? {}
          : { integrityHash: reference.integrityHash }),
      },
    );
  }

  private async reconcileStrandedCreate(
    principal: BrainPrincipal,
    operation: StoredOperation,
    signal: AbortSignal,
  ): Promise<StrandedRecoveryResult> {
    let route: CanonicalRoute;
    try {
      route = this.router.route({
        operation: 'persist_knowledge',
        semanticMetadata: operation.semanticMetadata ?? {},
      });
    } catch {
      return this.settleStranded(operation, 'recovery_route_changed');
    }
    if (
      operation.provider !== route.provider ||
      stringMetadata(operation.resultMetadata, 'canonicalContainerRef') !==
        route.containerKey
    ) {
      return this.settleStranded(operation, 'recovery_route_changed');
    }
    const target = this.createTarget(route);
    if (
      target === undefined ||
      this.evaluateCreate(principal, target, {
        operation,
        route,
        ...(await this.createElevationBinding(operation)),
      }).kind !== 'ALLOW'
    ) {
      return this.settleStranded(operation, 'recovery_access_unavailable');
    }
    const reconciliationKey = stringMetadata(
      operation.resultMetadata,
      'reconciliationKey',
    );
    const reconciled = await this.strandedReconciliation(
      operation,
      target.provider,
      {
        operationId: operation.operationId,
        operation: 'create',
        access: target.access,
        ...(reconciliationKey === undefined ? {} : { reconciliationKey }),
      },
      signal,
    );
    if (reconciled.record === undefined) {
      return this.settleStranded(operation, reconciled.reason);
    }
    if (!referenceMatchesRoute(reconciled.record, route)) {
      return this.settleStranded(
        operation,
        'recovery_provider_reference_invalid',
      );
    }
    try {
      await this.completeCreate(
        operation,
        route,
        reconciled.record,
        ['EXECUTING'],
        'recovery_provider_marker_completed',
      );
    } catch (error) {
      const current = await this.reloadOrThrow(operation, error);
      if (current.state === 'EXECUTING') throw error;
    }
    const current = await this.reloadOrThrow(
      operation,
      new DomainError('provider_unavailable', true, {
        reason: 'recovery_operation_state_unavailable',
      }),
    );
    return recoveryResult(
      current,
      current.state === 'COMPLETED' ? 'completed' : 'not_executing',
      current.state === 'COMPLETED'
        ? 'recovery_provider_marker_completed'
        : 'recovery_not_executing',
    );
  }

  /** One read-only provider lookup by this operation's own marker. */
  private async strandedReconciliation(
    operation: StoredOperation,
    provider: MutableKnowledgeProvider,
    request: Parameters<MutableKnowledgeProvider['reconcile']>[0],
    signal: AbortSignal,
  ): Promise<{
    readonly record?: ProviderMutationReference;
    readonly reason: string;
  }> {
    const previous = await this.store.listReconciliationAttempts(
      operation.operationId,
    );
    let outcome: 'completed' | 'not_found' | 'inconclusive' | 'failed';
    let record: ProviderMutationReference | undefined;
    try {
      const result = await provider.reconcile(request, signal);
      outcome = result.outcome;
      if (result.outcome === 'completed') record = result.record;
    } catch (error) {
      if (signal.aborted) throw error;
      outcome = 'failed';
    }
    const reason =
      outcome === 'completed'
        ? 'recovery_provider_marker_completed'
        : outcome === 'not_found'
          ? 'recovery_provider_marker_not_found'
          : outcome === 'inconclusive'
            ? 'recovery_reconciliation_inconclusive'
            : 'recovery_reconciliation_failed';
    await this.store.recordReconciliationAttempt({
      operationId: operation.operationId,
      attempt: previous.length + 1,
      outcome,
      safeMetadata: { recoveryReason: reason },
      attemptedAt: this.clock.now(),
    });
    return record === undefined ? { reason } : { record, reason };
  }

  /**
   * Compare-and-set out of EXECUTING: COMPLETED only with positive proof,
   * otherwise OUTCOME_UNKNOWN keeping the in-flight payload and metadata.
   */
  private async settleStranded(
    operation: StoredOperation,
    reasonCode: string,
    completion?: {
      readonly state: 'COMPLETED';
      readonly provider: MutableKnowledgeProvider['provider'];
      readonly providerRecordId: StoredOperation['providerRecordId'];
      readonly providerVersion?: string;
      readonly resultMetadata: OperationalJsonObject;
      readonly policyVersion?: string;
      readonly integrityHash?: string;
    },
  ): Promise<StrandedRecoveryResult> {
    let settled: StoredOperation;
    try {
      settled = await this.transition(
        operation.operationId,
        ['EXECUTING'],
        completion === undefined
          ? {
              state: 'OUTCOME_UNKNOWN',
              resultMetadata: {
                ...(operation.resultMetadata ?? {}),
                recoveryReason: reasonCode,
              },
              reasonCode,
            }
          : { ...completion, reasonCode },
      );
    } catch (error) {
      // A concurrent executor or replay settled it first; never overwrite.
      const current = await this.reloadOrThrow(operation, error);
      if (current.state === 'EXECUTING') throw error;
      return recoveryResult(current, 'not_executing', 'recovery_not_executing');
    }
    if (
      settled.state === 'OUTCOME_UNKNOWN' &&
      stringMetadata(settled.resultMetadata, 'recoveryReason') !== reasonCode
    ) {
      // Another executor settled it; do not claim its outcome as ours.
      return recoveryResult(settled, 'not_executing', 'recovery_not_executing');
    }
    return recoveryResult(
      settled,
      settled.state === 'COMPLETED' ? 'completed' : 'outcome_unknown',
      reasonCode,
    );
  }

  private async auditRecovery(
    operator: AuthenticatedPrincipal,
    requestContext: RequestContext,
    result: StrandedRecoveryResult,
  ): Promise<void> {
    try {
      const operation = await this.store.getOperation(result.operationId);
      if (operation === null) return;
      await this.store.enqueueAuditEvent({
        eventType: 'brain.operation.recovery',
        requestId: requestContext.requestId,
        principalId: operator.principal.id,
        ...(requestContext.clientId === undefined
          ? {}
          : { clientId: requestContext.clientId }),
        operationId: result.operationId,
        operation: operation.operation,
        ...(operation.provider === undefined
          ? {}
          : { provider: operation.provider }),
        ...(operation.providerRecordId === undefined
          ? {}
          : { providerRecordId: operation.providerRecordId }),
        ...(operation.policyVersion === undefined
          ? {}
          : { policyVersion: operation.policyVersion }),
        outcome: result.state,
        reasonCode: result.reasonCode,
        timestamp: this.clock.now(),
      });
    } catch {
      // The committed transition and its own audit stand without this event.
    }
  }

  async resumeApprovedUpdate(
    operation: StoredOperation,
    originalPrincipal: BrainPrincipal,
    beforeDispatch: (operation: StoredOperation) => Promise<{
      readonly disposition: 'resolved' | 'existing';
      readonly operation: StoredOperation;
    }>,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    assertActive(signal);
    if (
      operation.state !== 'APPROVAL_PENDING' ||
      operation.principalId !== originalPrincipal.id
    ) {
      throw invalid('approved_change_operation_invalid');
    }
    const { change, fingerprint } = storedTargetChange(
      operation,
      'approved_change_operation_invalid',
    );
    const prepared = await this.prepareTarget(
      originalPrincipal,
      operation,
      change,
      fingerprint,
      signal,
    );
    const decision = this.evaluatePrepared(
      originalPrincipal,
      operation,
      prepared,
      change,
      fingerprint,
    );
    if (!approvalSnapshotMatches(operation, prepared, decision)) {
      throw new DomainError('not_found', false, {
        reason: 'approval_target_changed',
      });
    }
    const validated: StoredOperation = {
      ...operation,
      provider: prepared.provider.provider,
      providerRecordId: prepared.alias.providerRecordId,
      ...(prepared.current.provenance.providerVersion === undefined
        ? {}
        : { providerVersion: prepared.current.provenance.providerVersion }),
      policyVersion: decision.policyVersion,
    };
    const claimed = await beforeDispatch(validated);
    if (claimed.disposition === 'existing') {
      return storedResponse(claimed.operation);
    }
    assertActive(signal);
    return this.executeProviderChange(
      claimed.operation,
      prepared,
      change,
      decision.policyVersion,
      signal,
    );
  }

  async reconcileApprovedUpdate(
    operation: StoredOperation,
    originalPrincipal: BrainPrincipal,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    if (
      operation.state !== 'OUTCOME_UNKNOWN' ||
      operation.principalId !== originalPrincipal.id
    ) {
      throw invalid('approved_change_reconciliation_invalid');
    }
    const { change, fingerprint } = storedTargetChange(
      operation,
      'approved_change_reconciliation_invalid',
    );
    return this.reconcileUnknown(
      originalPrincipal,
      operation,
      change,
      fingerprint,
      signal,
      true,
    );
  }

  /**
   * Recovery of an approved execution that was claimed and may have reached
   * its provider. Reconcile-only (owner decision 2026-10-23): a missing marker
   * never justifies a re-dispatch. Positive proof finalizes COMPLETED; anything
   * else records OUTCOME_UNKNOWN for operator investigation, keeping the
   * payload, approval snapshot and correlation.
   */
  async recoverApprovedUpdate(
    operation: StoredOperation,
    originalPrincipal: BrainPrincipal,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    if (
      operation.state !== 'EXECUTING' ||
      operation.principalId !== originalPrincipal.id
    ) {
      throw invalid('approved_change_recovery_invalid');
    }
    const { change, fingerprint } = storedTargetChange(
      operation,
      'approved_change_recovery_invalid',
    );
    let target: TargetAccess;
    try {
      target = await this.reconciliationTarget(
        originalPrincipal,
        operation,
        change,
        fingerprint,
        signal,
        true,
      );
    } catch (error) {
      // Cancellation or a transient failure leaves the claim untouched.
      if (
        signal.aborted ||
        !(error instanceof DomainError) ||
        error.retryable
      ) {
        throw error;
      }
      await this.settleStranded(operation, 'recovery_access_unavailable');
      return this.approvedRecoveryResponse(operation);
    }
    const reconciled = await this.strandedReconciliation(
      operation,
      target.provider,
      {
        operationId: operation.operationId,
        operation: providerMutationKind(change),
        access: target.access,
        providerRecordId: target.alias.providerRecordId,
      },
      signal,
    );
    if (reconciled.record === undefined) {
      await this.settleStranded(operation, reconciled.reason);
      return this.approvedRecoveryResponse(operation);
    }
    let reference: ValidatedMutationReference;
    try {
      reference = this.validateReference(reconciled.record, target);
    } catch {
      await this.settleStranded(
        operation,
        'recovery_provider_reference_invalid',
      );
      return this.approvedRecoveryResponse(operation);
    }
    await this.settleStranded(operation, 'recovery_provider_marker_completed', {
      state: 'COMPLETED',
      provider: reference.provider,
      providerRecordId: reference.providerRecordId,
      ...(reference.providerVersion === undefined
        ? {}
        : { providerVersion: reference.providerVersion }),
      resultMetadata: resultMetadata(reference),
      policyVersion: operation.policyVersion ?? target.policyVersion,
      ...(reference.integrityHash === undefined
        ? {}
        : { integrityHash: reference.integrityHash }),
    });
    return this.approvedRecoveryResponse(operation);
  }

  /** Map a settlement to the client contract from the durable state. */
  private async approvedRecoveryResponse(
    operation: StoredOperation,
  ): Promise<MutationResponse> {
    const current = await this.reloadOrThrow(
      operation,
      new DomainError('provider_unavailable', true, {
        reason: 'recovery_operation_state_unavailable',
      }),
    );
    return this.currentResponse(current);
  }

  private async executeProviderChange(
    operation: StoredOperation,
    prepared: PreparedTarget,
    change: TargetChange,
    policyVersion: string,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    try {
      return await this.dispatchProviderChange(
        operation,
        prepared,
        change,
        policyVersion,
        signal,
      );
    } catch (error) {
      return this.yieldToRecovery(operation, error);
    }
  }

  /**
   * Stranded-execution recovery may already have recorded OUTCOME_UNKNOWN
   * while a slow write was in flight. The live caller then receives that
   * retryable state, never a terminal error that could invite a resubmission.
   */
  private async yieldToRecovery(
    operation: StoredOperation,
    error: unknown,
  ): Promise<MutationResponse> {
    const current = await this.reloadOrThrow(operation, error);
    if (current.state === 'OUTCOME_UNKNOWN') return storedResponse(current);
    throw error;
  }

  private async dispatchProviderChange(
    operation: StoredOperation,
    prepared: PreparedTarget,
    change: TargetChange,
    policyVersion: string,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    assertActive(signal);
    let result;
    try {
      const routed = {
        operationId: operation.operationId,
        access: prepared.access,
        providerRecordId: prepared.alias.providerRecordId,
        ...(prepared.current.provenance.providerVersion === undefined
          ? {}
          : {
              expectedProviderVersion:
                prepared.current.provenance.providerVersion,
            }),
      };
      result =
        change.operation === 'update_record'
          ? await prepared.provider.update(
              { ...routed, mutation: change.mutation },
              signal,
            )
          : change.operation === 'append_to_record'
            ? await prepared.provider.append(
                { ...routed, content: change.content },
                signal,
              )
            : await prepared.provider.trash(routed, signal);
    } catch (error) {
      if (error instanceof DomainError && error.code !== 'outcome_unknown') {
        const failed = await this.transition(
          operation.operationId,
          ['EXECUTING'],
          {
            state: 'FAILED',
            provider: prepared.provider.provider,
            providerRecordId: prepared.alias.providerRecordId,
            errorCode: error.code,
            policyVersion,
            reasonCode: stringMetadata(error.details, 'reason') ?? error.code,
          },
        );
        return storedResponse(failed);
      }
      return this.markUnknown(operation.operationId, prepared, undefined);
    }
    if (result.outcome === 'unknown') {
      return this.markUnknown(
        operation.operationId,
        prepared,
        result.reconciliationKey,
      );
    }
    let reference: ValidatedMutationReference;
    try {
      reference = this.validateReference(result.record, prepared);
    } catch {
      return this.markUnknown(operation.operationId, prepared, undefined);
    }
    const completed = await this.transition(
      operation.operationId,
      ['EXECUTING'],
      {
        state: 'COMPLETED',
        provider: reference.provider,
        providerRecordId: reference.providerRecordId,
        ...(reference.providerVersion === undefined
          ? {}
          : { providerVersion: reference.providerVersion }),
        resultMetadata: resultMetadata(reference),
        policyVersion,
        ...(reference.integrityHash === undefined
          ? {}
          : { integrityHash: reference.integrityHash }),
        reasonCode: 'provider_mutation_completed',
      },
    );
    return storedResponse(completed);
  }

  private evaluatePrepared(
    principal: BrainPrincipal,
    operation: StoredOperation,
    prepared: PreparedTarget,
    change: TargetChange,
    fingerprint: string,
    confirmedElevation?: ConfirmedElevation,
  ): AuthorizationDecision {
    const classification = this.destructive.classify(
      classificationInput(change, prepared.current.policy.protectedClass),
    );
    return this.authorization.evaluate({
      principal,
      operation: change.operation,
      scope: prepared.current.policy.scope,
      target: {
        scope: prepared.current.policy.scope,
        createdAt: prepared.current.provenance.createdAt,
        protectedClass: prepared.current.policy.protectedClass,
        ...(prepared.current.provenance.creatorPrincipalId === undefined
          ? {}
          : {
              creatorPrincipalId:
                prepared.current.provenance.creatorPrincipalId,
            }),
        ...(prepared.current.provenance.providerVersion === undefined
          ? {}
          : { providerVersion: prepared.current.provenance.providerVersion }),
      },
      destructive: classification,
      operationContext: {
        operationId: operation.operationId,
        requestFingerprint: fingerprint,
        targetIds: [
          operation.targetBrainRecordId ?? prepared.current.brainRecordId,
        ],
      },
      ...(confirmedElevation === undefined ? {} : { confirmedElevation }),
    });
  }

  /**
   * Opens or finds the durable operation. A dropped connection maps to a
   * retryable outage, never an internal error, and no provider call has been
   * made. If the insert committed but its acknowledgement was lost, a retry
   * with the same request ID finds the operation still RECEIVED: it answers
   * `operation_in_progress` until the operation is stale, then settles it
   * FAILED (see `existingResponse`). Domain errors pass through.
   */
  private async openOperation(
    record: Parameters<MutationStateStore['openOperation']>[0],
  ): ReturnType<MutationStateStore['openOperation']> {
    try {
      return await this.store.openOperation(record);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('provider_unavailable', true, {
        reason: 'operation_state_unavailable',
      });
    }
  }

  /** The operation after its approval request exists; an outage is retryable. */
  private async pendingAfterApproval(
    id: StoredOperation['operationId'],
  ): Promise<StoredOperation | null> {
    try {
      return await this.store.getOperation(id);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('provider_unavailable', true, {
        reason: 'approval_operation_state_unavailable',
      });
    }
  }

  /** Alias, route and the principal's current surface authorization; no provider I/O. */
  private async resolveTargetAccess(
    principal: BrainPrincipal,
    operation: StoredOperation,
    operationName: TargetChange['operation'],
    signal: AbortSignal,
  ): Promise<TargetAccess> {
    const targetId = operation.targetBrainRecordId;
    if (targetId === undefined) throw invalid('mutation_target_missing');
    let alias: BrainRecordAlias | null;
    try {
      alias = await this.store.findBrainRecordAlias(targetId);
    } catch (error) {
      // A dropped database connection is retryable, never internal.
      if (error instanceof DomainError) throw error;
      throw new DomainError('provider_unavailable', true, {
        reason: 'record_reference_store_unavailable',
      });
    }
    assertActive(signal);
    if (alias === null || alias.brainRecordId !== targetId) {
      throw new DomainError('not_found', false, { reason: 'record_not_found' });
    }
    const route = this.router.routeExisting({
      operation: operationName,
      canonicalLocation: alias.canonicalLocation,
    });
    if (route.provider !== alias.provider) {
      throw new DomainError('provider_capability_unsupported', false, {
        reason: 'mutation_provider_mismatch',
      });
    }
    const authorized = this.authorization
      .authorizedSearchSurfaces(principal, this.surfaces)
      .filter(
        (surface) =>
          surface.provider === alias.provider &&
          surface.containerKey === route.containerKey,
      );
    if (authorized.length === 0) {
      throw new DomainError('unauthorized', false, {
        reason: 'record_access_denied',
      });
    }
    const access: ProviderAccessScope = {
      brainScopes: [...new Set(authorized.map((surface) => surface.scope))],
      rootRefs: [route.containerKey],
    };
    const provider = this.providers.get(route.provider);
    if (provider === undefined) {
      throw new DomainError('provider_unavailable', true, {
        reason: 'mutation_provider_not_configured',
      });
    }
    return {
      alias,
      containerKey: route.containerKey,
      provider,
      access,
      policyVersion: route.policyVersion,
    };
  }

  private async prepareTarget(
    principal: BrainPrincipal,
    operation: StoredOperation,
    change: TargetChange,
    fingerprint: string,
    signal: AbortSignal,
    approved = false,
    confirmedElevation?: ConfirmedElevation,
  ): Promise<PreparedTarget> {
    const resolved = await this.resolveTargetAccess(
      principal,
      operation,
      change.operation,
      signal,
    );
    const { alias, provider, access } = resolved;
    const targetId = alias.brainRecordId;
    const route = { containerKey: resolved.containerKey };
    const current = withGatewayCreator(
      await provider.fetch(
        { providerRecordId: alias.providerRecordId, access },
        signal,
      ),
      alias,
    );
    assertActive(signal);
    if (
      current.provenance.provider !== alias.provider ||
      current.canonicalLocation.provider !== alias.provider ||
      current.provenance.providerRecordId !== alias.providerRecordId ||
      current.canonicalLocation.containerRef !== route.containerKey ||
      !access.brainScopes.includes(current.policy.scope)
    ) {
      throw new DomainError('provider_unavailable', true, {
        reason: 'provider_record_reference_mismatch',
      });
    }
    if (
      change.operation !== 'update_record' &&
      current.provenance.providerVersion === undefined
    ) {
      // Append rewrites and trash removes the stored body; never without a version guard.
      throw new DomainError('provider_capability_unsupported', false, {
        reason:
          change.operation === 'append_to_record'
            ? 'append_version_unavailable'
            : 'delete_version_unavailable',
      });
    }
    // Evaluated once here; the OUTCOME_UNKNOWN guard below refuses access loss.
    // Stranded EXECUTING recovery relies on resolveTargetAccess instead.
    const classification = this.destructive.classify(
      classificationInput(change, current.policy.protectedClass),
    );
    const decision = this.authorization.evaluate({
      principal,
      operation: change.operation,
      scope: current.policy.scope,
      target: {
        scope: current.policy.scope,
        createdAt: current.provenance.createdAt,
        protectedClass: current.policy.protectedClass,
        ...(current.provenance.creatorPrincipalId === undefined
          ? {}
          : { creatorPrincipalId: current.provenance.creatorPrincipalId }),
      },
      destructive: classification,
      operationContext: {
        operationId: operation.operationId,
        requestFingerprint: fingerprint,
        targetIds: [targetId],
      },
      ...(confirmedElevation === undefined ? {} : { confirmedElevation }),
    });
    if (
      operation.state === 'OUTCOME_UNKNOWN' &&
      decision.kind !== 'ALLOW' &&
      !(approved && decision.kind === 'APPROVAL_REQUIRED')
    ) {
      throw new DomainError('outcome_unknown', false, {
        reason: 'reconciliation_authorization_changed',
      });
    }
    return { ...resolved, current };
  }

  /**
   * A completed trash makes the target unfetchable, so an uncertain delete
   * reconciles with access resolved from the alias, route and the principal's
   * current surface authorization instead of a fresh fetch.
   */
  private async reconciliationTarget(
    principal: BrainPrincipal,
    operation: StoredOperation,
    change: TargetChange,
    fingerprint: string,
    signal: AbortSignal,
    approved: boolean,
    confirmedElevation?: ConfirmedElevation,
  ): Promise<TargetAccess> {
    try {
      return await this.prepareTarget(
        principal,
        operation,
        change,
        fingerprint,
        signal,
        approved,
        confirmedElevation,
      );
    } catch (error) {
      if (
        change.operation === 'delete_record' &&
        error instanceof DomainError &&
        error.code === 'not_found'
      ) {
        return this.resolveTargetAccess(
          principal,
          operation,
          change.operation,
          signal,
        );
      }
      throw error;
    }
  }

  private validateReference(
    reference: ProviderMutationReference,
    prepared: TargetAccess,
  ): ValidatedMutationReference {
    if (
      reference.provider !== prepared.alias.provider ||
      reference.providerRecordId !== prepared.alias.providerRecordId ||
      reference.canonicalLocation.provider !== prepared.alias.provider ||
      reference.canonicalLocation.containerRef !==
        prepared.alias.canonicalLocation.containerRef
    ) {
      throw new DomainError('outcome_unknown', false, {
        reason: 'provider_mutation_reference_mismatch',
      });
    }
    return {
      provider: prepared.provider.provider,
      providerRecordId: reference.providerRecordId,
      ...(reference.providerVersion === undefined
        ? {}
        : { providerVersion: reference.providerVersion }),
      canonicalLocation: {
        provider: prepared.provider.provider,
        containerRef: reference.canonicalLocation.containerRef,
        ...(reference.canonicalLocation.displayPath === undefined
          ? {}
          : { displayPath: reference.canonicalLocation.displayPath }),
      },
      ...(reference.integrityHash === undefined
        ? {}
        : { integrityHash: reference.integrityHash }),
    };
  }

  private async markUnknown(
    operationId: StoredOperation['operationId'],
    prepared: TargetAccess,
    reconciliationKey?: string,
  ): Promise<MutationResponse> {
    const providerVersion = prepared.current?.provenance.providerVersion;
    const unknown = await this.transition(operationId, ['EXECUTING'], {
      state: 'OUTCOME_UNKNOWN',
      provider: prepared.provider.provider,
      providerRecordId: prepared.alias.providerRecordId,
      ...(providerVersion === undefined ? {} : { providerVersion }),
      resultMetadata: reconciliationMetadata(reconciliationKey),
      policyVersion: prepared.policyVersion,
      reasonCode: 'provider_outcome_unknown',
    });
    return storedResponse(unknown);
  }

  private async reconcileUnknown(
    principal: BrainPrincipal,
    operation: StoredOperation,
    change: TargetChange,
    fingerprint: string,
    signal: AbortSignal,
    approved = false,
  ): Promise<MutationResponse> {
    let prepared: TargetAccess;
    try {
      // An elevated write stays reconcilable only under its exact consumed challenge.
      const challenge = approved
        ? null
        : await this.store.findConsumedElevationChallenge(
            operation.operationId,
          );
      prepared = await this.reconciliationTarget(
        principal,
        operation,
        change,
        fingerprint,
        signal,
        approved,
        challenge === null
          ? undefined
          : consumedElevation(operation, challenge),
      );
    } catch {
      return storedResponse(operation);
    }
    const previous = await this.store.listReconciliationAttempts(
      operation.operationId,
    );
    const attempt = previous.length + 1;
    const reconciliationKey = stringMetadata(
      operation.resultMetadata,
      'reconciliationKey',
    );
    let result;
    try {
      result = await prepared.provider.reconcile(
        {
          operationId: operation.operationId,
          operation: providerMutationKind(change),
          access: prepared.access,
          providerRecordId: prepared.alias.providerRecordId,
          ...(reconciliationKey === undefined ? {} : { reconciliationKey }),
        },
        signal,
      );
    } catch {
      await this.store.recordReconciliationAttempt({
        operationId: operation.operationId,
        attempt,
        outcome: 'failed',
        attemptedAt: this.clock.now(),
      });
      return storedResponse(operation);
    }
    if (result.outcome !== 'completed') {
      await this.store.recordReconciliationAttempt({
        operationId: operation.operationId,
        attempt,
        outcome: result.outcome,
        attemptedAt: this.clock.now(),
      });
      return storedResponse(operation);
    }
    let reference: ValidatedMutationReference;
    try {
      reference = this.validateReference(result.record, prepared);
    } catch {
      await this.store.recordReconciliationAttempt({
        operationId: operation.operationId,
        attempt,
        outcome: 'failed',
        attemptedAt: this.clock.now(),
      });
      return storedResponse(operation);
    }
    await this.store.recordReconciliationAttempt({
      operationId: operation.operationId,
      attempt,
      outcome: 'completed',
      attemptedAt: this.clock.now(),
    });
    const completed = await this.transition(
      operation.operationId,
      ['OUTCOME_UNKNOWN'],
      {
        state: 'COMPLETED',
        provider: reference.provider,
        providerRecordId: reference.providerRecordId,
        ...(reference.providerVersion === undefined
          ? {}
          : { providerVersion: reference.providerVersion }),
        resultMetadata: resultMetadata(reference),
        policyVersion: prepared.policyVersion,
        ...(reference.integrityHash === undefined
          ? {}
          : { integrityHash: reference.integrityHash }),
        reasonCode: 'provider_reconciliation_completed',
      },
    );
    return storedResponse(completed);
  }

  private async transition(
    operationId: StoredOperation['operationId'],
    expectedStates: Parameters<
      MutationStateStore['transitionOperationWithAudit']
    >[0]['expectedStates'],
    input: {
      readonly state: StoredOperation['state'];
      readonly provider?: MutableKnowledgeProvider['provider'];
      readonly providerRecordId?: StoredOperation['providerRecordId'];
      readonly providerVersion?: string;
      readonly resultMetadata?: OperationalJsonObject;
      readonly errorCode?: DomainErrorCode;
      readonly policyVersion?: string;
      readonly integrityHash?: string;
      readonly mutationPayload?: OperationalJsonObject;
      readonly reasonCode: string;
    },
  ): Promise<StoredOperation> {
    try {
      return await this.store.transitionOperationWithAudit(
        {
          operationId,
          expectedStates,
          nextState: input.state,
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.providerRecordId === undefined
            ? {}
            : { providerRecordId: input.providerRecordId }),
          ...(input.providerVersion === undefined
            ? {}
            : { providerVersion: input.providerVersion }),
          ...(input.resultMetadata === undefined
            ? {}
            : { resultMetadata: input.resultMetadata }),
          ...(input.errorCode === undefined
            ? {}
            : { errorCode: input.errorCode }),
          ...(input.policyVersion === undefined
            ? {}
            : { policyVersion: input.policyVersion }),
          ...(input.mutationPayload === undefined
            ? {}
            : { mutationPayload: input.mutationPayload }),
          transitionedAt: this.clock.now(),
        },
        {
          eventType: 'brain.mutation.transitioned',
          reasonCode: input.reasonCode,
          ...(input.integrityHash === undefined
            ? {}
            : { integrityHash: input.integrityHash }),
        },
      );
    } catch (error) {
      // The reload only detects a transition that committed anyway; if it
      // fails too, the original (already mapped) error is the answer.
      let reloaded: StoredOperation | null;
      try {
        reloaded = await this.store.getOperation(operationId);
      } catch {
        throw error;
      }
      if (reloaded?.state === input.state) return reloaded;
      throw error;
    }
  }
}
