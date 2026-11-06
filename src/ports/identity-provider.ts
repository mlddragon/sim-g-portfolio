import type { VerifiedExternalIdentity } from '../domain/principal.js';
import type { RequestContext } from '../domain/request-context.js';

/** Verifies an external credential and returns only normalized proven claims. */
export interface IdentityProvider {
  verify(
    token: string,
    requestContext: RequestContext,
  ): Promise<VerifiedExternalIdentity>;
}
