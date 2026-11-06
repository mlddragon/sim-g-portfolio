import { describe, expect, it } from 'vitest';

import { composeGateway } from '../../src/bootstrap.js';

describe('composeGateway', () => {
  it.each([
    [{ providerTimeoutMs: 25_000 }, {}],
    [{ providerTimeoutMs: 5_000 }, { operationTimeoutMs: 5_000 }],
  ])(
    'refuses a provider timeout %o that cannot finish before the request deadline %o',
    async (ports, api) => {
      await expect(composeGateway({ ...ports } as never, api)).rejects.toThrow(
        'invalid_gateway_options',
      );
    },
  );
});
