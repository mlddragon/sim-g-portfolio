import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Writable } from 'node:stream';

import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { pino } from 'pino';

import type { AuditedBrainOperations } from '../application/audited-brain-operations.js';
import type { AuthenticationService } from '../application/authentication-service.js';
import { DomainError } from '../domain/errors.js';
import {
  requestId as toRequestId,
  type OperationId,
  type PrincipalId,
  type RequestId,
} from '../domain/identifiers.js';
import type { MutationResponse } from '../domain/operations.js';
import type { AuthenticatedPrincipal } from '../domain/principal.js';
import type { RequestContext } from '../domain/request-context.js';
import type { Clock } from '../ports/clock.js';
import {
  errorResponse,
  RateLimitedError,
  type ApiErrorCode,
  type ApiErrorResponse,
} from './error-response.js';
import { clientAddressKey, FixedWindowLimiter } from './rate-limiter.js';
import {
  listApprovalsResponseBody,
  parseListApprovalsBody,
  parseResolveApprovalBody,
  resolveApprovalResponseBody,
} from './schemas/approvals.js';
import {
  mutationOperationId,
  mutationResponseBody,
  mutationStatus,
  parseAppendBody,
  parseDeleteBody,
  parsePersistBody,
  parseUpdateBody,
} from './schemas/mutations.js';
import {
  fetchRecordResponseBody,
  parseFetchRecordBody,
} from './schemas/fetch-record.js';
import {
  parseSearchBrainBody,
  searchBrainResponseBody,
} from './schemas/search-brain.js';

export interface ApiDependencies {
  readonly authentication: Pick<AuthenticationService, 'authenticate'>;
  readonly operations: Pick<
    AuditedBrainOperations,
    | 'searchBrain'
    | 'fetchRecord'
    | 'listApprovals'
    | 'resolveApproval'
    | 'persistKnowledge'
    | 'updateRecord'
    | 'appendToRecord'
    | 'deleteRecord'
  >;
  readonly clock: Clock;
  /** Server-side request ID source; client-supplied IDs are never used. */
  readonly requestIds?: () => string;
}

export interface ApiOptions {
  /** Structured request-log output; defaults to stdout. */
  readonly logStream?: Writable;
  /** Proxy hops in front of the service (Cloud Run: 1). Defaults to none. */
  readonly trustedProxyHops?: number;
  /** Deadline for authentication and for one operation, each. */
  readonly operationTimeoutMs?: number;
  /** Per-minute request limits; each bucket is in-process and bounded. */
  readonly rateLimits?: {
    readonly perIpPerMinute?: number;
    readonly healthPerIpPerMinute?: number;
    readonly perPrincipalPerMinute?: number;
    readonly mutationsPerPrincipalPerMinute?: number;
    readonly perClientPerMinute?: number;
    readonly maxTrackedKeys?: number;
  };
}

const rateLimitWindowMs = 60_000;
const mutationRouteNames: ReadonlySet<string> = new Set([
  'persist_knowledge',
  'update_record',
  'append_to_record',
  'delete_record',
]);

const maximumBodyBytes = 64 * 1024;
const searchBodyBytes = 16 * 1024;
const fetchBodyBytes = 4 * 1024;
const listApprovalsBodyBytes = 1024;
const resolveApprovalBodyBytes = 8 * 1024;
// 1 MiB of content plus title, metadata and JSON escaping headroom.
const contentMutationBodyBytes = 2 * 1024 * 1024;
const deleteBodyBytes = 8 * 1024;
const maximumBearerTokenLength = 16_384;
// RFC 6750 b64token; the scheme name is case-insensitive (RFC 9110).
const bearerToken = /^[Bb][Ee][Aa][Rr][Ee][Rr] ([A-Za-z0-9\-._~+/]+=*)$/u;
const defaultOperationTimeoutMs = 25_000;

const securityHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
} as const;

interface RequestState {
  context: RequestContext;
  authenticated?: AuthenticatedPrincipal;
  errorCode?: ApiErrorCode;
  /** The derived operation ID and client request ID, joining logs to audit. */
  operationId?: string;
  clientRequestId?: string;
  /** Set once the route handler runs; transport error codes stop applying. */
  inHandler: boolean;
}

function invalidOptions(): TypeError {
  return new TypeError('invalid_api_options');
}

function bearerRequired(): DomainError {
  return new DomainError('unauthenticated', false, {
    reason: 'bearer_token_required',
  });
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidOptions();
  }
  return value;
}

/**
 * Runs `run` until it settles or the deadline passes, whether or not it
 * honours its signal. The deadline error replaces any later outcome.
 */
