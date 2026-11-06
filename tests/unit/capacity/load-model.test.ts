import { describe, expect, it } from 'vitest';

import {
  pickOperation,
  percentile,
  summarizeSamples,
  syntheticGoogleClaims,
  type OperationMix,
} from '../../capacity/load-model.js';

describe('capacity load model', () => {
  it('computes nearest-rank percentiles', () => {
    const values = [5, 1, 4, 2, 3];
    expect(percentile(values, 50)).toBe(3);
    expect(percentile(values, 95)).toBe(5);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile([], 95)).toBeNaN();
    expect(() => percentile(values, 101)).toThrow('invalid_percentile');
  });

  it('summarizes samples per operation with status counts and error rate', () => {
    const summary = summarizeSamples(
      [
        { operation: 'search_brain', status: 200, milliseconds: 10 },
        { operation: 'search_brain', status: 200, milliseconds: 30 },
        { operation: 'search_brain', status: 503, milliseconds: 50 },
        { operation: 'fetch_record', status: 200, milliseconds: 20 },
        { operation: 'fetch_record', status: 0, milliseconds: 70 },
      ],
      10_000,
    );

    expect(summary.total).toEqual({
      requests: 5,
      errors: 2,
      errorRate: 0.4,
      requestsPerSecond: 0.5,
      p50: 30,
      p95: 70,
      p99: 70,
      max: 70,
    });
    expect(summary.byOperation['search_brain']).toMatchObject({
      requests: 3,
      errors: 1,
      statuses: { '200': 2, '503': 1 },
      p50: 30,
    });
    expect(summary.byOperation['fetch_record']?.statuses).toEqual({
      '0': 1,
      '200': 1,
    });
  });

  it('summarizes very large runs without exhausting the stack', () => {
    const samples = Array.from({ length: 300_000 }, (_, index) => ({
      operation: 'search_brain' as const,
      status: 200,
      milliseconds: index % 1_000,
    }));
    const summary = summarizeSamples(samples, 60_000);
    expect(summary.total.max).toBe(999);
    expect(summary.total.requests).toBe(300_000);
  });

  it('counts failure reasons per operation', () => {
    const summary = summarizeSamples(
      [
        {
          operation: 'search_brain',
          status: 401,
          milliseconds: 1,
          reason: 'identity_verification_failed',
        },
        {
          operation: 'search_brain',
          status: 401,
          milliseconds: 1,
          reason: 'identity_verification_failed',
        },
        {
          operation: 'search_brain',
          status: 429,
          milliseconds: 1,
          reason: 'rate_limited',
        },
        { operation: 'search_brain', status: 200, milliseconds: 1 },
      ],
      1_000,
    );
    expect(summary.byOperation['search_brain']?.reasons).toEqual({
      identity_verification_failed: 2,
      rate_limited: 1,
    });
  });

  it('picks operations by cumulative weight', () => {
    const mix: OperationMix = {
      search_brain: 5,
      fetch_record: 3,
      persist_knowledge: 2,
    };
    expect(pickOperation(mix, () => 0)).toBe('search_brain');
    expect(pickOperation(mix, () => 0.49)).toBe('search_brain');
    expect(pickOperation(mix, () => 0.5)).toBe('fetch_record');
    expect(pickOperation(mix, () => 0.79)).toBe('fetch_record');
    expect(pickOperation(mix, () => 0.999)).toBe('persist_knowledge');
    expect(() => pickOperation({}, () => 0)).toThrow('invalid_operation_mix');
  });

  it('builds Google-shaped synthetic ID token claims', () => {
    const claims = syntheticGoogleClaims({
      subject: 'synthetic-subject-operator',
      email: 'operator@example.invalid',
      audience: 'gateway-development.example.invalid',
      hostedDomain: 'example.invalid',
      issuedAt: 1_000,
      lifetimeSeconds: 600,
    });
    expect(claims).toEqual({
      iss: 'https://accounts.google.com',
      sub: 'synthetic-subject-operator',
      aud: 'gateway-development.example.invalid',
      azp: 'gateway-development.example.invalid',
      email: 'operator@example.invalid',
      email_verified: true,
      hd: 'example.invalid',
      iat: 1_000,
      exp: 1_600,
    });
    expect(() =>
      syntheticGoogleClaims({
        subject: 'synthetic-subject-operator',
        email: 'operator@real-family.com',
        audience: 'a',
        hostedDomain: 'example.invalid',
        issuedAt: 1,
        lifetimeSeconds: 60,
      }),
    ).toThrow('synthetic_identity_required');
  });
});
