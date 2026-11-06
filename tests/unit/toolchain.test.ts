import { describe, expect, it } from 'vitest';

import { gatewayVersion } from '../../src/index.js';

describe('repository toolchain', () => {
  it('executes TypeScript ESM tests against the gateway package', () => {
    expect(gatewayVersion).toBe('0.1.0');
  });
});
