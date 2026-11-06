import type {
  ListApprovalsResponse,
  ResolveApprovalRequest,
  ResolveApprovalResponse,
} from '../domain/approvals.js';
import { DomainError, type DomainErrorCode } from '../domain/errors.js';
import type {
  ApprovalRequestId,
  BrainRecordId,
  OperationId,
} from '../domain/identifiers.js';
import type {
  AppendRecordRequest,
  BrainOperationName,
  DeleteRecordRequest,
  FetchRecordRequest,
  FetchRecordResponse,
  MutationResponse,
  OperationState,
  PersistKnowledgeRequest,
  SearchBrainRequest,
  SearchBrainResponse,
  UpdateRecordRequest,
} from '../domain/operations.js';
import type { AuthenticatedPrincipal } from '../domain/principal.js';
import type { RequestContext } from '../domain/request-context.js';
import type { AuditEvent } from '../ports/audit-sink.js';
import type { Clock } from '../ports/clock.js';
import type { OperationalStateStore } from '../ports/operational-state-store.js';
import type { ApprovalService } from './approval-service.js';
import type { BrainQueryService } from './brain-query-service.js';
import type { MutationService } from './mutation-service.js';

export interface BrainOperationServices {
  readonly query: Pick<BrainQueryService, 'searchBrain' | 'fetchRecord'>;
  readonly mutations: Pick<
    MutationService,
    'persistKnowledge' | 'updateRecord' | 'appendToRecord' | 'deleteRecord'
  >;
  readonly approvals: Pick<
    ApprovalService,
    'listApprovals' | 'resolveApproval'
  >;
}

export type RequestAuditStore = Pick<
  OperationalStateStore,
  'enqueueAuditEvent'
>;

/** Metadata the boundary may record; never queries, titles, bodies or tokens. */
interface RequestFacts {
  readonly operationId?: OperationId;
  readonly brainRecordId?: BrainRecordId;
  readonly approvalRequestId?: ApprovalRequestId;
  readonly provider?: AuditEvent['provider'];
  readonly providerRecordId?: AuditEvent['providerRecordId'];
}

interface Settlement {
  readonly outcome: AuditEvent['outcome'];
  readonly reasonCode: string;
  readonly facts?: RequestFacts;
}

const deniedCodes = new Set<DomainErrorCode>([
  'unauthenticated',
  'unauthorized',
  'approval_required',
  'elevation_required',
  'protected_record',
]);
const safeReason = /^[a-z][a-z0-9_]{0,95}$/u;

const mutationOutcomes: Readonly<
  Record<MutationResponse['state'], OperationState>
> = {
  completed: 'COMPLETED',
  failed: 'FAILED',
  approval_required: 'APPROVAL_PENDING',
  elevation_required: 'ELEVATION_PENDING',
  outcome_unknown: 'OUTCOME_UNKNOWN',
};

/** Only a short identifier-shaped value from the request may be recorded. */
function safeFact(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    /^[\x21-\x7e]+$/u.test(value)
    ? value
    : undefined;
}

function requestFacts(
  request: unknown,
  keys: readonly ('operationId' | 'brainRecordId' | 'approvalRequestId')[],
): RequestFacts {
  const facts: Record<string, string> = {};
  for (const key of keys) {
    const value = safeFact(request, key);
    if (value !== undefined) facts[key] = value;
  }
  return facts;
}

function principalOf(authenticated: unknown): string {
  // Only a structurally valid authenticated principal is attributed.
  if (typeof authenticated !== 'object' || authenticated === null) {
    return 'unauthenticated';
  }
  const principal: unknown = Reflect.get(authenticated, 'principal');
  const identity: unknown = Reflect.get(authenticated, 'identity');
  if (
    typeof principal !== 'object' ||
    principal === null ||
    typeof identity !== 'object' ||
    identity === null
  ) {
    return 'unauthenticated';
  }
  const id: unknown = Reflect.get(principal, 'id');
  return typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 512 &&
    Reflect.get(identity, 'principalId') === id
    ? id
    : 'unauthenticated';
}

