export const domainErrorCodes = [
  'unauthenticated',
  'unauthorized',
  'insufficient_metadata',
  'routing_ambiguous',
  'not_found',
  'provider_unavailable',
  'partial_results',
  'approval_required',
  'elevation_required',
  'protected_record',
  'idempotency_conflict',
  'outcome_unknown',
  'policy_drift',
  'provider_capability_unsupported',
  'environment_boundary_violation',
  'invalid_request',
  'internal_error',
] as const;

export type DomainErrorCode = (typeof domainErrorCodes)[number];

export type SafeDetailValue =
  | boolean
  | number
  | string
  | null
  | readonly SafeDetailValue[]
  | { readonly [key: string]: SafeDetailValue };

export type SafeErrorDetails = Readonly<Record<string, SafeDetailValue>>;

export interface DomainErrorResponse {
  readonly error: {
    readonly code: DomainErrorCode;
    readonly retryable: boolean;
    readonly details: SafeErrorDetails;
  };
}

const unsafeObjectKeys = new Set(['__proto__', 'constructor', 'prototype']);

function cloneSafeValue(
  value: unknown,
  ancestors: WeakSet<object>,
): SafeDetailValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError('invalid_error_details');
    }

    ancestors.add(value);
    try {
      return Object.freeze(
        value.map((item) => cloneSafeValue(item, ancestors)),
      );
    } finally {
      ancestors.delete(value);
    }
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('invalid_error_details');
    }

    if (ancestors.has(value)) {
      throw new TypeError('invalid_error_details');
    }

    ancestors.add(value);
    const cloned: Record<string, SafeDetailValue> = {};
    try {
      for (const [key, item] of Object.entries(value)) {
        if (unsafeObjectKeys.has(key)) {
          throw new TypeError('invalid_error_details');
        }
        cloned[key] = cloneSafeValue(item, ancestors);
      }
      return Object.freeze(cloned);
    } finally {
      ancestors.delete(value);
    }
  }

  throw new TypeError('invalid_error_details');
}

function cloneSafeDetails(details: SafeErrorDetails): SafeErrorDetails {
  return cloneSafeValue(details, new WeakSet<object>()) as SafeErrorDetails;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly retryable: boolean;
  readonly details: SafeErrorDetails;

  constructor(
    code: DomainErrorCode,
    retryable: boolean,
    details: SafeErrorDetails = {},
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'DomainError';
    this.code = code;
    this.retryable = retryable;
    this.details = cloneSafeDetails(details);
  }

  toResponse(): DomainErrorResponse {
    return {
      error: {
        code: this.code,
        retryable: this.retryable,
        details: this.details,
      },
    };
  }
}
