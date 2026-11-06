import { describe, expect, it } from 'vitest';

import {
  brainRecordId,
  operationId,
  principalId,
  providerRecordId,
  requestId,
} from '../../../src/domain/identifiers.js';

describe('branded identifiers', () => {
  it('accepts stable non-empty identifiers without changing their value', () => {
    expect(principalId('principal_participant')).toBe('principal_participant');
    expect(requestId('request-2042-01')).toBe('request-2042-01');
    expect(operationId('operation:fictional')).toBe('operation:fictional');
    expect(brainRecordId('brain.record.1')).toBe('brain.record.1');
    expect(providerRecordId('folder/report with spaces.md')).toBe(
      'folder/report with spaces.md',
    );
  });

  it.each(['', '   ', ' leading', 'trailing ', 'contains\ncontrol'])(
    'rejects unsafe identifier input %j',
    (value) => {
      expect(() => requestId(value)).toThrow('invalid_request_id');
    },
  );

  it('rejects unbounded identifiers', () => {
    expect(() => providerRecordId('x'.repeat(513))).toThrow(
      'invalid_provider_record_id',
    );
  });
});
