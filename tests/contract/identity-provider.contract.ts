import { describe, expect, it } from 'vitest';

import type { VerifiedExternalIdentity } from '../../src/domain/principal.js';
import type { RequestContext } from '../../src/domain/request-context.js';
import type { IdentityProvider } from '../../src/ports/identity-provider.js';

export interface IdentityProviderContractOptions {
  readonly name: string;
  readonly getProvider: () => IdentityProvider;
  readonly getRequestContext: () => RequestContext;
  readonly getValidToken: () => Promise<string>;
  readonly expectedIdentity: () => VerifiedExternalIdentity;
}

export function identityProviderContract(
  options: IdentityProviderContractOptions,
): void {
  describe(`${options.name} IdentityProvider contract`, () => {
    it('returns only verified normalized external claims', async () => {
      const identity = await options
        .getProvider()
        .verify(await options.getValidToken(), options.getRequestContext());

      expect(identity).toEqual(options.expectedIdentity());
      expect(identity).not.toHaveProperty('role');
      expect(identity).not.toHaveProperty('user');
    });

    it('rejects a malformed credential with a stable safe error', async () => {
      const error = await options
        .getProvider()
        .verify('not-a-jwt', options.getRequestContext())
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'unauthenticated',
        retryable: false,
        details: { reason: 'identity_verification_failed' },
      });
      expect(JSON.stringify(error)).not.toContain('not-a-jwt');
    });
  });
}
