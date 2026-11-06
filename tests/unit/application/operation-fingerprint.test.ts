import { describe, expect, it } from 'vitest';

import { operationFingerprint } from '../../../src/application/operation-fingerprint.js';

describe('operationFingerprint', () => {
  it('produces one stable SHA-256 fingerprint regardless of object key order', () => {
    const first = operationFingerprint('update_record', {
      brainRecordId: 'brn_x',
      mutation: {
        mode: 'patch',
        patch: { title: 'Synthetic title' },
      },
    });
    const reordered = operationFingerprint('update_record', {
      mutation: {
        patch: { title: 'Synthetic title' },
        mode: 'patch',
      },
      brainRecordId: 'brn_x',
    });

    expect(first).toBe(
      '8de306dfa8a981c96a525857717e1efa8858f05f12fca7a1c78c6cd4bb7228cb',
    );
    expect(reordered).toBe(first);
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date('2042-01-01T00:00:00.000Z'),
    Object.create(null) as object,
  ])('rejects non-operational JSON values without coercion', (unsafe) => {
    expect(() =>
      operationFingerprint('update_record', {
        unsafe,
      }),
    ).toThrow('invalid_operation_fingerprint_payload');
  });

  it('rejects cyclic payloads without invoking serialization hooks', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    let serialized = false;

    expect(() =>
      operationFingerprint('update_record', {
        cyclic,
        toJSON: () => {
          serialized = true;
          return 'unsafe';
        },
      }),
    ).toThrow('invalid_operation_fingerprint_payload');
    expect(serialized).toBe(false);
  });

  it('rejects hidden and symbol properties instead of hashing an incomplete snapshot', () => {
    const hidden = { visible: 'synthetic' };
    Object.defineProperty(hidden, 'concealed', {
      value: 'synthetic hidden value',
      enumerable: false,
    });
    const symbolic = { visible: 'synthetic' } as Record<PropertyKey, unknown>;
    symbolic[Symbol('concealed')] = 'synthetic symbol value';

    expect(() => operationFingerprint('update_record', hidden)).toThrow(
      'invalid_operation_fingerprint_payload',
    );
    expect(() => operationFingerprint('update_record', symbolic)).toThrow(
      'invalid_operation_fingerprint_payload',
    );
  });
});
