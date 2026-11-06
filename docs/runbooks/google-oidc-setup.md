# Google OIDC setup and principal onboarding

Google Workspace identity establishes the human caller. It never supplies
provider credentials and it never bypasses Brain authorization. The gateway
accepts a Google ID token only after verifying its signature and all required
deployment constraints, then maps the immutable issuer/subject pair through
PostgreSQL to one server-owned Brain principal.

## Trust and data model

- Configure the canonical issuer as `https://accounts.google.com`. Google may
  emit either that issuer or `accounts.google.com`; the adapter accepts both and
  normalizes both to the canonical HTTPS value before lookup.
- Use the ID token `sub` claim as the durable external identity. Do not bind by
  email address, name, request metadata, or Google user profile fields.
- Require the exact environment-specific OAuth client ID as the single `aud`
  claim. If `azp` is present, it must equal that client ID too.
- Require `email_verified=true` and an exact configured Workspace `hd` claim.
  Email remains display/diagnostic metadata only.
- Verify `RS256`, `typ=JWT`, expiry, issue time, and signature using Google's
  fixed HTTPS JWKS endpoint. Never accept a caller-supplied key URL.
- Treat the bearer ID token as a credential: never persist it, log it, place it
  in a URL, fixture, shell history, issue, or chat message.

The adapter follows Google's current
[OpenID Connect guidance](https://developers.google.com/identity/openid-connect/openid-connect)
and the [`jose` JWT verification contract](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md).

## Environment separation

Create separate OAuth clients for development and production. At minimum, each
environment has a distinct client ID/audience and exact redirect URI set. Dev
authorization must not be accepted by prod, and a development token must never
gain access to production provider identities or roots.

Local ignored configuration uses:

```text
GOOGLE_OIDC_ISSUER=https://accounts.google.com
GOOGLE_OIDC_AUDIENCE=environment-specific-client-id
GOOGLE_HOSTED_DOMAIN=workspace-domain.example
```

Do not replace the audience with a client secret. Browser/native clients should
use authorization code with PKCE and a fresh nonce. The initiating client must
validate its returned flow state and nonce; the gateway independently verifies
the signed ID token, issuer, audience, time claims, and hosted domain on every
request. Refresh tokens, when a client genuinely needs them, remain in that
client's secure credential store and are never sent to or stored by the
gateway.

## Controlled onboarding

Live subjects are intentionally not present in source control or seed
migrations. F14 onboarding performs these steps separately in dev and prod:

1. Confirm the intended person is signed into their own Example Workspace
   account and complete the approved OAuth flow.
2. Pass the ID token directly to the configured gateway verification path over
   HTTPS. Do not copy it into an issue, document, or terminal transcript.
3. Record the adapter-normalized canonical issuer, immutable `sub`, and verified
   email in the target environment's `identity_bindings` table. Map only to the
   already seeded principal (`prn_operator`, `prn_steward`, or `prn_participant`).
4. Read the binding back by issuer plus subject and verify the expected
   principal, enabled state, and environment.
5. Authenticate again and confirm the gateway returns that server-owned
   principal even if untrusted request metadata names another user.
6. Complete the role-specific authorization acceptance checks before enabling
   the next family member.

Use an explicit insert inside a transaction. A uniqueness conflict is a
security-relevant condition to investigate; never use an upsert that silently
moves an existing subject to a different principal. The runtime service does
not expose a public binding-management API.

For a synthetic dev binding, the shape is:

```sql
BEGIN;

INSERT INTO identity_bindings (
  id,
  principal_id,
  issuer,
  external_subject,
  email,
  enabled
)
VALUES (
  'idn_synthetic_dev_operator',
  'prn_operator',
  'https://accounts.google.com',
  'synthetic-dev-subject',
  'synthetic@example.invalid',
  true
);

COMMIT;
```

Never reuse this fictional row in production. Real onboarding values are
supplied out of band at execution time and must not be added to repository
documentation, migrations, tests, or logs.

## Disable and recovery procedure

If an account or binding may be compromised, first set the binding's `enabled`
state to false in the affected environment and confirm authentication now
returns the generic `identity_not_authorized` response. Disabling a principal
also blocks every one of its bindings. Rebinding requires a fresh controlled
onboarding review; do not edit a subject in place or infer a replacement from
email.

Unknown subjects, disabled bindings, and disabled principals deliberately
produce the same non-enumerating response. If the principal store itself is unreachable
(for example, PostgreSQL restarting), authentication still fails closed but
answers a retryable `503 provider_unavailable` with reason
`principal_state_unavailable`, never `500` and never a misleading `401`. Invalid signatures or claims produce
`identity_verification_failed`. A Google JWKS timeout produces the retryable
`provider_unavailable` code without returning token or claim contents.

## Verification without live accounts

Routine tests generate an ephemeral local RSA key pair and never call Google or
use household identity data:

```bash
pnpm vitest run tests/unit/identity/google-oidc-identity-provider.test.ts \
  tests/unit/application/authentication-service.test.ts
```

Live development and production OAuth checks remain blocked until the owner
provides the corresponding Workspace domain, client IDs and redirect URIs, and
the three family members complete controlled subject onboarding. Production
must not be enabled merely to make a development integration test pass.
