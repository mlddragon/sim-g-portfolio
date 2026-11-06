import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';

import { DomainError } from '../../domain/errors.js';
import type { VerifiedExternalIdentity } from '../../domain/principal.js';
import type { RequestContext } from '../../domain/request-context.js';
import type { IdentityProvider } from '../../ports/identity-provider.js';

const canonicalGoogleIssuer = 'https://accounts.google.com';
const legacyGoogleIssuer = 'accounts.google.com';
const googleJwksUrl = new URL('https://www.googleapis.com/oauth2/v3/certs');
const maximumTokenLength = 16_384;

export interface GoogleOidcIdentityProviderOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly hostedDomain: string;
  readonly keyResolver?: JWTVerifyGetKey;
}

interface GoogleIdTokenClaims {
  readonly iss?: unknown;
  readonly sub?: unknown;
  readonly aud?: unknown;
  readonly azp?: unknown;
  readonly exp?: unknown;
  readonly iat?: unknown;
  readonly email?: unknown;
  readonly email_verified?: unknown;
  readonly hd?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function unauthenticated(): DomainError {
  return new DomainError('unauthenticated', false, {
    reason: 'identity_verification_failed',
  });
}

/** Strictly verifies Google Workspace ID tokens without performing local role mapping. */
export class GoogleOidcIdentityProvider implements IdentityProvider {
  private readonly audience: string;
  private readonly hostedDomain: string;
  private readonly keyResolver: JWTVerifyGetKey;

  constructor(options: GoogleOidcIdentityProviderOptions) {
    if (
      options.issuer !== canonicalGoogleIssuer ||
      options.audience.length === 0 ||
      options.hostedDomain.length === 0
    ) {
      throw new TypeError('invalid_google_oidc_configuration');
    }

    this.audience = options.audience;
    this.hostedDomain = options.hostedDomain;
    this.keyResolver =
      options.keyResolver ??
      createRemoteJWKSet(googleJwksUrl, {
        timeoutDuration: 5_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
      });
  }

  async verify(
    token: string,
    requestContext: RequestContext,
  ): Promise<VerifiedExternalIdentity> {
    if (token.length === 0 || token.length > maximumTokenLength) {
      throw unauthenticated();
    }

    try {
      const verified = await jwtVerify<GoogleIdTokenClaims>(
        token,
        this.keyResolver,
        {
          algorithms: ['RS256'],
          issuer: [canonicalGoogleIssuer, legacyGoogleIssuer],
          audience: this.audience,
          typ: 'JWT',
          currentDate: requestContext.receivedAt,
          requiredClaims: [
            'sub',
            'exp',
            'iat',
            'email',
            'email_verified',
            'hd',
          ],
        },
      );
      const claims = verified.payload;
      const authenticatedAtEpoch = Math.floor(
        requestContext.receivedAt.getTime() / 1_000,
      );

      if (
        !isNonEmptyString(claims.sub) ||
        !isNonEmptyString(claims.email) ||
        claims.email_verified !== true ||
        claims.hd !== this.hostedDomain ||
        claims.aud !== this.audience ||
        (claims.azp !== undefined && claims.azp !== this.audience) ||
        typeof claims.exp !== 'number' ||
        !Number.isFinite(claims.exp) ||
        typeof claims.iat !== 'number' ||
        !Number.isFinite(claims.iat) ||
        claims.iat > authenticatedAtEpoch ||
        claims.exp <= claims.iat
      ) {
        throw unauthenticated();
      }

      return {
        issuer: canonicalGoogleIssuer,
        externalSubject: claims.sub,
        email: claims.email,
        clientId: this.audience,
        authenticatedAt: new Date(requestContext.receivedAt.getTime()),
      };
    } catch (error: unknown) {
      if (error instanceof DomainError) {
        throw error;
      }
      if (error instanceof errors.JWKSTimeout) {
        throw new DomainError('provider_unavailable', true, {
          provider: 'google_oidc',
          reason: 'jwks_timeout',
        });
      }
      throw unauthenticated();
    }
  }
}
