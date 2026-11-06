import { PassThrough } from 'node:stream';
import { afterEach } from 'vitest';

import {
  buildApp,
  type ApiDependencies,
  type ApiOptions,
} from '../../src/api/build-app.js';
import type {
  ListApprovalsResponse,
  ResolveApprovalRequest,
  ResolveApprovalResponse,
} from '../../src/domain/approvals.js';
import { DomainError } from '../../src/domain/errors.js';
import {
  approvalRequestId,
  brainRecordId,
  operationId,
  providerRecordId,
} from '../../src/domain/identifiers.js';
import type {
  AppendRecordRequest,
  DeleteRecordRequest,
  FetchRecordRequest,
  FetchRecordResponse,
  MutationResponse,
  PersistKnowledgeRequest,
  SearchBrainRequest,
  SearchBrainResponse,
  UpdateRecordRequest,
} from '../../src/domain/operations.js';
import type { AuthenticatedPrincipal } from '../../src/domain/principal.js';
import type { RequestContext } from '../../src/domain/request-context.js';
import {
  brainReadPrincipal,
  brainReadRecord,
  brainReadSummary,
} from './brain-read-fixtures.js';

export const apiNow = new Date('2045-05-06T07:08:09.000Z');
export const validToken = 'synthetic.valid-token_for~operator+/=';
export const addisonToken = 'synthetic.participant-token';
export const confidentialQuery = 'Synthetic confidential search phrase';

interface Call<Request> {
  readonly authenticated: AuthenticatedPrincipal;
  readonly context: RequestContext;
  readonly request: Request;
  readonly signal: AbortSignal;
}

export interface ApiHarness {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly logs: () => Record<string, unknown>[];
  readonly searches: Call<SearchBrainRequest>[];
  readonly fetches: Call<FetchRecordRequest>[];
  readonly listings: Omit<Call<undefined>, 'request'>[];
  readonly resolutions: Call<ResolveApprovalRequest>[];
  readonly mutations: (Call<
    | PersistKnowledgeRequest
    | UpdateRecordRequest
    | AppendRecordRequest
    | DeleteRecordRequest
  > & { readonly operation: string })[];
  readonly authentications: { token: string; context: RequestContext }[];
}

export type ApiOverrides = Partial<Omit<ApiDependencies, 'operations'>> & {
  readonly operations?: Partial<ApiDependencies['operations']>;
};

const apps: ApiHarness['app'][] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

export const syntheticApprovals: ListApprovalsResponse = {
  approvals: [
    {
      approvalRequestId: approvalRequestId('apr_api_1'),
      operationId: operationId('op_api_1'),
      status: 'pending',
      summary: {
        requestedByDisplayName: 'participant',
        action: 'Update one Family Shared record',
        safeTargetDescription: 'Synthetic shared note',
      },
      createdAt: new Date('2045-05-06T07:00:00.000Z'),
    },
  ],
};

export function completedMutation(request: {
  readonly operationId: string;
}): MutationResponse {
  return {
    operationId: operationId(request.operationId),
    state: 'completed',
    brainRecordId: brainRecordId('brn_api_mutated'),
    record: {
      provider: 'notion',
      providerRecordId: providerRecordId('notion-api-mutated'),
      providerVersion: 'notion-version-mutated',
      canonicalLocation: {
        provider: 'notion',
        containerRef: 'notion://development/family-shared',
      },
    },
  };
}

export async function apiHarness(
  overrides: ApiOverrides = {},
  options: Partial<ApiOptions> = {},
): Promise<ApiHarness> {
  const harness: Omit<ApiHarness, 'app' | 'logs'> = {
    searches: [],
    fetches: [],
    listings: [],
    resolutions: [],
    mutations: [],
    authentications: [],
  };
  type MutationRequest = ApiHarness['mutations'][number]['request'];
  const mutate =
    (operation: string) =>
    (
      authenticated: AuthenticatedPrincipal,
      context: RequestContext,
      request: MutationRequest,
      signal: AbortSignal,
    ): Promise<MutationResponse> => {
      harness.mutations.push({
        operation,
        authenticated,
        context,
        request,
        signal,
      });
      return Promise.resolve(completedMutation(request));
    };
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  let generated = 0;
  const { operations, ...rest } = overrides;
  const app = await buildApp(
    {
      authentication: {
        authenticate: (token, context) => {
          harness.authentications.push({ token, context });
          if (token === validToken) {
            const operator = brainReadPrincipal();
            return Promise.resolve({
              ...operator,
              identity: { ...operator.identity, clientId: 'synthetic-client' },
            });
          }
          if (token === addisonToken) {
            return Promise.resolve(brainReadPrincipal('family_participant'));
          }
          return Promise.reject(
            new DomainError('unauthenticated', false, {
              reason: 'identity_verification_failed',
            }),
          );
        },
      },
      operations: {
        searchBrain: (authenticated, context, request, signal) => {
          harness.searches.push({ authenticated, context, request, signal });
          return Promise.resolve({
            requestId: context.requestId,
            results: [brainReadSummary('notion', 'api')],
            completeness: {
              complete: false,
              providers: [
                { provider: 'notion', state: 'complete' },
                {
                  provider: 'github',
                  state: 'timed_out',
                  errorCode: 'provider_unavailable',
                },
              ],
            },
          } satisfies SearchBrainResponse);
        },
        fetchRecord: (authenticated, context, request, signal) => {
          harness.fetches.push({ authenticated, context, request, signal });
          return Promise.resolve({
            record: brainReadRecord(
              brainReadSummary('drive', 'fetched'),
              'Synthetic full body.',
            ),
          } satisfies FetchRecordResponse);
        },
        listApprovals: (authenticated, context, signal) => {
          harness.listings.push({ authenticated, context, signal });
          return Promise.resolve(syntheticApprovals);
        },
        resolveApproval: (authenticated, context, request, signal) => {
          harness.resolutions.push({ authenticated, context, request, signal });
          return Promise.resolve({
            approvalRequestId: request.approvalRequestId,
            operationId: operationId('op_api_1'),
            approvalStatus: 'approved',
            operationState: 'COMPLETED',
          } satisfies ResolveApprovalResponse);
        },
        persistKnowledge: mutate('persist_knowledge'),
        updateRecord: mutate('update_record'),
        appendToRecord: mutate('append_to_record'),
        deleteRecord: mutate('delete_record'),
        ...operations,
      },
      clock: { now: () => apiNow },
      requestIds: () => {
        generated += 1;
        return `req_api_${String(generated)}`;
      },
      ...rest,
    },
    { logStream: stream, ...options },
  );
  apps.push(app);
  return {
    ...harness,
    app,
    logs: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export function postOperation(
  app: ApiHarness['app'],
  operation: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/v1/operations/${operation}`,
    headers: {
      authorization: `Bearer ${validToken}`,
      'content-type': 'application/json',
      ...headers,
    },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
