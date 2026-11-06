import { DomainError } from '../domain/errors.js';
import type { AuthenticatedPrincipal } from '../domain/principal.js';
import type { RequestContext } from '../domain/request-context.js';
import type { IdentityProvider } from '../ports/identity-provider.js';
import type { OperationalStateStore } from '../ports/operational-state-store.js';

export type PrincipalBindingStore = Pick<
  OperationalStateStore,
  'findPrincipalByExternalIdentity'
>;

/**
 * Establishes the internal principal only after credential verification.
 * External email and request metadata are deliberately absent from the lookup key.
 */
export class AuthenticationService {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly stateStore: PrincipalBindingStore,
  ) {}

  async authenticate(
    token: string,
    requestContext: RequestContext,
  ): Promise<AuthenticatedPrincipal> {
    const verifiedIdentity = await this.identityProvider.verify(
      token,
      requestContext,
    );
    let binding: Awaited<
      ReturnType<PrincipalBindingStore['findPrincipalByExternalIdentity']>
    >;
    try {
      binding = await this.stateStore.findPrincipalByExternalIdentity({
        issuer: verifiedIdentity.issuer,
        externalSubject: verifiedIdentity.externalSubject,
      });
    } catch (error) {
      // Still fail closed, but as a retryable outage rather than an internal
      // error: an unreachable database is not a bad credential.
      if (error instanceof DomainError) throw error;
      throw new DomainError('provider_unavailable', true, {
        reason: 'principal_state_unavailable',
      });
    }

    if (
      binding === null ||
      !binding.enabled ||
      binding.principal.status !== 'active' ||
      binding.issuer !== verifiedIdentity.issuer ||
      binding.externalSubject !== verifiedIdentity.externalSubject
    ) {
      throw new DomainError('unauthenticated', false, {
        reason: 'identity_not_authorized',
      });
    }

    return {
      principal: binding.principal,
      identity: {
        ...verifiedIdentity,
        principalId: binding.principal.id,
      },
    };
  }
}
