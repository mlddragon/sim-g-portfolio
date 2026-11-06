import { describe, expect, it } from 'vitest';

import {
  DomainError,
  type DomainErrorCode,
} from '../../../src/domain/errors.js';

describe('DomainError', () => {
  it('serializes only its stable safe response contract', () => {
    const error = new DomainError(
      'unauthorized',
      false,
      { reason: 'scope_denied' },
      new Error('secret SQL and provider token'),
    );

    expect(error.toResponse()).toEqual({
      error: {
        code: 'unauthorized',
        retryable: false,
        details: { reason: 'scope_denied' },
      },
    });
    expect(JSON.stringify(error.toResponse())).not.toContain('secret SQL');
    expect(JSON.stringify(error.toResponse())).not.toContain('stack');
    expect(JSON.stringify(error.toResponse())).not.toContain('cause');
  });

  it.each<readonly [DomainErrorCode, boolean]>([
    ['unauthenticated', false],
    ['insufficient_metadata', true],
    ['routing_ambiguous', true],
    ['provider_unavailable', true],
    ['approval_required', false],
    ['elevation_required', false],
    ['outcome_unknown', true],
    ['policy_drift', false],
    ['provider_capability_unsupported', false],
  ])('retains the stable code %s and retryability %s', (code, retryable) => {
    expect(new DomainError(code, retryable).toResponse()).toEqual({
      error: { code, retryable, details: {} },
    });
  });

  it('takes an immutable snapshot of safe details', () => {
    const details = { missing: ['record_type'] };
    const error = new DomainError('insufficient_metadata', true, details);

    details.missing.push('sensitivity');

    expect(error.toResponse().error.details).toEqual({
      missing: ['record_type'],
    });
  });

  it('rejects non-JSON error details at the boundary', () => {
    expect(
      () =>
        new DomainError('internal_error', false, {
          invalid: new Date('2042-01-02T03:04:05.000Z'),
        } as never),
    ).toThrow('invalid_error_details');
  });

  it('rejects cyclic details without recursing indefinitely', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(
      () => new DomainError('internal_error', false, cyclic as never),
    ).toThrow('invalid_error_details');
  });
});