async function withDeadline<Value>(
  timeoutMs: number,
  timeoutReason: string,
  run: (deadline: AbortSignal) => Promise<Value>,
): Promise<Value> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const timedOut = (): DomainError =>
    new DomainError('provider_unavailable', true, { reason: timeoutReason });
  let onTimeout: (() => void) | undefined;
  const expiry = new Promise<never>((_, reject) => {
    onTimeout = () => {
      reject(timedOut());
    };
    deadline.addEventListener('abort', onTimeout, { once: true });
  });
  try {
    return await Promise.race([run(deadline), expiry]);
  } catch (error) {
    if (deadline.aborted && !(error instanceof DomainError)) throw timedOut();
    throw error;
  } finally {
    if (onTimeout !== undefined) {
      deadline.removeEventListener('abort', onTimeout);
    }
  }
}

/**
 * The authenticated HTTP composition root. Authentication runs in `onRequest`,
 * before the body is read; route handlers only validate input, call one
 * audited application operation and project its response.
 */
export async function buildApp(
  dependencies: ApiDependencies,
  options: ApiOptions = {},
): Promise<FastifyInstance> {
  const trustedProxyHops = boundedInteger(options.trustedProxyHops, 0, 0, 2);
  const operationTimeoutMs = boundedInteger(
    options.operationTimeoutMs,
    defaultOperationTimeoutMs,
    1,
    120_000,
  );
  const states = new WeakMap<FastifyRequest, RequestState>();
  const limits = options.rateLimits ?? {};
  const maxTrackedKeys = boundedInteger(
    limits.maxTrackedKeys,
    10_000,
    1,
    1_000_000,
  );
  const limiter = (value: number | undefined, fallback: number) =>
    new FixedWindowLimiter(
      boundedInteger(value, fallback, 1, 1_000_000),
      rateLimitWindowMs,
      maxTrackedKeys,
      dependencies.clock,
    );
  const ipLimiter = limiter(limits.perIpPerMinute, 120);
  const healthLimiter = limiter(limits.healthPerIpPerMinute, 600);
  const principalLimiter = limiter(limits.perPrincipalPerMinute, 120);
  const mutationLimiter = limiter(limits.mutationsPerPrincipalPerMinute, 30);
  const clientLimiter = limiter(limits.perClientPerMinute, 600);
  const enforce = (
    bucket: FixedWindowLimiter,
    key: string,
    reason: RateLimitedError['reason'],
  ): void => {
    const decision = bucket.take(key);
    if (!decision.allowed) {
      throw new RateLimitedError(reason, decision.retryAfterSeconds);
    }
  };

  const nextRequestId = (): string => {
    try {
      const candidate = dependencies.requestIds?.();
      if (candidate !== undefined) return toRequestId(candidate);
    } catch {
      // An invalid source must never fail the request.
    }
    return toRequestId(`req_${randomUUID()}`);
  };

  const stateOf = (request: FastifyRequest): RequestState => {
    let state = states.get(request);
    if (state === undefined) {
      state = {
        context: {
          requestId: toRequestId(request.id),
          receivedAt: dependencies.clock.now(),
        },
        inHandler: false,
      };
      states.set(request, state);
    }
    return state;
  };

  const logCompletion = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): void => {
    const state = states.get(request);
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        ...(state?.errorCode === undefined
          ? {}
          : { errorCode: state.errorCode }),
        ...(state?.operationId === undefined
          ? {}
          : { operationId: state.operationId }),
        ...(state?.clientRequestId === undefined
          ? {}
          : { clientRequestId: state.clientRequestId }),
        durationMs: Math.round(reply.elapsedTime),
      },
      'request_completed',
    );
  };

  const sendError = (
    request: FastifyRequest,
    reply: FastifyReply,
    mapped: ApiErrorResponse,
  ): FastifyReply => {
    stateOf(request).errorCode = mapped.code;
    if (mapped.status === 401) reply.header('www-authenticate', 'Bearer');
    if (mapped.retryAfterSeconds !== undefined) {
      reply.header('retry-after', String(mapped.retryAfterSeconds));
    }
    return reply
      .status(mapped.status)
      .send({ ...mapped.body, requestId: request.id });
  };

  const app = Fastify<Server, IncomingMessage, ServerResponse>({
    loggerInstance: pino(
      {
        base: null,
        messageKey: 'msg',
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      options.logStream ?? process.stdout,
    ),
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    requestIdHeader: false,
    genReqId: nextRequestId,
    // Trust exactly the configured number of nearest proxy hops.
    trustProxy: (_address: string, hop: number) => hop < trustedProxyHops,
    bodyLimit: maximumBodyBytes,
    routerOptions: { caseSensitive: true },
    exposeHeadRoutes: false,
    return503OnClosing: true,
    requestTimeout: operationTimeoutMs + 5_000,
    // Malformed URLs never reach hooks; answer them through the same envelope.
    frameworkErrors: (error, request, reply) => {
      reply.headers(securityHeaders);
      reply.header('x-request-id', request.id);
      // These never reach the onRequest hook, so count them here too.
      const decision = ipLimiter.take(clientAddressKey(request.ip));
      const failure = decision.allowed
        ? error
        : new RateLimitedError('ip_rate_limited', decision.retryAfterSeconds);
      sendError(request, reply, errorResponse(failure, true));
      logCompletion(request, reply);
    },
  });

  // JSON only; Fastify's default text/plain parser is removed.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    app.getDefaultJsonParser('error', 'error'),
  );

  app.addHook('onRequest', (request, _reply, done) => {
    stateOf(request);
    // Per client IP (as resolved through the trusted proxy hops only), before
    // authentication or any body is read. Liveness has its own bucket.
    try {
      if (request.routeOptions.url === '/healthz') {
        enforce(
          healthLimiter,
          clientAddressKey(request.ip),
          'health_rate_limited',
        );
      } else {
        enforce(ipLimiter, clientAddressKey(request.ip), 'ip_rate_limited');
      }
    } catch (error) {
      done(error as Error);
      return;
    }
    // Unknown routes are answered before any body is read.
    if (request.is404) {
      done(new DomainError('not_found', false, { reason: 'route_not_found' }));
      return;
    }
    done();
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    reply.headers(securityHeaders);
    reply.header('x-request-id', request.id);
    done(null, payload);
  });

  app.addHook('onResponse', (request, reply, done) => {
    logCompletion(request, reply);
    done();
  });

  app.setErrorHandler((error, request, reply) =>
    sendError(
      request,
      reply,
      errorResponse(error, !stateOf(request).inHandler),
    ),
  );

  app.setNotFoundHandler((request, reply) =>
    sendError(
      request,
      reply,
      errorResponse(
        new DomainError('not_found', false, { reason: 'route_not_found' }),
        true,
      ),
    ),
  );

  const authenticate = async (request: FastifyRequest): Promise<void> => {
    const state = stateOf(request);
    const header = request.headers.authorization;
    const match =
      typeof header === 'string' &&
      header.length <= maximumBearerTokenLength + 'Bearer '.length
        ? bearerToken.exec(header)
        : null;
    const token = match?.[1];
    if (token === undefined) throw bearerRequired();
    // The identity provider takes no signal; the deadline still bounds it.
    const authenticated = await withDeadline(
      operationTimeoutMs,
      'authentication_timeout',
      () => dependencies.authentication.authenticate(token, state.context),
    );
    const clientId = authenticated.identity.clientId;
    state.authenticated = authenticated;
    state.context = {
      ...state.context,
      ...(clientId === undefined ? {} : { clientId }),
    };
  };

  /**
   * Per verified principal, per principal for mutations, and per verified
   * client ID; all after authentication and before the body is read. Nothing
   * client-declared selects a bucket.
   */
  const limitAuthenticated = (
    request: FastifyRequest,
    mutation: boolean,
  ): void => {
    const state = stateOf(request);
    const authenticated = state.authenticated;
    if (authenticated === undefined) throw bearerRequired();
    const principal = authenticated.principal.id;
    enforce(principalLimiter, principal, 'principal_rate_limited');
    if (mutation) enforce(mutationLimiter, principal, 'mutation_rate_limited');
    const clientId = authenticated.identity.clientId;
    if (clientId !== undefined) {
      enforce(clientLimiter, clientId, 'client_rate_limited');
    }
  };

  /** Runs one operation under client-disconnect and deadline signals. */
  const operate = async <Value>(
    reply: FastifyReply,
    run: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value> => {
    // The response is unwritten while the operation runs, so a close here is
    // a client disconnect.
    const disconnect = new AbortController();
    const abort = (): void => {
      disconnect.abort();
    };
    reply.raw.once('close', abort);
    try {
      return await withDeadline(
        operationTimeoutMs,
        'operation_timeout',
        (deadline) => run(AbortSignal.any([disconnect.signal, deadline])),
      );
    } catch (error) {
      if (disconnect.signal.aborted && !(error instanceof DomainError)) {
        throw new DomainError('provider_unavailable', true, {
          reason: 'client_closed',
        });
      }
      throw error;
    } finally {
      reply.raw.removeListener('close', abort);
    }
  };

  const authenticatedState = (
    request: FastifyRequest,
  ): RequestState & { authenticated: AuthenticatedPrincipal } => {
    const state = stateOf(request);
    state.inHandler = true;
    if (state.authenticated === undefined) throw bearerRequired();
    return { ...state, authenticated: state.authenticated };
  };

  app.get('/healthz', (_request, reply) => reply.send({ status: 'ok' }));

  /**
   * One audited operation route: authenticate in `onRequest`, validate the
   * strict body, run under the operation deadline and project the response.
   */
  const operationRoute = <Body, Value>(
    name: string,
    bodyLimit: number,
    parse: (body: unknown) => Body | undefined,
    run: (
      authenticated: AuthenticatedPrincipal,
      context: RequestContext,
      body: Body,
      signal: AbortSignal,
    ) => Promise<Value>,
    project: (value: Value) => Record<string, unknown>,
    statusOf: (value: Value) => number = () => 200,
    identify?: (
      authenticated: AuthenticatedPrincipal,
      body: Body,
    ) => { readonly operationId: string; readonly clientRequestId: string },
  ): void => {
    app.post(
      `/v1/operations/${name}`,
      {
        bodyLimit,
        onRequest: [
          authenticate,
          (request: FastifyRequest) => {
            limitAuthenticated(request, mutationRouteNames.has(name));
            return Promise.resolve();
          },
        ],
      },
      async (request, reply) => {
        const state = authenticatedState(request);
        const body = parse(request.body);
        if (body === undefined) {
          throw new DomainError('invalid_request', false, {
            reason: 'invalid_request_body',
          });
        }
        const identity = identify?.(state.authenticated, body);
        if (identity !== undefined) {
          stateOf(request).operationId = identity.operationId;
          stateOf(request).clientRequestId = identity.clientRequestId;
        }
        const value = await operate(reply, (signal) =>
          run(state.authenticated, state.context, body, signal),
        );
        return reply.status(statusOf(value)).send(project(value));
      },
    );
  };

  const { operations } = dependencies;
  operationRoute(
    'search_brain',
    searchBodyBytes,
    parseSearchBrainBody,
    (authenticated, context, body, signal) =>
      operations.searchBrain(authenticated, context, body, signal),
    searchBrainResponseBody,
  );
  operationRoute(
    'fetch_record',
    fetchBodyBytes,
    parseFetchRecordBody,
    (authenticated, context, body, signal) =>
      operations.fetchRecord(authenticated, context, body, signal),
    fetchRecordResponseBody,
  );
  operationRoute(
    'list_approvals',
    listApprovalsBodyBytes,
    (body) => (parseListApprovalsBody(body) ? true : undefined),
    (authenticated, context, _body, signal) =>
      operations.listApprovals(authenticated, context, signal),
    listApprovalsResponseBody,
  );
  operationRoute(
    'resolve_approval',
    resolveApprovalBodyBytes,
    parseResolveApprovalBody,
    (authenticated, context, body, signal) =>
      operations.resolveApproval(authenticated, context, body, signal),
    resolveApprovalResponseBody,
  );

  /**
   * Mutation identity: the principal and client ID come only from the
   * verified caller; the client's stable request ID is the idempotency key
   * (PRD §15) and becomes the operation's request context; the operation ID is
   * derived from both so no client can claim another's; and the HTTP
   * correlation ID stays server-generated.
   */
  const mutationRoute = <Body extends { readonly requestId: RequestId }>(
    name: string,
    bodyLimit: number,
    parse: (body: unknown) => Body | undefined,
    run: (
      authenticated: AuthenticatedPrincipal,
      context: RequestContext,
      request: Body & {
        readonly operationId: OperationId;
        readonly principalId: PrincipalId;
        readonly clientId?: string;
      },
      signal: AbortSignal,
    ) => Promise<MutationResponse>,
  ): void => {
    operationRoute(
      name,
      bodyLimit,
      parse,
      (authenticated, context, body, signal) => {
        const { clientId } = context;
        return run(
          authenticated,
          { ...context, requestId: body.requestId },
          {
            ...body,
            operationId: mutationOperationId(
              authenticated.principal.id,
              name,
              body.requestId,
            ),
            principalId: authenticated.principal.id,
            ...(clientId === undefined ? {} : { clientId }),
          },
          signal,
        );
      },
      mutationResponseBody,
      mutationStatus,
      (authenticated, body) => ({
        operationId: mutationOperationId(
          authenticated.principal.id,
          name,
          body.requestId,
        ),
        clientRequestId: body.requestId,
      }),
    );
  };

  mutationRoute(
    'persist_knowledge',
    contentMutationBodyBytes,
    parsePersistBody,
    (authenticated, context, request, signal) =>
      operations.persistKnowledge(authenticated, context, request, signal),
  );
  mutationRoute(
    'update_record',
    contentMutationBodyBytes,
    parseUpdateBody,
    (authenticated, context, request, signal) =>
      operations.updateRecord(authenticated, context, request, signal),
  );
  mutationRoute(
    'append_to_record',
    contentMutationBodyBytes,
    parseAppendBody,
    (authenticated, context, request, signal) =>
      operations.appendToRecord(authenticated, context, request, signal),
  );
  mutationRoute(
    'delete_record',
    deleteBodyBytes,
    parseDeleteBody,
    (authenticated, context, request, signal) =>
      operations.deleteRecord(authenticated, context, request, signal),
  );

  await app.ready();
  return app;
}
