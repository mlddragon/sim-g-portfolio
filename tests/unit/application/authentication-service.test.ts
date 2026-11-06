import { describe, expect, it } from 'vitest';

import { AuthenticationService } from '../../../src/application/authentication-service.js';
import { principalId, requestId } from '../../../src/domain/identifiers.js';
import type {
  BrainPrincipal,
  VerifiedExternalIdentity,
} from '../../../src/domain/principal.js';
import type { RequestContext } from '../../../src/domain/request-context.js';
import type { IdentityProvider } from '../../../src/ports/identity-provider.js';
import type { PrincipalIdentityBinding } from '../../../src/ports/operational-state-store.js';

const receivedAt = new Date('2042-04-05T06:07:08.000Z');

function requestContext(): RequestContext {
  return {
    requestId: requestId('req_synthetic_authentication_001'),
    receivedAt,
    clientId: 'untrusted-request-client',
  };
}

function verifiedIdentity(
  externalSubject: string,
  email = 'verified@example.invalid',
): VerifiedExternalIdentity {
  return {
    issuer: 'https://accounts.google.com',
    externalSubject,
    email,
    clientId: 'verified-oidc-client',
    authenticatedAt: receivedAt,
  };
}

function provider(identity: VerifiedExternalIdentity): IdentityProvider {
  return {
    verify: () => Promise.resolve(identity),
  };
}

function binding(
  principal: BrainPrincipal,
  externalSubject: string,
  enabled = true,
): PrincipalIdentityBinding {
  return {
    principal,
    issuer: 'https://accounts.google.com',
    externalSubject,
    email: 'historical-binding-email@example.invalid',
    enabled,
  };
}

const principalCases = [
  {
    externalSubject: 'synthetic-subject-operator',
    principal: {
      id: principalId('prn_operator'),
      key: 'operator',
      displayName: 'Operator',
      role: 'owner_operator',
      status: 'active',
    },
  },
  {
    externalSubject: 'synthetic-subject-steward',
    principal: {
      id: principalId('prn_steward'),
      key: 'steward',
      displayName: 'Steward',
      role: 'parent_steward',
      status: 'active',
    },
  },
  {
    externalSubject: 'synthetic-subject-participant',
    principal: {
      id: principalId('prn_participant'),
      key: 'participant',
      displayName: 'Participant',
      role: 'family_participant',
      status: 'active',
    },
  },
] as const satisfies readonly {
  readonly externalSubject: string;
  readonly principal: BrainPrincipal;
}[];

describe('AuthenticationService', () => {
  it.each(principalCases)(
    'maps verified subject for $principal.key to the server-owned principal',
    async ({ externalSubject, principal }) => {
      const identity = verifiedIdentity(externalSubject);
      let observedLookup: unknown;
      const service = new AuthenticationService(provider(identity), {
        findPrincipalByExternalIdentity: (lookup) => {
          observedLookup = lookup;
          return Promise.resolve(binding(principal, externalSubject));
        },
      });

      await expect(
        service.authenticate('synthetic-signed-token', requestContext()),
      ).resolves.toEqual({
        principal,
        identity: {
          ...identity,
          principalId: principal.id,
        },
      });
      expect(observedLookup).toEqual({
        issuer: identity.issuer,
        externalSubject,
      });
    },
  );

  it('fails closed but retryably when the principal store is unreachable', async () => {
    const identity = verifiedIdentity('synthetic-subject-store-outage');
    const service = new AuthenticationService(provider(identity), {
      // A dropped database connection surfaces as a raw driver error.
      findPrincipalByExternalIdentity: () =>
        Promise.reject(new Error('synthetic connection terminated')),
    });

    const attempt = service.authenticate('synthetic.token', requestContext());

    await expect(attempt).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'principal_state_unavailable' },
    });
    await expect(attempt).rejects.not.toThrow(
      'synthetic connection terminated',
    );
  });

  it('ignores forged client-declared user metadata and never maps by email', async () => {
    const identity = verifiedIdentity(
      'synthetic-subject-operator',
      'steward@example.invalid',
    );
    const operator = principalCases[0].principal;
    const service = new AuthenticationService(provider(identity), {
      findPrincipalByExternalIdentity: () =>
        Promise.resolve(binding(operator, identity.externalSubject)),
    });
    const forgedContext = {
      ...requestContext(),
      user: 'steward',
      role: 'parent_steward',
      email: 'steward@example.invalid',
    } as RequestContext;

    const authenticated = await service.authenticate(
      'synthetic-signed-token',
      forgedContext,
    );

    expect(authenticated.principal.id).toBe(principalId('prn_operator'));
    expect(authenticated.identity.email).toBe('steward@example.invalid');
    expect(authenticated).not.toHaveProperty('user');
  });

  it('fails closed if a state adapter returns a binding for a different immutable subject', async () => {
    const identity = verifiedIdentity('synthetic-subject-operator');
    const service = new AuthenticationService(provider(identity), {
      findPrincipalByExternalIdentity: () =>
        Promise.resolve(
          binding(principalCases[0].principal, 'different-subject'),
        ),
    });

    await expect(
      service.authenticate('synthetic-signed-token', requestContext()),
    ).rejects.toMatchObject({
      code: 'unauthenticated',
      retryable: false,
      details: { reason: 'identity_not_authorized' },
    });
  });

  it.each([
    ['unknown subject', null],
    [
      'disabled binding',
      binding(principalCases[1].principal, 'synthetic-subject-steward', false),
    ],
    [
      'disabled principal',
      binding(
        { ...principalCases[2].principal, status: 'disabled' },
        'synthetic-subject-participant',
      ),
    ],
  ] as const)(
    'rejects an %s with the same non-enumerating error',
    async (_name, storedBinding) => {
      const identity = verifiedIdentity('synthetic-subject-unknown');
      const service = new AuthenticationService(provider(identity), {
        findPrincipalByExternalIdentity: () => Promise.resolve(storedBinding),
      });

      await expect(
        service.authenticate('synthetic-signed-token', requestContext()),
      ).rejects.toMatchObject({
        code: 'unauthenticated',
        retryable: false,
        details: { reason: 'identity_not_authorized' },
      });
    },
  );
});