function rejection(error: unknown): Settlement {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { outcome: 'FAILED', reasonCode: 'request_cancelled' };
  }
  if (!(error instanceof DomainError)) {
    return { outcome: 'FAILED', reasonCode: 'internal_error' };
  }
  const reason: unknown = error.details['reason'];
  return {
    outcome: deniedCodes.has(error.code) ? 'DENIED' : 'FAILED',
    reasonCode:
      typeof reason === 'string' && safeReason.test(reason)
        ? `${error.code}.${reason}`
        : error.code,
  };
}

function mutationSettlement(response: MutationResponse): Settlement {
  return {
    outcome: mutationOutcomes[response.state],
    reasonCode: `mutation_${response.state}`,
    facts: {
      operationId: response.operationId,
      ...(response.brainRecordId === undefined
        ? {}
        : { brainRecordId: response.brainRecordId }),
      ...(response.record === undefined
        ? {}
        : {
            provider: response.record.provider,
            providerRecordId: response.record.providerRecordId,
          }),
    },
  };
}

/**
 * The single audited boundary for all eight Brain operations. Each call
 * enqueues exactly one metadata-only request event in the durable outbox, in
 * addition to the domain events the services already record. Content never
 * enters the event.
 */
export class AuditedBrainOperations {
  constructor(
    private readonly services: BrainOperationServices,
    private readonly store: RequestAuditStore,
    private readonly clock: Clock,
  ) {}

  async searchBrain(
    authenticated: AuthenticatedPrincipal,
    context: RequestContext,
    request: SearchBrainRequest,
    signal: AbortSignal,
  ): Promise<SearchBrainResponse> {
    return await this.audited(
      'search_brain',
      authenticated,
      context,
      {},
      () =>
        this.services.query.searchBrain(
          authenticated,
          context,
          request,
          signal,
        ),
      (response) => ({
        outcome: 'COMPLETED',
        reasonCode: response.completeness.complete
          ? 'search_complete'
          : 'search_partial',
      }),
    );
  }

  async fetchRecord(
    authenticated: AuthenticatedPrincipal,
    context: RequestContext,
    request: FetchRecordRequest,
    signal: AbortSignal,
  ): Promise<FetchRecordResponse> {
    return await this.audited(
      'fetch_record',
      authenticated,
      context,
      requestFacts(request, ['brainRecordId']),
      () =>
        this.services.query.fetchRecord(
          authenticated,
          context,
          request,
          signal,
        ),
      (response) => ({
        outcome: 'COMPLETED',
        reasonCode: 'record_fetched',
        facts: {
          provider: response.record.provenance.provider,
          providerRecordId: response.record.provenance.providerRecordId,
        },
      }),
    );
  }

  async persistKnowledge(
    authenticated: AuthenticatedPrincipal,
    context: RequestContext,
    request: PersistKnowledgeRequest,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    return await this.audited(
      'persist_knowledge',
      authenticated,
      context,
      requestFacts(request, ['operationId']),
      () =>
        this.services.mutations.persistKnowledge(
          authenticated,
          context,
          request,
          signal,
        ),
      mutationSettlement,
    );
  }

  async updateRecord(
    authenticated: AuthenticatedPrincipal,
    context: RequestContext,
    request: UpdateRecordRequest,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    return await this.audited(
      'update_record',
      authenticated,
      context,
      requestFacts(request, ['operationId', 'brainRecordId']),
      () =>
        this.services.mutations.updateRecord(
          authenticated,
          context,
          request,
          signal,
        ),
      mutationSettlement,
    );
  }

  async appendToRecord(
    authenticated: AuthenticatedPrincipal,
    context: RequestContext,
    request: AppendRecordRequest,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    return await this.audited(
      'append_to_record',
      authenticated,
      context,
      requestFacts(request, ['operationId', 'brainRecordId']),
      () =>
        this.services.mutations.appendToRecord(
          authenticated,
          context,
          request,
          signal,
        ),
      mutationSettlement,
    );
  }

