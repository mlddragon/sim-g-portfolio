import {
  DomainError,
  type DomainErrorCode,
  type DomainErrorResponse,
} from '../domain/errors.js';

/** Stable HTTP status for each domain error code. */
const statusByCode: Readonly<Record<DomainErrorCode, number>> = {
  unauthenticated: 401,
  unauthorized: 403,
  insufficient_metadata: 422,
  routing_ambiguous: 422,
  not_found: 404,
  provider_unavailable: 503,
  partial_results: 503,
  approval_required: 403,
  elevation_required: 403,
  protected_record: 403,
  idempotency_conflict: 409,
  outcome_unknown: 409,
  policy_drift: 503,
  provider_capability_unsupported: 422,
  environment_boundary_violation: 403,
  invalid_request: 400,
  internal_error: 500,
};

/**
 * Transport-only code: limiting happens before any application operation, so
 * it never enters the domain error list, operation state or audit events.
 */
export type ApiErrorCode = DomainErrorCode | 'rate_limited';

export interface ApiErrorResponse {
  readonly status: number;
  readonly body: {
    readonly error: Omit<DomainErrorResponse['error'], 'code'> & {
      readonly code: ApiErrorCode;
    };
  };
  readonly code: ApiErrorCode;
  readonly retryAfterSeconds?: number;
}

/** Raised by the transport rate limiter; carries only a fixed reason. */
export class RateLimitedError extends Error {
  constructor(
    readonly reason:
      | 'ip_rate_limited'
      | 'health_rate_limited'
      | 'principal_rate_limited'
      | 'mutation_rate_limited'
      | 'client_rate_limited',
    readonly retryAfterSeconds: number,
  ) {
    super('rate_limited');
  }
}

function invalidRequest(status: number, reason: string): ApiErrorResponse {
  return {
    status,
    code: 'invalid_request',
    body: new DomainError('invalid_request', false, { reason }).toResponse(),
  };
}

function ownValue(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
      ? (descriptor.value as unknown)
      : undefined;
  } catch {
    return undefined;
  }
}

function internalError(): ApiErrorResponse {
  return {
    status: 500,
    code: 'internal_error',
    body: new DomainError('internal_error', false).toResponse(),
  };
}

/**
 * Maps any thrown value to a safe response. Only DomainError details and
 * Fastify's own transport error codes are used; messages, stacks and causes
 * are never copied. Transport codes are honoured only for failures raised
 * before a route handler runs, so an application error cannot impersonate one.
 */
export function errorResponse(
  error: unknown,
  beforeHandler: boolean,
): ApiErrorResponse {
  try {
    if (error instanceof RateLimitedError) {
      return {
        status: 429,
        code: 'rate_limited',
        retryAfterSeconds: error.retryAfterSeconds,
        body: {
          error: {
            code: 'rate_limited',
            retryable: true,
            details: { reason: error.reason },
          },
        },
      };
    }
    if (error instanceof DomainError) {
      return {
        status: statusByCode[error.code],
        code: error.code,
        body: error.toResponse(),
      };
    }
    if (!beforeHandler) return internalError();
    const code = ownValue(error, 'code');
    if (typeof code !== 'string' || !code.startsWith('FST_ERR_')) {
      return ownValue(error, 'statusCode') === 400 &&
        error instanceof SyntaxError
        ? invalidRequest(400, 'invalid_json')
        : internalError();
    }
    switch (code) {
      case 'FST_ERR_CTP_BODY_TOO_LARGE':
        return invalidRequest(413, 'body_too_large');
      case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
        return invalidRequest(415, 'unsupported_media_type');
      case 'FST_ERR_BAD_URL':
        return invalidRequest(400, 'bad_url');
      default:
        return ownValue(error, 'statusCode') === 400
          ? invalidRequest(400, 'invalid_json')
          : internalError();
    }
  } catch {
    return internalError();
  }
}
