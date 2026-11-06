import {
  SignJWT,
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
} from 'jose';
import type { CryptoKey, JWTVerifyGetKey, LocalJWKSet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { GoogleOidcIdentityProvider } from '../../../src/adapters/identity/google-oidc-identity-provider.js';
import { requestId } from '../../../src/domain/identifiers.js';
import type { RequestContext } from '../../../src/domain/request-context.js';
import { identityProviderContract } from '../../contract/identity-provider.contract.js';

const canonicalIssuer = 'https://accounts.google.com';
const legacyIssuer = 'accounts.google.com';
const audience = 'synthetic-gateway-client.example.invalid';
const hostedDomain = 'example.invalid';
const keyId = 'synthetic-google-key-1';
const now = new Date('2042-04-05T06:07:08.000Z');
const nowEpoch = Math.floor(now.getTime() / 1_000);

let signingKey: CryptoKey;
let wrongSigningKey: CryptoKey;
let keyResolver: LocalJWKSet;

interface TokenOverrides {
  readonly issuer?: string;
  readonly tokenAudience?: string | readonly string[];
  readonly subject?: string | null;
  readonly email?: string | null;
  readonly emailVerified?: boolean | string;
  readonly tokenHostedDomain?: string | null;
  readonly expirationTime?: number | null;
  readonly issuedAt?: number | null;
  readonly authorizedParty?: string | null;
  readonly tokenType?: string;
  readonly key?: CryptoKey;
}

function requestContext(): RequestContext {
  return {
    requestId: requestId('req_synthetic_oidc_001'),
    receivedAt: now,
    clientId: 'forged-request-client',
  };
}

async function token(overrides: TokenOverrides = {}): Promise<string> {
  const tokenAudience = overrides.tokenAudience ?? audience;
  const payload: Record<string, unknown> = {
    email_verified: overrides.emailVerified ?? true,
  };
  if (overrides.email !== null) {
    payload['email'] = overrides.email ?? 'operator@example.invalid';
  }
  if (overrides.tokenHostedDomain !== null) {
    payload['hd'] = overrides.tokenHostedDomain ?? hostedDomain;
  }
  if (overrides.authorizedParty !== null) {
    payload['azp'] = overrides.authorizedParty ?? audience;
  }

  let builder = new SignJWT(payload)
    .setProtectedHeader({
      alg: 'RS256',
      kid: keyId,
      typ: overrides.tokenType ?? 'JWT',
    })
    .setIssuer(overrides.issuer ?? canonicalIssuer)
    .setAudience(
      typeof tokenAudience === 'string' ? tokenAudience : [...tokenAudience],
    );

  if (overrides.issuedAt !== null) {
    builder = builder.setIssuedAt(overrides.issuedAt ?? nowEpoch - 60);
  }

  if (overrides.subject !== null) {
    builder = builder.setSubject(
      overrides.subject ?? 'synthetic-subject-operator',
    );
  }
  if (overrides.expirationTime !== null) {
    builder = builder.setExpirationTime(
      overrides.expirationTime ?? nowEpoch + 300,
    );
  }
  return builder.sign(overrides.key ?? signingKey);
}

describe('GoogleOidcIdentityProvider', () => {
  beforeAll(async () => {
    const primary = await generateKeyPair('RS256', { extractable: true });
    const wrong = await generateKeyPair('RS256', { extractable: true });
    signingKey = primary.privateKey;
    wrongSigningKey = wrong.privateKey;

    const publicJwk = await exportJWK(primary.publicKey);
    publicJwk.kid = keyId;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    keyResolver = createLocalJWKSet({ keys: [publicJwk] });
  });

  function provider(
    resolver: JWTVerifyGetKey = keyResolver,
  ): GoogleOidcIdentityProvider {
    return new GoogleOidcIdentityProvider({
      issuer: canonicalIssuer,
      audience,
      hostedDomain,
      keyResolver: resolver,
    });
  }

  identityProviderContract({
    name: 'Google OIDC',
    getProvider: provider,
    getRequestContext: () =>
      ({
        ...requestContext(),
        user: 'steward',
      }) as RequestContext,
    getValidToken: token,
    expectedIdentity: () => ({
      issuer: canonicalIssuer,
      externalSubject: 'synthetic-subject-operator',
      email: 'operator@example.invalid',
      clientId: audience,
      authenticatedAt: now,
    }),
  });

  it.each([canonicalIssuer, legacyIssuer])(
    'accepts and canonicalizes the supported Google issuer %s',
    async (issuer) => {
      await expect(
        provider().verify(await token({ issuer }), requestContext()),
      ).resolves.toMatchObject({ issuer: canonicalIssuer });
    },
  );

  it.each([
    ['wrong issuer', { issuer: 'https://accounts.example.invalid' }],
    ['wrong audience', { tokenAudience: 'different-client.example.invalid' }],
    ['expired token', { expirationTime: nowEpoch - 1 }],
    ['wrong hosted domain', { tokenHostedDomain: 'other.example.invalid' }],
    ['missing hosted domain', { tokenHostedDomain: null }],
    ['unverified email', { emailVerified: false }],
    ['non-boolean email verification', { emailVerified: 'true' }],
    ['missing email', { email: null }],
    ['missing subject', { subject: null }],
    ['missing expiration', { expirationTime: null }],
    ['missing issued-at time', { issuedAt: null }],
    ['future issued-at time', { issuedAt: nowEpoch + 1 }],
    [
      'expiration before issued-at time',
      { issuedAt: nowEpoch + 240, expirationTime: nowEpoch + 120 },
    ],
    ['wrong token type', { tokenType: 'at+jwt' }],
    ['wrong authorized party', { authorizedParty: 'other-client.invalid' }],
    [
      'multiple audiences',
      { tokenAudience: [audience, 'other-client.invalid'] },
    ],
  ] as const)('rejects %s', async (_name, overrides) => {
    await expect(
      provider().verify(await token(overrides), requestContext()),
    ).rejects.toMatchObject({
      code: 'unauthenticated',
      retryable: false,
      details: { reason: 'identity_verification_failed' },
    });
  });

  it('rejects a token signed by an untrusted key', async () => {
    await expect(
      provider().verify(
        await token({ key: wrongSigningKey }),
        requestContext(),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects an oversized credential before invoking the key resolver', async () => {
    let resolverCalled = false;
    const observingResolver: JWTVerifyGetKey = () => {
      resolverCalled = true;
      return Promise.reject(new Error('must not run'));
    };

    await expect(
      provider(observingResolver).verify('x'.repeat(16_385), requestContext()),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(resolverCalled).toBe(false);
  });

  it('rejects a non-Google issuer in deployment configuration', () => {
    expect(
      () =>
        new GoogleOidcIdentityProvider({
          issuer: 'https://accounts.example.invalid',
          audience,
          hostedDomain,
          keyResolver,
        }),
    ).toThrow('invalid_google_oidc_configuration');
  });

  it('reports a JWKS timeout as a retryable provider outage without leaking the token', async () => {
    const unavailableResolver: JWTVerifyGetKey = () =>
      Promise.reject(new errors.JWKSTimeout('synthetic timeout'));
    const signedToken = await token();
    const error = await provider(unavailableResolver)
      .verify(signedToken, requestContext())
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { provider: 'google_oidc', reason: 'jwks_timeout' },
    });
    expect(JSON.stringify(error)).not.toContain(signedToken);
  });
});