  async deleteRecord(
    authenticated: AuthenticatedPrincipal,
    context: RequestContext,
    request: DeleteRecordRequest,
    signal: AbortSignal,
  ): Promise<MutationResponse> {
    return await this.audited(
      'delete_record',
      authenticated,
      context,
      requestFacts(request, ['operationId', 'brainRecordId']),
      () =>
        this.services.mutations.deleteRecord(
          authenticated,
          context,
          request,
          signal,
        ),
      mutationSettlement,
    );
  }

  async listApprovals(
    authenticated: AuthenticatedPrincipal,
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<ListApprovalsResponse> {
    return await this.audited(
      'list_approvals',
      authenticated,
      context,
      {},
      () =>
        this.services.approvals.listApprovals(authenticated, context, signal),
      () => ({ outcome: 'COMPLETED', reasonCode: 'approvals_listed' }),
    );
  }

  async resolveApproval(
    authenticated: AuthenticatedPrincipal,
    context: RequestContext,
    request: ResolveApprovalRequest,
    signal: AbortSignal,
  ): Promise<ResolveApprovalResponse> {
    return await this.audited(
      'resolve_approval',
      authenticated,
      context,
      requestFacts(request, ['approvalRequestId']),
      () =>
        this.services.approvals.resolveApproval(
          authenticated,
          context,
          request,
          signal,
        ),
      (response) => ({
        outcome: response.operationState,
        reasonCode: `approval_${response.approvalStatus}`,
        facts: {
          approvalRequestId: response.approvalRequestId,
          operationId: response.operationId,
        },
      }),
    );
  }

  private async audited<Value>(
    operation: BrainOperationName,
    authenticated: AuthenticatedPrincipal,
    context: RequestContext,
    requestFacts: RequestFacts,
    run: () => Promise<Value>,
    settle: (value: Value) => Settlement,
  ): Promise<Value> {
    let value: Value;
    try {
      value = await run();
    } catch (error) {
      try {
        await this.record(
          'brain.request.rejected',
          operation,
          authenticated,
          context,
          requestFacts,
          rejection(error),
        );
      } catch {
        // The original rejection is what the caller must see.
      }
      throw error;
    }
    try {
      await this.record(
        'brain.request.completed',
        operation,
        authenticated,
        context,
        requestFacts,
        settle(value),
      );
    } catch {
      // Every operation is idempotent on replay, so a retry is safe and lets
      // the request event be recorded rather than silently dropped.
      throw new DomainError('provider_unavailable', true, {
        reason: 'audit_state_unavailable',
      });
    }
    return value;
  }

  private async record(
    eventType: string,
    operation: BrainOperationName,
    authenticated: AuthenticatedPrincipal,
    context: RequestContext,
    requestFacts: RequestFacts,
    settlement: Settlement,
  ): Promise<void> {
    const facts = { ...requestFacts, ...settlement.facts };
    await this.store.enqueueAuditEvent({
      eventType,
      requestId: context.requestId,
      principalId: principalOf(authenticated) as AuditEvent['principalId'],
      ...(context.clientId === undefined ? {} : { clientId: context.clientId }),
      operation,
      ...(facts.operationId === undefined
        ? {}
        : { operationId: facts.operationId }),
      ...(facts.brainRecordId === undefined
        ? {}
        : { brainRecordId: facts.brainRecordId }),
      ...(facts.approvalRequestId === undefined
        ? {}
        : { approvalRequestId: facts.approvalRequestId }),
      ...(facts.provider === undefined ? {} : { provider: facts.provider }),
      ...(facts.providerRecordId === undefined
        ? {}
        : { providerRecordId: facts.providerRecordId }),
      outcome: settlement.outcome,
      reasonCode: settlement.reasonCode,
      timestamp: this.clock.now(),
    });
  }
}
