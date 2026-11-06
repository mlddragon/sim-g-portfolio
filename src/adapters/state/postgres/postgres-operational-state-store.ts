import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  parseAuditedTransition,
  serializeAuditEvent,
  type SerializedAuditEvent,
} from '../../../domain/audit/serialize-audit-event.js';
import type {
  ApprovalRequest,
  ApprovalResolution,
  SafeApprovalSummary,
} from '../../../domain/approvals.js';
import { DomainError } from '../../../domain/errors.js';
import type { DomainErrorCode } from '../../../domain/errors.js';
import {
  approvalRequestId,
  brainRecordId,
  elevationChallengeId,
  operationId,
  principalId,
  providerRecordId,
  requestId,
} from '../../../domain/identifiers.js';
import type {
  BrainOperationName,
  OperationState,
  SemanticMetadata,
} from '../../../domain/operations.js';
import type {
  BrainPrincipal,
  PrincipalRole,
  PrincipalStatus,
} from '../../../domain/principal.js';
import type {
  CanonicalLocation,
  KnowledgeProviderName,
} from '../../../domain/records.js';
import type { AuditEvent } from '../../../ports/audit-sink.js';
import type { GovernanceArtifactKind } from '../../../ports/governance-source.js';
import type {
  ApprovalResolutionTransaction,
  ApprovalResolutionTransactionResult,
  AuditDeliveryErrorCode,
  AuditOutboxRecord,
  BrainRecordAlias,
  ConsumeElevationChallenge,
  ClaimedAuditOutboxRecord,
  ElevationConfirmationTransaction,
  ElevationConfirmationTransactionResult,
  CreateOperationRecord,
  GovernanceVersionRecord,
  MarkApprovalProjectionSynced,
  OpenOperationResult,
  OperationalJsonObject,
  OperationalStateStore,
  OperationTransition,
  OperationTransitionAudit,
  PrincipalIdentityBinding,
  ReconciliationAttempt,
  ResolveStoredApproval,
  SetApprovalProjectionReference,
  StoredElevationChallenge,
  StoredOperation,
} from '../../../ports/operational-state-store.js';

interface PrincipalRow extends QueryResultRow {
  readonly id: string;
  readonly principal_key: string;
  readonly display_name: string;
  readonly role: PrincipalRole;
  readonly status: PrincipalStatus;
}

interface PrincipalBindingRow extends QueryResultRow {
  readonly principal_id: string;
  readonly principal_key: string;
  readonly display_name: string;
  readonly role: PrincipalRole;
  readonly status: PrincipalStatus;
  readonly issuer: string;
  readonly external_subject: string;
  readonly email: string;
  readonly enabled: boolean;
}

interface OperationRow extends QueryResultRow {
  readonly id: string;
  readonly request_id: string;
  readonly principal_id: string;
  readonly client_id: string | null;
  readonly operation_type: BrainOperationName;
  readonly state: OperationState;
  readonly request_fingerprint: string;
  readonly semantic_metadata: SemanticMetadata | null;
  readonly mutation_payload: OperationalJsonObject | null;
  readonly target_brain_record_id: string | null;
  readonly provider: KnowledgeProviderName | null;
  readonly provider_record_id: string | null;
  readonly provider_version: string | null;
  readonly result_metadata: OperationalJsonObject | null;
  readonly error_code: DomainErrorCode | null;
  readonly policy_version: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ApprovalRow extends QueryResultRow {
  readonly id: string;
  readonly operation_id: string;
  readonly family_inbox_record_id: string | null;
  readonly requested_by_principal_id: string;
  readonly status: ApprovalRequest['status'];
  readonly projection_sync_status: ApprovalRequest['projectionSyncStatus'];
  readonly safe_summary: SafeApprovalSummary;
  readonly resolved_by_principal_id: string | null;
  readonly resolution_reason: string | null;
  readonly created_at: Date;
  readonly resolved_at: Date | null;
}

interface ElevationRow extends QueryResultRow {
  readonly id: string;
  readonly operation_id: string;
  readonly principal_id: string;
  readonly confirmation_token_hash: string;
  readonly request_fingerprint: string;
  readonly policy_version: string;
  readonly frozen_target_ids: readonly string[];
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly superseded_at: Date | null;
}

interface AliasRow extends QueryResultRow {
  readonly brain_record_id: string;
  readonly provider: KnowledgeProviderName;
  readonly provider_record_id: string;
  readonly canonical_location: CanonicalLocation;
  readonly creator_principal_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface GovernanceRow extends QueryResultRow {
  readonly kind: GovernanceArtifactKind;
  readonly version: string;
  readonly content_hash: string;
  readonly source_reference: string;
  readonly canonical_marker: string;
  readonly activated_at: Date;
}

interface ReconciliationRow extends QueryResultRow {
  readonly operation_id: string;
  readonly attempt: number;
  readonly outcome: ReconciliationAttempt['outcome'];
  readonly safe_metadata: OperationalJsonObject | null;
  readonly attempted_at: Date;
}

interface AuditOutboxRow extends QueryResultRow {
  readonly id: string;
  readonly event: SerializedAuditEvent;
  readonly attempts: number;
  readonly available_at: Date;
  readonly delivered_at: Date | null;
  readonly last_error_code: string | null;
}

interface AuditClaimRow extends AuditOutboxRow {
  readonly claim_token: string;
  readonly claim_expires_at: Date;
}

interface MatchRow extends QueryResultRow {
  readonly matches: boolean;
}

const operationColumns = `
  id,
  request_id,
  principal_id,
  client_id,
  operation_type,
  state,
  request_fingerprint,
  semantic_metadata,
  mutation_payload,
  target_brain_record_id,
  provider,
  provider_record_id,
  provider_version,
  result_metadata,
  error_code,
  policy_version,
  created_at,
  updated_at
`;

const approvalColumns = `
  id,
  operation_id,
  family_inbox_record_id,
  requested_by_principal_id,
  status,
  projection_sync_status,
  safe_summary,
  resolved_by_principal_id,
  resolution_reason,
  created_at,
  resolved_at
`;

const elevationColumns = `
  id,
  operation_id,
  principal_id,
  confirmation_token_hash,
  request_fingerprint,
  policy_version,
  frozen_target_ids,
  created_at,
  expires_at,
  consumed_at,
  superseded_at
`;

const aliasColumns = `
  brain_record_id,
  provider,
  provider_record_id,
  canonical_location,
  creator_principal_id,
  created_at,
  updated_at
`;

const auditOutboxColumns = `
  id::text AS id,
  event,
  attempts,
  available_at,
  delivered_at,
  last_error_code
`;

function mapOperation(row: OperationRow): StoredOperation {
  return {
    operationId: operationId(row.id),
    requestId: requestId(row.request_id),
    principalId: principalId(row.principal_id),
    operation: row.operation_type,
    state: row.state,
    requestFingerprint: row.request_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.client_id === null ? {} : { clientId: row.client_id }),
    ...(row.semantic_metadata === null
      ? {}
      : { semanticMetadata: row.semantic_metadata }),
    ...(row.mutation_payload === null
      ? {}
      : { mutationPayload: row.mutation_payload }),
    ...(row.target_brain_record_id === null
      ? {}
      : { targetBrainRecordId: brainRecordId(row.target_brain_record_id) }),
    ...(row.provider === null ? {} : { provider: row.provider }),
    ...(row.provider_record_id === null
      ? {}
      : { providerRecordId: providerRecordId(row.provider_record_id) }),
    ...(row.provider_version === null
      ? {}
      : { providerVersion: row.provider_version }),
    ...(row.result_metadata === null
      ? {}
      : { resultMetadata: row.result_metadata }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.policy_version === null
      ? {}
      : { policyVersion: row.policy_version }),
  };
}

function mapApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: approvalRequestId(row.id),
    operationId: operationId(row.operation_id),
    requestedByPrincipalId: principalId(row.requested_by_principal_id),
    status: row.status,
    projectionSyncStatus: row.projection_sync_status,
    summary: row.safe_summary,
    createdAt: row.created_at,
    ...(row.family_inbox_record_id === null
      ? {}
      : {
          familyInboxRecordId: providerRecordId(row.family_inbox_record_id),
        }),
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    ...(row.resolved_by_principal_id === null
      ? {}
      : {
          resolvedByPrincipalId: principalId(row.resolved_by_principal_id),
        }),
    ...(row.resolution_reason === null
      ? {}
      : { resolutionReason: row.resolution_reason }),
  };
}

function mapElevation(row: ElevationRow): StoredElevationChallenge {
  return {
    id: elevationChallengeId(row.id),
    operationId: operationId(row.operation_id),
    principalId: principalId(row.principal_id),
    confirmationTokenHash: row.confirmation_token_hash,
    requestFingerprint: row.request_fingerprint,
    policyVersion: row.policy_version,
    frozenTargetIds: row.frozen_target_ids.map((id) => brainRecordId(id)),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
    ...(row.superseded_at === null ? {} : { supersededAt: row.superseded_at }),
  };
}

function mapAlias(row: AliasRow): BrainRecordAlias {
  return {
    brainRecordId: brainRecordId(row.brain_record_id),
    provider: row.provider,
    providerRecordId: providerRecordId(row.provider_record_id),
    canonicalLocation: row.canonical_location,
    ...(row.creator_principal_id === null
      ? {}
      : { creatorPrincipalId: principalId(row.creator_principal_id) }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapGovernance(row: GovernanceRow): GovernanceVersionRecord {
  return {
    kind: row.kind,
    version: row.version,
    contentHash: row.content_hash,
    sourceReference: row.source_reference,
    canonicalMarker: row.canonical_marker,
    activatedAt: row.activated_at,
  };
}

function mapReconciliation(row: ReconciliationRow): ReconciliationAttempt {
  return {
    operationId: operationId(row.operation_id),
    attempt: row.attempt,
    outcome: row.outcome,
    attemptedAt: row.attempted_at,
    ...(row.safe_metadata === null ? {} : { safeMetadata: row.safe_metadata }),
  };
}

function mapAuditOutbox(row: AuditOutboxRow): AuditOutboxRecord {
  return {
    id: row.id,
    event: deserializeAuditEvent(row.event),
    attempts: row.attempts,
    availableAt: row.available_at,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    ...(row.last_error_code === null
      ? {}
      : { lastErrorCode: row.last_error_code }),
  };
}

function deserializeAuditEvent(event: SerializedAuditEvent): AuditEvent {
  return {
    eventType: event.eventType,
    requestId: requestId(event.requestId),
    principalId: principalId(event.principalId),
    operation: event.operation,
    outcome: event.outcome,
    timestamp: new Date(event.timestamp),
    ...(event.clientId === undefined ? {} : { clientId: event.clientId }),
    ...(event.operationId === undefined
      ? {}
      : { operationId: operationId(event.operationId) }),
    ...(event.provider === undefined ? {} : { provider: event.provider }),
    ...(event.brainRecordId === undefined
      ? {}
      : { brainRecordId: brainRecordId(event.brainRecordId) }),
    ...(event.providerRecordId === undefined
      ? {}
      : { providerRecordId: providerRecordId(event.providerRecordId) }),
    ...(event.approvalRequestId === undefined
      ? {}
      : { approvalRequestId: approvalRequestId(event.approvalRequestId) }),
    ...(event.policyVersion === undefined
      ? {}
      : { policyVersion: event.policyVersion }),
    ...(event.providerVersion === undefined
      ? {}
      : { providerVersion: event.providerVersion }),
    ...(event.integrityHash === undefined
      ? {}
      : { integrityHash: event.integrityHash }),
    ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
  };
}

function resolutionStatus(
  resolution: ApprovalResolution,
): ApprovalRequest['status'] {
  switch (resolution) {
    case 'approve':
      return 'approved';
    case 'decline':
      return 'declined';
    case 'cancel':
      return 'cancelled';
  }
}

/**
 * A replayed request matches by its immutable identity only. The projection
 * reference, sync status, status and resolution change after creation, so a
 * legitimate retry (which never carries them) must still replay.
 */
function sameApproval(
  existing: ApprovalRequest,
  requested: ApprovalRequest,
): boolean {
  return (
    existing.id === requested.id &&
    existing.operationId === requested.operationId &&
    existing.requestedByPrincipalId === requested.requestedByPrincipalId &&
    existing.summary.requestedByDisplayName ===
      requested.summary.requestedByDisplayName &&
    existing.summary.action === requested.summary.action &&
    existing.summary.safeTargetDescription ===
      requested.summary.safeTargetDescription &&
    existing.createdAt.getTime() === requested.createdAt.getTime()
  );
}

function sameElevation(
  existing: StoredElevationChallenge,
  requested: StoredElevationChallenge,
): boolean {
  return (
    existing.id === requested.id &&
    existing.operationId === requested.operationId &&
    existing.principalId === requested.principalId &&
    existing.confirmationTokenHash === requested.confirmationTokenHash &&
    existing.requestFingerprint === requested.requestFingerprint &&
    existing.policyVersion === requested.policyVersion &&
    existing.frozenTargetIds.length === requested.frozenTargetIds.length &&
    existing.frozenTargetIds.every(
      (target, index) => target === requested.frozenTargetIds[index],
    ) &&
    existing.createdAt.getTime() === requested.createdAt.getTime() &&
    existing.expiresAt.getTime() === requested.expiresAt.getTime() &&
    existing.consumedAt?.getTime() === requested.consumedAt?.getTime()
  );
}

function requireSingleRow<Row extends QueryResultRow>(
  rows: readonly Row[],
  notFoundDetails: Readonly<Record<string, string>>,
): Row {
  const row = rows[0];
  if (row === undefined) {
    throw new DomainError('not_found', false, notFoundDetails);
  }
  return row;
}

function operationTransitionQuery(
  request: OperationTransition,
  audited = false,
) {
  const metadata = audited ? parseAuditedTransition(request) : request;
  if (metadata.expectedStates.length === 0) {
    throw new DomainError('invalid_request', false, {
      reason: 'expected_states_required',
    });
  }
  if (audited && metadata.expectedStates.includes(metadata.nextState)) {
    throw new DomainError('invalid_request', false, {
      reason: 'audit_transition_must_change_state',
    });
  }
  return {
    text: `UPDATE operations
       SET
         state = $3,
         provider = COALESCE($4, provider),
         provider_record_id = COALESCE($5, provider_record_id),
         provider_version = COALESCE($6, provider_version),
         result_metadata = COALESCE($7::jsonb, result_metadata),
         error_code = COALESCE($8, error_code),
         policy_version = COALESCE($9, policy_version),
         mutation_payload = CASE
           WHEN $3 IN ('COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED') THEN NULL
           ELSE COALESCE($11::jsonb, mutation_payload)
         END,
         updated_at = $10
       WHERE id = $1 AND state = ANY($2::text[])
         AND (
           $11::jsonb IS NULL
           OR (
             $3 = 'AUTHORIZATION_REQUIRED'
             AND operation_type = 'append_to_record'
             AND mutation_payload IS NULL
           )
         )
       RETURNING ${operationColumns}`,
    // Capture values before awaiting a connection. A caller cannot change the
    // target, expected states, result or timestamp while the transaction waits.
    values: [
      metadata.operationId,
      [...metadata.expectedStates],
      metadata.nextState,
      metadata.provider ?? null,
      metadata.providerRecordId ?? null,
      metadata.providerVersion ?? null,
      request.resultMetadata === undefined
        ? null
        : JSON.stringify(request.resultMetadata),
      metadata.errorCode ?? null,
      metadata.policyVersion ?? null,
      typeof metadata.transitionedAt === 'string'
        ? metadata.transitionedAt
        : Date.prototype.toISOString.call(metadata.transitionedAt),
      request.mutationPayload === undefined
        ? null
        : JSON.stringify(request.mutationPayload),
    ],
  };
}

function elevationConsumptionQuery(request: ConsumeElevationChallenge) {
  return {
    text: `UPDATE elevation_challenges
       SET consumed_at = $8
       WHERE id = $1
         AND operation_id = $2
         AND principal_id = $3
         AND confirmation_token_hash = $4
         AND request_fingerprint = $5
         AND policy_version = $6
         AND frozen_target_ids = $7::jsonb
         AND consumed_at IS NULL
         AND superseded_at IS NULL
         AND $8 >= created_at
         AND $8 <= expires_at
       RETURNING ${elevationColumns}`,
    values: [
      request.challengeId,
      request.operationId,
      request.principalId,
      request.confirmationTokenHash,
      request.requestFingerprint,
      request.policyVersion,
      JSON.stringify(request.frozenTargetIds),
      request.consumedAt,
    ],
  };
}

function isConstraintViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' && code.startsWith('23');
}

function invalidElevationChallenge(): DomainError {
  return new DomainError('elevation_required', false, {
    reason: 'challenge_invalid_expired_or_consumed',
  });
}

function operationTransitionEvent(
  operation: StoredOperation,
  audit: {
    readonly eventType: string;
    readonly reasonCode: string | undefined;
    readonly integrityHash: string | undefined;
  },
  approvalRequestIdValue?: string,
) {
  return serializeAuditEvent({
    eventType: audit.eventType,
    reasonCode: audit.reasonCode,
    integrityHash: audit.integrityHash,
    requestId: operation.requestId,
    principalId: operation.principalId,
    clientId: operation.clientId,
    operationId: operation.operationId,
    operation: operation.operation,
    provider: operation.provider,
    brainRecordId: operation.targetBrainRecordId,
    providerRecordId: operation.providerRecordId,
    providerVersion: operation.providerVersion,
    ...(approvalRequestIdValue === undefined
      ? {}
      : { approvalRequestId: approvalRequestIdValue }),
    policyVersion: operation.policyVersion,
    outcome: operation.state,
    timestamp: operation.updatedAt,
  });
}

function transitionedOperation(rows: readonly OperationRow[]): StoredOperation {
  const row = rows[0];
  if (row === undefined) {
    throw new DomainError('invalid_request', false, {
      reason: 'invalid_state_transition',
    });
  }
  return mapOperation(row);
}

/** PostgreSQL operational machinery only; never stores provider content as a Brain mirror. */
/**
 * `jsonb` rejects NUL (22P05) and lone surrogates (22P02). The services refuse
 * such text first; this keeps any other caller's failure a safe client error.
 */
function unstorableText(error: unknown): DomainError | undefined {
  const code =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return code === '22P05' || code === '22P02'
    ? new DomainError('invalid_request', false, {
        reason: 'unstorable_operation_text',
      })
    : undefined;
}

export class PostgresOperationalStateStore implements OperationalStateStore {
  constructor(private readonly pool: Pool) {}

  async findPrincipalByExternalIdentity(
    lookup: Parameters<
      OperationalStateStore['findPrincipalByExternalIdentity']
    >[0],
  ): Promise<PrincipalIdentityBinding | null> {
    const result = await this.pool.query<PrincipalBindingRow>(
      `SELECT
         p.id AS principal_id,
         p.principal_key,
         p.display_name,
         p.role,
         p.status,
         b.issuer,
         b.external_subject,
         b.email,
         b.enabled
       FROM identity_bindings b
       JOIN principals p ON p.id = b.principal_id
       WHERE b.issuer = $1 AND b.external_subject = $2`,
      [lookup.issuer, lookup.externalSubject],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      principal: {
        id: principalId(row.principal_id),
        key: row.principal_key,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
      },
      issuer: row.issuer,
      externalSubject: row.external_subject,
      email: row.email,
      enabled: row.enabled,
    };
  }

  async getPrincipalById(
    principalIdValue: Parameters<OperationalStateStore['getPrincipalById']>[0],
  ): Promise<BrainPrincipal | null> {
    const result = await this.pool.query<PrincipalRow>(
      `SELECT id, principal_key, display_name, role, status
       FROM principals
       WHERE id = $1`,
      [principalIdValue],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          id: principalId(row.id),
          key: row.principal_key,
          displayName: row.display_name,
          role: row.role,
          status: row.status,
        };
  }

  async openOperation(
    request: CreateOperationRecord,
  ): Promise<OpenOperationResult> {
    const inserted = await this.pool
      .query<OperationRow>(
        `INSERT INTO operations (
         id,
         request_id,
         principal_id,
         client_id,
         operation_type,
         state,
         request_fingerprint,
         semantic_metadata,
         mutation_payload,
         target_brain_record_id,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'RECEIVED', $6, $7::jsonb, $8::jsonb, $9, $10, $10
       )
       ON CONFLICT DO NOTHING
       RETURNING ${operationColumns}`,
        [
          request.operationId,
          request.requestId,
          request.principalId,
          request.clientId ?? null,
          request.operation,
          request.requestFingerprint,
          request.semanticMetadata === undefined
            ? null
            : JSON.stringify(request.semanticMetadata),
          request.mutationPayload === undefined
            ? null
            : JSON.stringify(request.mutationPayload),
          request.targetBrainRecordId ?? null,
          request.createdAt,
        ],
      )
      .catch((error: unknown) => {
        throw unstorableText(error) ?? error;
      });

    const created = inserted.rows[0];
    if (created !== undefined) {
      return { disposition: 'created', operation: mapOperation(created) };
    }

    const replay = await this.pool.query<OperationRow>(
      `SELECT ${operationColumns}
       FROM operations
       WHERE principal_id = $1 AND operation_type = $2 AND request_id = $3`,
      [request.principalId, request.operation, request.requestId],
    );
    const existing = replay.rows[0];
    if (
      existing === undefined ||
      existing.request_fingerprint !== request.requestFingerprint
    ) {
      throw new DomainError('idempotency_conflict', false, {
        operation: request.operation,
        reason: 'request_key_or_fingerprint_conflict',
      });
    }

    return { disposition: 'existing', operation: mapOperation(existing) };
  }

  async getOperation(
    operationIdValue: Parameters<OperationalStateStore['getOperation']>[0],
  ): Promise<StoredOperation | null> {
    const result = await this.pool.query<OperationRow>(
      `SELECT ${operationColumns} FROM operations WHERE id = $1`,
      [operationIdValue],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapOperation(row);
  }

  async transitionOperation(
    request: OperationTransition,
  ): Promise<StoredOperation> {
    const result = await this.pool.query<OperationRow>(
      operationTransitionQuery(request),
    );
    return transitionedOperation(result.rows);
  }

  async transitionOperationWithAudit(
    request: OperationTransition,
    audit: OperationTransitionAudit,
  ): Promise<StoredOperation> {
    let client: PoolClient | undefined;
    let discardClient = false;
    try {
      const query = operationTransitionQuery(request, true);
      const details = {
        eventType: audit.eventType,
        reasonCode: audit.reasonCode,
        integrityHash: audit.integrityHash,
      };
      client = await this.pool.connect();
      await client.query('BEGIN');
      const result = await client.query<OperationRow>(query);
      const operation = transitionedOperation(result.rows);
      const approvalResult =
        operation.state === 'APPROVAL_PENDING'
          ? await client.query<{ readonly id: string }>(
              'SELECT id FROM approval_requests WHERE operation_id = $1',
              [operation.operationId],
            )
          : undefined;
      const event = operationTransitionEvent(
        operation,
        details,
        approvalResult?.rows[0]?.id,
      );
      await client.query(
        'INSERT INTO audit_outbox (event) VALUES ($1::jsonb)',
        [JSON.stringify(event)],
      );
      await client.query('COMMIT');
      return operation;
    } catch (error) {
      if (client !== undefined) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // A connection with unknown transaction state must never reenter the pool.
          discardClient = true;
        }
      }
      if (error instanceof DomainError) throw error;
      // COMMIT acknowledgement can be lost. Do not infer rollback or retry here;
      // callers must inspect durable state before retrying any operation.
      throw new DomainError('provider_unavailable', true, {
        reason: 'operation_audit_state_unavailable',
      });
    } finally {
      client?.release(discardClient);
    }
  }

  async createApproval(request: ApprovalRequest): Promise<ApprovalRequest> {
    const result = await this.pool.query<ApprovalRow>(
      `INSERT INTO approval_requests (
         id,
         operation_id,
         family_inbox_record_id,
         requested_by_principal_id,
         status,
         projection_sync_status,
         safe_summary,
         resolved_by_principal_id,
         resolution_reason,
         created_at,
         resolved_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $10)
       ON CONFLICT DO NOTHING
       RETURNING ${approvalColumns}`,
      [
        request.id,
        request.operationId,
        request.familyInboxRecordId ?? null,
        request.requestedByPrincipalId,
        request.status,
        request.projectionSyncStatus,
        JSON.stringify(request.summary),
        request.resolvedByPrincipalId ?? null,
        request.resolutionReason ?? null,
        request.createdAt,
        request.resolvedAt ?? null,
      ],
    );
    const inserted = result.rows[0];
    if (inserted !== undefined) {
      return mapApproval(inserted);
    }

    const replay = await this.pool.query<ApprovalRow>(
      `SELECT ${approvalColumns}
       FROM approval_requests
       WHERE id = $1 OR operation_id = $2
       ORDER BY (id = $1) DESC
       LIMIT 1`,
      [request.id, request.operationId],
    );
    const existingRow = replay.rows[0];
    if (existingRow !== undefined) {
      const existing = mapApproval(existingRow);
      if (sameApproval(existing, request)) {
        return existing;
      }
    }
    throw new DomainError('idempotency_conflict', false, {
      reason: 'approval_identity_conflict',
    });
  }

  async getApproval(
    approvalRequestIdValue: Parameters<OperationalStateStore['getApproval']>[0],
  ): Promise<ApprovalRequest | null> {
    const result = await this.pool.query<ApprovalRow>(
      `SELECT ${approvalColumns} FROM approval_requests WHERE id = $1`,
      [approvalRequestIdValue],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapApproval(row);
  }

  async listPendingApprovals(): Promise<readonly ApprovalRequest[]> {
    const result = await this.pool.query<ApprovalRow>(
      `SELECT ${approvalColumns}
       FROM approval_requests
       WHERE status = 'pending'
       ORDER BY created_at, id`,
    );
    return result.rows.map(mapApproval);
  }

  async listApprovalsRequiringProjectionSync(): Promise<
    readonly ApprovalRequest[]
  > {
    const result = await this.pool.query<ApprovalRow>(
      `SELECT ${approvalColumns}
       FROM approval_requests
       WHERE projection_sync_status = 'pending'
       ORDER BY updated_at, id`,
    );
    return result.rows.map(mapApproval);
  }

  async setApprovalProjectionReference(
    request: SetApprovalProjectionReference,
  ): Promise<ApprovalRequest> {
    const result = await this.pool.query<ApprovalRow>(
      `UPDATE approval_requests
       SET family_inbox_record_id = $2,
           projection_sync_status = CASE
             WHEN status = 'pending' THEN 'synced'
             ELSE 'pending'
           END,
           updated_at = now()
       WHERE id = $1
         AND (family_inbox_record_id IS NULL OR family_inbox_record_id = $2)
       RETURNING ${approvalColumns}`,
      [request.approvalRequestId, request.familyInboxRecordId],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      return mapApproval(row);
    }

    const existing = await this.getApproval(request.approvalRequestId);
    if (existing === null) {
      throw new DomainError('not_found', false, {
        resource: 'approval_request',
      });
    }
    throw new DomainError('idempotency_conflict', false, {
      reason: 'approval_projection_conflict',
    });
  }

  async markApprovalProjectionSynced(
    request: MarkApprovalProjectionSynced,
  ): Promise<ApprovalRequest> {
    const result = await this.pool.query<ApprovalRow>(
      `UPDATE approval_requests
       SET projection_sync_status = 'synced', updated_at = now()
       WHERE id = $1 AND status = $2
       RETURNING ${approvalColumns}`,
      [request.approvalRequestId, request.expectedStatus],
    );
    const row = result.rows[0];
    if (row !== undefined) return mapApproval(row);
    const existing = await this.getApproval(request.approvalRequestId);
    if (existing === null) {
      throw new DomainError('not_found', false, {
        resource: 'approval_request',
      });
    }
    throw new DomainError('invalid_request', false, {
      reason: 'approval_projection_state_changed',
    });
  }

  async resolveApproval(
    request: ResolveStoredApproval,
  ): Promise<ApprovalRequest> {
    const result = await this.pool.query<ApprovalRow>(
      `UPDATE approval_requests
       SET
         status = $2,
         resolved_by_principal_id = $3,
         resolution_reason = $4,
         resolved_at = $5,
         projection_sync_status = 'pending',
         updated_at = $5
       WHERE id = $1 AND status = 'pending'
       RETURNING ${approvalColumns}`,
      [
        request.approvalRequestId,
        resolutionStatus(request.resolution),
        request.resolvedByPrincipalId,
        request.reason ?? null,
        request.resolvedAt,
      ],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      return mapApproval(row);
    }

    const existing = await this.getApproval(request.approvalRequestId);
    if (existing === null) {
      throw new DomainError('not_found', false, {
        resource: 'approval_request',
      });
    }
    throw new DomainError('invalid_request', false, {
      reason: 'approval_not_pending',
    });
  }

  async resolveApprovalWithOperation(
    request: ApprovalResolutionTransaction,
  ): Promise<ApprovalResolutionTransactionResult> {
    if (
      request.audit.principalId !== request.resolvedByPrincipalId ||
      request.audit.operation !== 'resolve_approval'
    ) {
      throw new DomainError('invalid_request', false, {
        reason: 'approval_resolution_audit_mismatch',
      });
    }
    let client: PoolClient | undefined;
    let discardClient = false;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const approvalResult = await client.query<ApprovalRow>(
        `UPDATE approval_requests
         SET status = $2,
             resolved_by_principal_id = $3,
             resolution_reason = $4,
             resolved_at = $5,
             projection_sync_status = 'pending',
             updated_at = $5
         WHERE id = $1 AND status = 'pending'
         RETURNING ${approvalColumns}`,
        [
          request.approvalRequestId,
          request.status,
          request.resolvedByPrincipalId,
          request.reason ?? null,
          request.resolvedAt,
        ],
      );
      const approvalRow = approvalResult.rows[0];
      if (approvalRow === undefined) {
        await client.query('ROLLBACK');
        const existing = await this.getApproval(request.approvalRequestId);
        if (existing === null) {
          throw new DomainError('not_found', false, {
            resource: 'approval_request',
          });
        }
        const operation = await this.getOperation(existing.operationId);
        if (
          operation !== null &&
          existing.status === request.status &&
          existing.resolvedByPrincipalId === request.resolvedByPrincipalId &&
          existing.resolutionReason === request.reason
        ) {
          return { disposition: 'existing', approval: existing, operation };
        }
        throw new DomainError('invalid_request', false, {
          reason: 'approval_not_pending',
        });
      }
      if (
        approvalRow.operation_id !== request.operationTransition.operationId
      ) {
        throw new DomainError('invalid_request', false, {
          reason: 'approval_operation_mismatch',
        });
      }

      const operationResult = await client.query<OperationRow>(
        operationTransitionQuery(request.operationTransition),
      );
      const operation = transitionedOperation(operationResult.rows);
      const approval = mapApproval(approvalRow);
      const event = serializeAuditEvent({
        eventType: request.audit.eventType,
        requestId: request.audit.requestId,
        principalId: request.audit.principalId,
        ...(request.audit.clientId === undefined
          ? {}
          : { clientId: request.audit.clientId }),
        operationId: operation.operationId,
        operation: request.audit.operation,
        provider: operation.provider,
        brainRecordId: operation.targetBrainRecordId,
        providerRecordId: operation.providerRecordId,
        approvalRequestId: approval.id,
        providerVersion: operation.providerVersion,
        policyVersion: operation.policyVersion,
        outcome: operation.state,
        reasonCode: request.audit.reasonCode,
        timestamp: operation.updatedAt,
      });
      await client.query(
        'INSERT INTO audit_outbox (event) VALUES ($1::jsonb)',
        [JSON.stringify(event)],
      );
      await client.query('COMMIT');
      return { disposition: 'resolved', approval, operation };
    } catch (error) {
      if (client !== undefined) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discardClient = true;
        }
      }
      if (error instanceof DomainError) throw error;
      throw new DomainError('provider_unavailable', true, {
        reason: 'approval_resolution_state_unavailable',
      });
    } finally {
      client?.release(discardClient);
    }
  }

  async createElevationChallenge(
    challenge: StoredElevationChallenge,
  ): Promise<StoredElevationChallenge> {
    const values = [
      challenge.id,
      challenge.operationId,
      challenge.principalId,
      challenge.confirmationTokenHash,
      challenge.requestFingerprint,
      challenge.policyVersion,
      JSON.stringify(challenge.frozenTargetIds),
      challenge.createdAt,
      challenge.expiresAt,
      challenge.consumedAt ?? null,
    ];
    let client: PoolClient | undefined;
    let discardClient = false;
    let inserted: ElevationRow | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      // Issuance and confirmation lock the operation first, so a confirmation
      // can never interleave with the supersession of the challenge it holds.
      const locked = await client.query<{
        readonly principal_id: string;
        readonly state: string;
      }>(
        'SELECT principal_id, state FROM operations WHERE id = $1 FOR UPDATE',
        [challenge.operationId],
      );
      const lockedRow = locked.rows[0];
      if (
        lockedRow?.principal_id !== challenge.principalId ||
        lockedRow.state !== 'ELEVATION_PENDING'
      ) {
        throw new DomainError('elevation_required', false, {
          reason: 'elevation_operation_mismatch',
        });
      }
      await client.query(
        `UPDATE elevation_challenges
         SET superseded_at = $3
         WHERE operation_id = $1
           AND id <> $2
           AND consumed_at IS NULL
           AND superseded_at IS NULL`,
        [challenge.operationId, challenge.id, challenge.createdAt],
      );
      const result = await client.query<ElevationRow>(
        `INSERT INTO elevation_challenges (
           id,
           operation_id,
           principal_id,
           confirmation_token_hash,
           request_fingerprint,
           policy_version,
           frozen_target_ids,
           created_at,
           expires_at,
           consumed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
         ON CONFLICT DO NOTHING
         RETURNING ${elevationColumns}`,
        values,
      );
      inserted = result.rows[0];
      // A replayed or conflicting insert must not supersede anything.
      await client.query(inserted === undefined ? 'ROLLBACK' : 'COMMIT');
    } catch (error) {
      if (client !== undefined) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discardClient = true;
        }
      }
      if (error instanceof DomainError) throw error;
      if (isConstraintViolation(error)) {
        throw new DomainError('invalid_request', false, {
          reason: 'elevation_challenge_rejected',
        });
      }
      throw new DomainError('provider_unavailable', true, {
        reason: 'elevation_state_unavailable',
      });
    } finally {
      client?.release(discardClient);
    }
    if (inserted !== undefined) {
      return mapElevation(inserted);
    }

    const replay = await this.pool.query<ElevationRow>(
      `SELECT ${elevationColumns} FROM elevation_challenges WHERE id = $1`,
      [challenge.id],
    );
    const existingRow = replay.rows[0];
    if (existingRow !== undefined) {
      const existing = mapElevation(existingRow);
      if (sameElevation(existing, challenge)) {
        return existing;
      }
    }
    throw new DomainError('idempotency_conflict', false, {
      reason: 'elevation_challenge_conflict',
    });
  }

  async consumeElevationChallenge(
    request: ConsumeElevationChallenge,
  ): Promise<StoredElevationChallenge> {
    const result = await this.pool.query<ElevationRow>(
      elevationConsumptionQuery(request),
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw invalidElevationChallenge();
    }
    return mapElevation(row);
  }

  async confirmElevationWithOperation(
    request: ElevationConfirmationTransaction,
  ): Promise<ElevationConfirmationTransactionResult> {
    const { consume, operationTransition } = request;
    if (
      operationTransition.operationId !== consume.operationId ||
      operationTransition.nextState !== 'EXECUTING' ||
      operationTransition.expectedStates.length !== 1 ||
      operationTransition.expectedStates[0] !== 'ELEVATION_PENDING' ||
      operationTransition.policyVersion !== consume.policyVersion
    ) {
      throw new DomainError('invalid_request', false, {
        reason: 'elevation_confirmation_transition_invalid',
      });
    }
    // Capture every value before awaiting a connection.
    const consumption = elevationConsumptionQuery(consume);
    const transition = operationTransitionQuery(operationTransition, true);
    const audit = {
      eventType: request.audit.eventType,
      reasonCode: request.audit.reasonCode,
      integrityHash: request.audit.integrityHash,
    };
    const operationIdValue = consume.operationId;
    const principalIdValue = consume.principalId;
    let client: PoolClient | undefined;
    let discardClient = false;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const locked = await client.query<{
        readonly principal_id: string;
        readonly state: string;
      }>(
        'SELECT principal_id, state FROM operations WHERE id = $1 FOR UPDATE',
        [operationIdValue],
      );
      const lockedRow = locked.rows[0];
      if (
        lockedRow?.principal_id !== principalIdValue ||
        lockedRow.state !== 'ELEVATION_PENDING'
      ) {
        throw new DomainError('elevation_required', false, {
          reason: 'elevation_operation_mismatch',
        });
      }
      const consumed = await client.query<ElevationRow>(consumption);
      const challengeRow = consumed.rows[0];
      if (challengeRow === undefined) {
        throw invalidElevationChallenge();
      }
      const transitioned = await client.query<OperationRow>(transition);
      const operation = transitionedOperation(transitioned.rows);
      await client.query(
        'INSERT INTO audit_outbox (event) VALUES ($1::jsonb)',
        [JSON.stringify(operationTransitionEvent(operation, audit))],
      );
      await client.query('COMMIT');
      return { challenge: mapElevation(challengeRow), operation };
    } catch (error) {
      if (client !== undefined) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discardClient = true;
        }
      }
      if (error instanceof DomainError) throw error;
      // COMMIT acknowledgement can be lost; callers reload and never dispatch.
      throw new DomainError('provider_unavailable', true, {
        reason: 'elevation_confirmation_state_unavailable',
      });
    } finally {
      client?.release(discardClient);
    }
  }

  async findConsumedElevationChallenge(
    operationIdValue: Parameters<
      OperationalStateStore['findConsumedElevationChallenge']
    >[0],
  ): Promise<StoredElevationChallenge | null> {
    const result = await this.pool.query<ElevationRow>(
      `SELECT ${elevationColumns}
       FROM elevation_challenges
       WHERE operation_id = $1 AND consumed_at IS NOT NULL
       ORDER BY consumed_at DESC, id DESC
       LIMIT 1`,
      [operationIdValue],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapElevation(row);
  }

  async ensureBrainRecordAlias(
    alias: BrainRecordAlias,
  ): Promise<BrainRecordAlias> {
    const result = await this.pool.query<AliasRow>(
      `INSERT INTO brain_record_aliases (
         brain_record_id,
         provider,
         provider_record_id,
         canonical_location,
         creator_principal_id,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING ${aliasColumns}`,
      [
        alias.brainRecordId,
        alias.provider,
        alias.providerRecordId,
        JSON.stringify(alias.canonicalLocation),
        alias.creatorPrincipalId ?? null,
        alias.createdAt,
        alias.updatedAt,
      ],
    );
    const inserted = result.rows[0];
    if (inserted !== undefined) {
      return mapAlias(inserted);
    }

    if (alias.creatorPrincipalId !== undefined) {
      // A concurrent retrieval may have registered the record first.
      await this.pool.query(
        `UPDATE brain_record_aliases
         SET creator_principal_id = $3
         WHERE provider = $1
           AND provider_record_id = $2
           AND creator_principal_id IS NULL`,
        [alias.provider, alias.providerRecordId, alias.creatorPrincipalId],
      );
    }

    const providerAlias = await this.findBrainRecordAliasByProvider(
      alias.provider,
      alias.providerRecordId,
    );
    if (providerAlias !== null) {
      return providerAlias;
    }

    throw new DomainError('idempotency_conflict', false, {
      reason: 'brain_record_alias_conflict',
    });
  }

  async findBrainRecordAlias(
    brainRecordIdValue: Parameters<
      OperationalStateStore['findBrainRecordAlias']
    >[0],
  ): Promise<BrainRecordAlias | null> {
    const result = await this.pool.query<AliasRow>(
      `SELECT ${aliasColumns}
       FROM brain_record_aliases
       WHERE brain_record_id = $1`,
      [brainRecordIdValue],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAlias(row);
  }

  async findBrainRecordAliasByProvider(
    provider: KnowledgeProviderName,
    providerRecordIdValue: Parameters<
      OperationalStateStore['findBrainRecordAliasByProvider']
    >[1],
  ): Promise<BrainRecordAlias | null> {
    const result = await this.pool.query<AliasRow>(
      `SELECT ${aliasColumns}
       FROM brain_record_aliases
       WHERE provider = $1 AND provider_record_id = $2`,
      [provider, providerRecordIdValue],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAlias(row);
  }

  async recordGovernanceVersion(
    version: GovernanceVersionRecord,
  ): Promise<void> {
    if (version.kind === 'project_registry') {
      const result = await this.pool.query(
        `INSERT INTO project_registry_versions (
           version, content_hash, source_reference, canonical_marker, activated_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [
          version.version,
          version.contentHash,
          version.sourceReference,
          version.canonicalMarker,
          version.activatedAt,
        ],
      );
      if (result.rowCount === 1) {
        return;
      }
      const match = await this.pool.query<MatchRow>(
        `SELECT (
           content_hash = $2
           AND source_reference = $3
           AND canonical_marker = $4
         ) AS matches
         FROM project_registry_versions
         WHERE version = $1`,
        [
          version.version,
          version.contentHash,
          version.sourceReference,
          version.canonicalMarker,
        ],
      );
      if (match.rows[0]?.matches === true) {
        return;
      }
    } else {
      const result = await this.pool.query(
        `INSERT INTO policy_versions (
           kind,
           version,
           content_hash,
           source_reference,
           canonical_marker,
           activated_at
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [
          version.kind,
          version.version,
          version.contentHash,
          version.sourceReference,
          version.canonicalMarker,
          version.activatedAt,
        ],
      );
      if (result.rowCount === 1) {
        return;
      }
      const match = await this.pool.query<MatchRow>(
        `SELECT (
           content_hash = $3
           AND source_reference = $4
           AND canonical_marker = $5
         ) AS matches
         FROM policy_versions
         WHERE kind = $1 AND version = $2`,
        [
          version.kind,
          version.version,
          version.contentHash,
          version.sourceReference,
          version.canonicalMarker,
        ],
      );
      if (match.rows[0]?.matches === true) {
        return;
      }
    }

    throw new DomainError('policy_drift', false, {
      artifact: version.kind,
      version: version.version,
    });
  }

  async getActiveGovernanceVersion(
    kind: GovernanceArtifactKind,
  ): Promise<GovernanceVersionRecord | null> {
    if (kind === 'project_registry') {
      const result = await this.pool.query<GovernanceRow>(
        `SELECT
           'project_registry'::text AS kind,
           version,
           content_hash,
           source_reference,
           canonical_marker,
           activated_at
         FROM project_registry_versions
         ORDER BY activated_at DESC, version DESC
         LIMIT 1`,
      );
      const row = result.rows[0];
      return row === undefined ? null : mapGovernance(row);
    }

    const result = await this.pool.query<GovernanceRow>(
      `SELECT
         kind,
         version,
         content_hash,
         source_reference,
         canonical_marker,
         activated_at
       FROM policy_versions
       WHERE kind = $1
       ORDER BY activated_at DESC, version DESC
       LIMIT 1`,
      [kind],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapGovernance(row);
  }

  async recordReconciliationAttempt(
    attempt: ReconciliationAttempt,
  ): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO reconciliation_attempts (
         operation_id, attempt, outcome, safe_metadata, attempted_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT DO NOTHING`,
      [
        attempt.operationId,
        attempt.attempt,
        attempt.outcome,
        attempt.safeMetadata === undefined
          ? null
          : JSON.stringify(attempt.safeMetadata),
        attempt.attemptedAt,
      ],
    );
    if (result.rowCount === 1) {
      return;
    }

    const match = await this.pool.query<MatchRow>(
      `SELECT (
         outcome = $3
         AND safe_metadata IS NOT DISTINCT FROM $4::jsonb
         AND attempted_at = $5
       ) AS matches
       FROM reconciliation_attempts
       WHERE operation_id = $1 AND attempt = $2`,
      [
        attempt.operationId,
        attempt.attempt,
        attempt.outcome,
        attempt.safeMetadata === undefined
          ? null
          : JSON.stringify(attempt.safeMetadata),
        attempt.attemptedAt,
      ],
    );
    if (match.rows[0]?.matches !== true) {
      throw new DomainError('idempotency_conflict', false, {
        reason: 'reconciliation_attempt_conflict',
      });
    }
  }

  async listReconciliationAttempts(
    operationIdValue: Parameters<
      OperationalStateStore['listReconciliationAttempts']
    >[0],
  ): Promise<readonly ReconciliationAttempt[]> {
    const result = await this.pool.query<ReconciliationRow>(
      `SELECT operation_id, attempt, outcome, safe_metadata, attempted_at
       FROM reconciliation_attempts
       WHERE operation_id = $1
       ORDER BY attempt`,
      [operationIdValue],
    );
    return result.rows.map(mapReconciliation);
  }

  async enqueueAuditEvent(event: AuditEvent): Promise<AuditOutboxRecord> {
    const result = await this.pool.query<AuditOutboxRow>(
      `INSERT INTO audit_outbox (event)
       VALUES ($1::jsonb)
       RETURNING ${auditOutboxColumns}`,
      [JSON.stringify(serializeAuditEvent(event))],
    );
    return mapAuditOutbox(
      requireSingleRow(result.rows, { resource: 'audit_outbox_event' }),
    );
  }

  async listPendingAuditEvents(
    limit: number,
  ): Promise<readonly AuditOutboxRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new DomainError('invalid_request', false, {
        reason: 'audit_outbox_limit_out_of_range',
      });
    }
    const result = await this.pool.query<AuditOutboxRow>(
      `SELECT ${auditOutboxColumns}
       FROM audit_outbox
       WHERE delivered_at IS NULL AND available_at <= now()
         AND (claim_expires_at IS NULL OR claim_expires_at <= clock_timestamp())
       ORDER BY available_at, id
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapAuditOutbox);
  }

  async claimAuditEvent(
    leaseMilliseconds: number,
  ): Promise<ClaimedAuditOutboxRecord | null> {
    validateAuditDuration(leaseMilliseconds, 300_000);
    try {
      const result = await this.pool.query<AuditClaimRow>(
        `WITH candidate AS (
           SELECT id FROM audit_outbox
           WHERE delivered_at IS NULL AND available_at <= clock_timestamp()
             AND (claim_expires_at IS NULL OR claim_expires_at <= clock_timestamp())
           ORDER BY available_at, id
           LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         UPDATE audit_outbox
         SET claim_token = gen_random_uuid(),
             claim_expires_at = clock_timestamp() + $1 * interval '1 millisecond',
             attempts = LEAST(attempts::bigint + 1, 2147483647)::integer
         WHERE id = (SELECT id FROM candidate)
         RETURNING ${auditOutboxColumns}, claim_token::text, claim_expires_at`,
        [leaseMilliseconds],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : {
            ...mapAuditOutbox(row),
            claimToken: row.claim_token,
            claimExpiresAt: row.claim_expires_at,
          };
    } catch {
      throw auditStateUnavailable();
    }
  }

  async markAuditEventDelivered(
    id: string,
    claimToken: string,
  ): Promise<boolean> {
    validateAuditClaim(id, claimToken);
    try {
      // Materialization prevents the expiry check from running before a lock wait.
      const result = await this.pool.query(
        `WITH locked AS MATERIALIZED (
           SELECT id, claim_token, claim_expires_at, delivered_at
           FROM audit_outbox WHERE id = $1 FOR UPDATE
         )
         UPDATE audit_outbox
         SET delivered_at = clock_timestamp(), last_error_code = NULL,
             claim_token = NULL, claim_expires_at = NULL
         FROM locked
         WHERE audit_outbox.id = locked.id AND locked.claim_token = $2::uuid
           AND locked.delivered_at IS NULL AND locked.claim_expires_at > clock_timestamp()`,
        [id, claimToken],
      );
      return result.rowCount === 1;
    } catch {
      throw auditStateUnavailable();
    }
  }

  async markAuditEventFailed(
    id: string,
    claimToken: string,
    safeErrorCode: AuditDeliveryErrorCode,
    retryDelayMilliseconds: number,
  ): Promise<boolean> {
    validateAuditClaim(id, claimToken);
    validateAuditDuration(retryDelayMilliseconds, 3_600_000);
    if (
      ![
        'audit_sink_unavailable',
        'audit_sink_timeout',
        'audit_delivery_cancelled',
      ].includes(safeErrorCode)
    ) {
      throw new DomainError('invalid_request', false, {
        reason: 'invalid_audit_delivery_code',
      });
    }
    try {
      const result = await this.pool.query(
        `WITH locked AS MATERIALIZED (
           SELECT id, claim_token, claim_expires_at, delivered_at
           FROM audit_outbox WHERE id = $1 FOR UPDATE
         )
         UPDATE audit_outbox
         SET available_at = clock_timestamp() + $4 * interval '1 millisecond',
             last_error_code = $3, claim_token = NULL, claim_expires_at = NULL
         FROM locked
         WHERE audit_outbox.id = locked.id AND locked.claim_token = $2::uuid
           AND locked.delivered_at IS NULL AND locked.claim_expires_at > clock_timestamp()`,
        [id, claimToken, safeErrorCode, retryDelayMilliseconds],
      );
      return result.rowCount === 1;
    } catch {
      throw auditStateUnavailable();
    }
  }
}

function validateAuditDuration(milliseconds: number, maximum: number): void {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > maximum
  ) {
    throw new DomainError('invalid_request', false, {
      reason: 'invalid_audit_duration',
    });
  }
}

function validateAuditClaim(id: string, token: string): void {
  if (
    !/^[1-9][0-9]{0,18}$/.test(id) ||
    BigInt(id) > 9223372036854775807n ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      token,
    )
  ) {
    throw new DomainError('invalid_request', false, {
      reason: 'invalid_audit_claim',
    });
  }
}

function auditStateUnavailable(): DomainError {
  return new DomainError('provider_unavailable', true, {
    reason: 'audit_state_unavailable',
  });
}
