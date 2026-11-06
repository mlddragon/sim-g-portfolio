# SIM-G ChatGPT connector design (Task 14b)

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

**Owner:** Operator
**Date:** 2026-11-05
**Status:** Proposed Engineering Design amendment. An independent security
review was held on 2026-11-05; this revision addresses its 12 findings
(section 14). The amendment awaits the owner's approval. No code,
credential, cloud or ChatGPT workspace change is authorized by this
document.
**Amends:** Engineering Design sections 3, 4.1, 4.2, 9, 15, 16, 18, 19, 22
and 23, and the first `SECURITY.md` invariant (section 11 lists the exact
wording). Every other PRD, Engineering Design, hosting-addendum and
`SECURITY.md` requirement still binds.
**Plan:** [Task 14 production plan](2026-11-05-task-14-production-plan.md),
slice 14b. Owner rulings D1 (ChatGPT on the phone first) and D10 (one ChatGPT
Business workspace) are its inputs.

## 1. Problem

Operator, Steward and Participant use ChatGPT, mostly on their phones, as members of
one ChatGPT Business workspace that Operator administers. ChatGPT reaches custom
services only through a plugin built from a remote MCP server, and it
authenticates to that server only with OAuth 2.1 (authorization code with
PKCE). There is no option for a static key, a client-declared user, or a
Google ID token passed through.

Today the gateway accepts exactly one credential: a Google Workspace ID token
whose audience is the gateway's Google OAuth client (Engineering Design 4.2,
`GoogleOidcIdentityProvider`). ChatGPT cannot obtain one:

- Google supports neither Client ID Metadata Documents nor Dynamic Client
  Registration for ChatGPT to register itself.
- ChatGPT would hold a Google access token, which is opaque to the gateway.
- Registering ChatGPT directly as a Google client would make a token minted
  for ChatGPT's use valid for every Google API in its scope, the opposite of
  the narrow surface the gateway exists to provide.

So the gateway must add two things:

1. **An MCP endpoint** that exposes exactly the eight Brain operations as
   tools.
2. **A small OAuth authorization server, for ChatGPT only.** It signs the
   person in with Google, verifies the result with the existing verifier and
   principal binding, and only then issues its own short-lived token, bound
   to that person and to the MCP endpoint.

## 2. Requirements this design must meet

From the PRD and existing design (unchanged):

- **R1 Identity.** Every Brain operation acts as one verified human. Identity
  comes from Google Workspace OIDC through the immutable issuer and subject
  binding, never from anything ChatGPT or the model declares. No shared
  family credentials (PRD 6).
- **R2 No anonymous Brain operation.** Unauthenticated endpoints may exist
  only where OAuth requires them, and none touches Brain content or
  operational state beyond the sign-in flow itself.
- **R3 Narrow surface.** Exactly `search_brain`, `fetch_record`,
  `persist_knowledge`, `update_record`, `append_to_record`, `delete_record`,
  `list_approvals` and `resolve_approval`. Never a generic provider proxy, no
  raw provider operations, no `move_record`.
- **R4 Same enforcement.** MCP calls run through the same
  `AuditedBrainOperations` path as the HTTP routes, with the same
  authorization, routing, approvals, elevation rules, idempotency, audit and
  rate limits. Participant's Family Shared limit and 15-minute rule apply
  unchanged. One deliberate difference: on `/mcp`, elevation and approval
  are confirmed by the person in a browser, never by the model (section 4).
- **R5 Operational state only.** PostgreSQL gains only OAuth state (hashes,
  bindings, expiry). Secrets are never logged or returned.
- **R6 Dev cannot mutate prod.** Separate issuers, Google clients, ChatGPT
  apps, secrets and databases per environment.
- **R7 Budget.** No new always-on resource. Cost stays inside the e2-micro
  model.

From ChatGPT's documented requirements (sources in section 13):

- **R8** A streamable HTTP MCP endpoint at a stable public HTTPS URL
  (`/mcp`).
- **R9** Protected resource metadata at
  `/.well-known/oauth-protected-resource`, naming the authorization server,
  and a `401` with `WWW-Authenticate: Bearer resource_metadata="…"` when no
  valid token is presented.
- **R10** Authorization server metadata at
  `/.well-known/oauth-authorization-server`, listing `S256` in
  `code_challenge_methods_supported`, plus the token endpoint auth methods
  the server accepts.
- **R11** ChatGPT sends `resource` (the MCP URL) on authorization and token
  requests. The issued token must be bound to it, and the server must reject
  tokens for any other audience.
- **R12** Tool annotations (`readOnlyHint`, `destructiveHint`,
  `openWorldHint`) inform ChatGPT's confirmations. They never replace
  server-side authorization.
- **R13** Published tool names and schemas stay backward compatible.

## 3. Shape

```mermaid
sequenceDiagram
    autonumber
    participant P as Person (ChatGPT web or phone)
    participant C as ChatGPT (OpenAI servers)
    participant G as Gateway /oauth and /mcp
    participant GG as Google accounts
    C->>G: GET /mcp without token
    G-->>C: 401 + resource_metadata URL
    C->>G: GET both .well-known metadata documents
    P->>G: GET /oauth/authorize (client_id, redirect_uri, state, PKCE, resource)
    G->>G: validate client, exact redirect, S256, resource; store request
    G-->>P: redirect to Google (own state, nonce, PKCE, hd, select_account)
    P->>GG: choose Workspace account, sign in
    GG-->>P: redirect to /oauth/google/callback (code, state)
    P->>G: callback
    G->>GG: exchange code (server to server, client secret, PKCE)
    G->>G: verify ID token (existing verifier + nonce), map principal
    G-->>P: consent page: "Connect ChatGPT as Steward?"
    P->>G: POST allow (CSRF token)
    G-->>P: redirect to ChatGPT redirect_uri (code, state)
    C->>G: POST /oauth/token (client auth, code, verifier, resource)
    G-->>C: access token 15 min + rotating refresh token
    C->>G: POST /mcp tools/call (Bearer access token)
    G->>G: token → grant → principal → AuditedBrainOperations
```

New public paths, all on the existing TLS server behind nginx:

| Path                                          | Auth                                                      | Purpose                                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /mcp`                                   | Gateway access token                                      | MCP JSON-RPC: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`                                                                      |
| `GET /.well-known/oauth-protected-resource`   | None (static metadata)                                    | R9                                                                                                                                                               |
| `GET /.well-known/oauth-authorization-server` | None (static metadata)                                    | R10                                                                                                                                                              |
| `GET /oauth/authorize`                        | None; starts sign-in                                      | Validates ChatGPT's request, sends the browser to Google                                                                                                         |
| `GET /oauth/google/callback`                  | Google code + browser binding                             | The one Google return path for both flows. It verifies the person, then shows consent or the confirm page, according to the purpose stored with Google's `state` |
| `POST /oauth/consent`                         | Browser binding + CSRF token                              | Allow or cancel                                                                                                                                                  |
| `POST /oauth/token`                           | ChatGPT client authentication                             | Code and refresh-token exchange                                                                                                                                  |
| `GET /confirm/<confirmation ID>`              | None; starts sign-in                                      | Starts a browser confirmation of an elevated operation or an approval (section 4)                                                                                |
| `POST /confirm`                               | Google sign-in + `__Host-fbg_confirm` cookie + CSRF token | Confirm or cancel                                                                                                                                                |

`GET /mcp` and `DELETE /mcp` return `405`.

**Form bodies:** the app today parses only JSON. A form parser for
`application/x-www-form-urlencoded` is added only on `POST /oauth/token`,
`POST /oauth/consent` and `POST /confirm`, with a 4 KiB limit. Repeated
parameters are rejected there, and in the query strings of the `GET` paths,
so a value is never chosen from an array.

The existing `/v1/operations/*`
routes and their Google ID token authentication stay as they are, for
non-ChatGPT clients and the acceptance suite.

## 4. MCP endpoint

- **Transport:** MCP streamable HTTP, stateless. Every `POST /mcp` carries
  one JSON-RPC request or notification and gets a single `application/json`
  response. The server never opens an SSE stream and never issues
  `Mcp-Session-Id`, so a restart or a second process loses nothing.
  Batches are rejected. Protocol versions: `2025-03-26`, `2025-06-18` and
  `2025-11-25`. `initialize` returns the client's version if it is on that
  list, and otherwise the newest. With no stored session, later requests are
  checked only against the list. A missing `MCP-Protocol-Version` header
  means `2025-03-26`, as the specification says. Under `2025-03-26`, results
  carry `content` only, because `structuredContent` came later.
- **Implementation (engineering ruling, for review):** a small hand-written
  JSON-RPC handler on the existing Fastify app, not the MCP SDK's server
  transport. It needs five methods, and the SDK would bring a second HTTP
  stack and its dependencies into the trusted path. The official
  `@modelcontextprotocol/sdk` client is added as a dev dependency only, so
  contract tests prove conformance against it.
- **Order of checks:**
  1. `Origin`: allowed only when absent, or exactly `https://chatgpt.com` if
     14f shows ChatGPT's backend sends that. Anything else is rejected,
     which closes DNS rebinding and browser calls.
  2. The bearer token, before the body is parsed, as the HTTP routes do
     today.
  3. JSON-RPC shape.
  4. The tool's existing Zod body schema.
- **Each route takes one credential type.** `/mcp` accepts only gateway
  access tokens. `/v1/operations/*` accepts only Google ID tokens. Neither
  verifier is tried on the other's routes.
- **Tools:** one per operation. The input schema is the existing request
  body schema (`src/api/schemas`), published as JSON Schema. The result's
  `structuredContent` is the existing contract projection of the response;
  `content` carries the same JSON as text for the model. Nothing goes in
  `_meta`. Domain errors become tool results with `isError: true` and
  `structuredContent: { error: { code, retryable, details } }`, using the
  existing error model and its no-leak rules.
- **A missing, expired or revoked token** always gets an HTTP `401`, because
  authentication runs before the body is read:
  `WWW-Authenticate: Bearer resource_metadata="…", error="invalid_token", error_description="…"`.
  The tool-level `_meta["mcp/www_authenticate"]` path is not used. 14f
  confirms that ChatGPT offers to reconnect on this `401`.
- **Every successful result includes `actingAs`**, the principal's display
  name, so a conversation always shows whose Brain access it is using
  (section 5.3, cross-account linking).
- **Annotations and security schemes:** every tool declares
  `securitySchemes: [{ type: "oauth2", scopes: ["family_brain"] }]`; no tool
  allows `noauth`. `openWorldHint: false` on all eight, since they reach only
  the family's governed roots.

  | Tool                                                 | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
  | ---------------------------------------------------- | :------------: | :---------------: | :--------------: |
  | `search_brain`, `fetch_record`, `list_approvals`     |      true      |       false       |       true       |
  | `persist_knowledge`, `append_to_record`              |     false      |       false       |       true       |
  | `update_record`, `delete_record`, `resolve_approval` |     false      |       true        |       true       |

  `update_record` is destructive because it overwrites content and the
  gateway has no restore tool. Provider history is not something the family
  can use through ChatGPT. `resolve_approval` is destructive because
  approving can execute a pending delete.

- **Idempotency:** the mutation tools keep the required client `requestId`.
  The tool description tells the model to create a new random value for each
  intended change and to reuse it only when retrying that same change. The
  operation ID stays derived from the verified principal, the operation and
  the request ID, so a model-chosen value can never reach another person's
  operation. A reused value with a different payload is an
  `idempotency_conflict`, never a silent overwrite. A reused value with the
  same payload returns the first outcome, which is the intended retry
  behavior.
- **Human confirmation, outside the model (changed by the security
  review).** Over HTTP, the gateway returns the elevation confirmation token
  to the caller. Every mutation (`persist_knowledge`, `update_record`,
  `append_to_record` and `delete_record`) can return `elevation_required`
  and accept an `elevation` object (`src/api/schemas/mutations.ts`; F11c and
  F11i). Through ChatGPT, the caller is the model. A model steered by
  injected text could receive the token and send it straight back, with no
  human step. PRD 12 requires Operator or Steward to elevate explicitly, and
  Engineering Design 12 forbids inferring elevated consent. So on `/mcp`:
  - **The token never appears in a tool result.** Any `elevation_required`
    result, from any of the four mutations, returns only:
    - the challenge ID;
    - its expiry;
    - a confirm link, `https://<host>/confirm/<confirmation ID>`;
    - a sentence telling the person to open the link and check that the host
      is the family's gateway.
  - **The MCP input schemas accept only the challenge ID.** Their `elevation`
    object has `challengeId` alone. `confirmationToken` is not in any MCP
    schema and is rejected if sent.
  - **The person confirms in a browser.** They open the link (on the phone,
    a browser sheet), sign in with Google (`select_account`, the same web
    client), and must be the principal the challenge belongs to.
  - **The confirm page** is served like the consent page in 5.3. It shows the
    frozen operation: kind, target titles and count, and expiry. **Confirm**
    posts a CSRF token bound to the confirmation request and its own
    `__Host-fbg_confirm` cookie, separate from the linking cookie, so the two
    flows cannot overwrite each other. The challenge is still issued as today, and only its token's hash is
    stored. The raw token is simply never returned on `/mcp`. The browser
    confirmation marks the challenge confirmed, under the same single-use,
    principal-, fingerprint- and policy-bound rules the token check enforces.
  - **The model then retries** the same call with the same `requestId` and
    the challenge ID. The gateway proceeds only if that challenge was
    browser-confirmed by its own principal and has not been used.
  - **Expiry:** challenges issued on `/mcp` last 10 minutes instead of 5, to
    allow the round trip through a phone browser and back. The HTTP routes
    keep 5 minutes.
  - **Approvals:** approving a pending approval with `resolve_approval` needs
    the same browser confirmation. This needs new state, because approvals
    have no challenge today. An approve call on `/mcp` returns
    `confirmation_required` with a link. The confirmer must be the parent who
    called `resolve_approval`, never the requester, and the confirmation is
    bound to that approval ID, the decision and the policy version. The
    retry then resolves. Declining needs no confirmation.
  - **Participant still cannot elevate or approve.**
  - **The cost** is one link and one Google sign-in, only for elevated
    operations and approvals, never for routine writes.
  - **Residual risks:**
    - Injected text could make the model show a lookalike link that phishes
      the person's Google sign-in. Google's own sign-in page, the Internal
      consent screen and the host check on the confirm page limit this.
    - The `/v1` HTTP routes still return the token to their caller. They are
      for non-ChatGPT clients, and that path is unchanged.
  - **Changes in 14e:** the elevation service gains the browser-confirmation
    path. The approval service gains a confirmation record.
- **Limits:** nginx gets an exact `location = /mcp`, with:
  - the same 2 MiB streamed body limit the three content routes have;
  - the `$request_uri` guard `/healthz` uses;
  - the existing per-address and global request limits.

  The gateway applies its per-route body limits by tool, and its
  per-principal and per-client limiters with client ID `chatgpt`.

- **Tool descriptions** state what each tool does and when to use it. They
  never claim a capability the gateway does not enforce. Changing a tool name
  or removing a field is a breaking change, needs an owner-approved release,
  and needs the workspace app refreshed (R13).

## 5. OAuth authorization server

### 5.1 Metadata

Issuer and resource per environment, from server configuration:

- Production: issuer `https://brain.example.invalid`, resource
  `https://brain.example.invalid/mcp`.
- Dev: the dev host's equivalents.

Protected resource metadata contains:

- `resource`: the MCP URL;
- `authorization_servers`: the issuer, as a one-entry list;
- `scopes_supported: ["family_brain"]`.

Authorization server metadata contains:

- the issuer, `authorization_endpoint` and `token_endpoint`;
- `response_types_supported: ["code"]`;
- `grant_types_supported: ["authorization_code", "refresh_token"]`;
- `code_challenge_methods_supported: ["S256"]`;
- `token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"]`;
- `scopes_supported: ["family_brain"]`.

It deliberately omits three things:

- **No `registration_endpoint`:** no Dynamic Client Registration.
- **No CIMD support** (section 5.2). If the CIMD fallback is ever approved,
  the metadata changes with it:
  - `client_id_metadata_document_supported: true`;
  - `private_key_jwt` as the only token endpoint auth method;
  - `token_endpoint_auth_signing_alg_values_supported` listing the
    algorithms ChatGPT's JWKS uses.
- **No `openid`, `email` or `profile` scopes.** The gateway issues no ID
  tokens to ChatGPT and needs no UserInfo endpoint.

### 5.2 Client registration (decides plan D11)

**Recommended: one pre-registered confidential client per environment.**

- The gateway generates a client ID and a 256-bit client secret.
- Operator enters both once in the workspace app's OAuth settings in ChatGPT.
- The gateway keeps only the secret's SHA-256 hash, in Secret Manager, never
  the secret.
- The client's single allowed redirect URI is the exact one ChatGPT shows on
  the app's management page, compared byte for byte.
- Configuration also requires the callback-specific form,
  `https://chatgpt.com/connector/oauth/<callback ID>`. The stable shared
  `connector_platform_oauth_redirect` is refused unless the owner approves an
  exception after 14f.
- **`iss` stays unadvertised on purpose.** ChatGPT uses the shared redirect
  and shared CIMD client only for authorization servers that advertise
  RFC 9207 issuer identification. Leaving it off keeps the family's
  connection on a redirect of its own, which is also the mix-up defense
  (RFC 9700 4.4.2: one redirect URI per authorization server). ChatGPT talks
  to many authorization servers, so the defense is the distinct redirect,
  not the fact that the gateway has one server. Adding `iss` later is a
  design change.

Why a static client rather than CIMD, which OpenAI recommends: ChatGPT's CIMD
client ID is shared by every ChatGPT user (`https://chatgpt.com/oauth/client.json`),
or by every connection to that callback. With CIMD, anyone could create their
own ChatGPT connector pointing at the gateway, start an authorization, and
send the resulting sign-in link to a family member. If the family member
completed it, ChatGPT would attach the family member's Brain access to the
attacker's connector, because ChatGPT ties the code to the connector that
started the flow (consent phishing).

A static client secret held only in the family's workspace app closes that
path. Another connector cannot redeem the code, since it lacks the secret.
The consent page (5.3) and Google's account chooser are a second layer, not
the only one.

**Verification in 14f:** OpenAI mentions predefined clients but does not
document how to set one up. 14f checks that the workspace app accepts a
static client ID and secret, and shows a callback-specific redirect URI.

**Fallback if ChatGPT Business does not accept static credentials:** CIMD,
restricted to the single callback-specific client ID of the family's app
(`https://chatgpt.com/oauth/<callback ID>/client.json`) and its matching
redirect URI, with these conditions:

- **Client authentication is `private_key_jwt`, not `none`**, so a stolen
  refresh token is useless outside ChatGPT. The gateway verifies ChatGPT's
  signed assertion against the JWKS at `https://chatgpt.com/oauth/jwks.json`:
  - `iss` and `sub` equal the client ID;
  - `aud` is the token endpoint or the issuer (ChatGPT's choice is
    unconfirmed, and both are accepted);
  - it has not expired;
  - its `jti` has not been seen before. Each `jti` is kept until the
    assertion expires, in the fallback-only table listed in 5.5.
- **The metadata document and the JWKS URL are pinned in configuration,**
  not fetched and trusted at runtime. The JWKS keys are cached with a short
  lifetime.
- **It is accepted only after 14f shows** that the callback ID is unique to
  the family's app.
- **The shared `client.json` is never accepted.**
- **The fallback needs the owner's approval at that time.**

### 5.3 Authorization request and sign-in

1. **`GET /oauth/authorize`** requires all of:
   - `response_type=code`;
   - the registered `client_id`;
   - the exact `redirect_uri`;
   - `state` (1–512 printable characters);
   - `code_challenge` (43–128 base64url characters) with
     `code_challenge_method=S256`;
   - `resource` equal to the configured MCP URL;
   - `scope` absent or exactly `family_brain`.

   If `client_id` or `redirect_uri` is wrong, the gateway shows a plain error
   page and never redirects. Any other failure goes back to the validated
   redirect URI with an OAuth error code. Nothing is stored and no audit
   event is written until `client_id` and `redirect_uri` are valid. A valid
   request is then stored (5.5) and expires in 10 minutes. Limits:
   - each client address may hold at most 3 unexpired requests;
   - at most 200 may exist in all;
   - over either limit, the oldest request not yet signed in is evicted
     rather than refusing new ones, so a flood cannot lock the family out;
   - linking and confirmation requests have separate pools.

2. **The gateway binds the browser.** It sets a cookie named
   `__Host-fbg_oauth` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no
   `Domain`, 10 minutes) holding a random value. Browsers accept a `__Host-`
   cookie only with `Path=/`. The stored request keeps only that value's
   hash.
3. **The gateway redirects to Google's authorization endpoint** with:
   - its own random `state` and `nonce`;
   - a PKCE S256 challenge;
   - `scope=openid email`;
   - `hd` set to the Example Workspace domain;
   - `prompt=select_account`, so a link someone else sent cannot complete
     without the person choosing their account.

   It uses the environment's Google OAuth web client, whose consent screen is
   set to Internal user type, so only that Workspace's accounts can sign in
   at all (owner check in 14f and 14g).

4. **`GET /oauth/google/callback`** requires:
   - Google's `state` to match an unexpired, unused stored request;
   - the cookie to hash to the same binding.

   The gateway then exchanges the code server to server, with the client
   secret and PKCE verifier, at Google's token endpoint. Google's response
   is used only for its ID token. Google access and refresh tokens are
   discarded at once and never stored.

5. **The ID token goes through the existing `GoogleOidcIdentityProvider`**,
   which checks issuer, audience, hosted domain, `email_verified`, expiry and
   signature. This design adds a required `nonce` match on this path. The
   identity then goes through the existing `AuthenticationService`, which
   needs an enabled binding and an active principal. Failure ends the flow
   with an error page and an audit event. Nothing about who failed is
   returned to ChatGPT beyond `access_denied`.
6. **Consent page.** The callback answers `303` to a clean `/oauth/consent`
   URL, found by the cookie, so Google's code never stays in the address bar,
   the history or a referrer. Every OAuth and confirm page sends:
   - `Referrer-Policy: no-referrer`;
   - a strict CSP with no script and `frame-ancestors 'none'`;
   - `Cache-Control: no-store`.

   The page reads:

   > Connect ChatGPT to the Example Knowledge System as _display name_? ChatGPT
   > will be able to search, read and change Brain records within your own
   > permissions. Only continue if you just tapped Connect in your own
   > ChatGPT. This replaces any earlier ChatGPT connection for you.

   It names the principal's display name, never the email. **Allow** and
   **Cancel** post a single-use CSRF token bound to the stored request and
   the cookie.

7. **On Allow:** a 256-bit authorization code, valid 60 seconds and single
   use, goes to the redirect URI with ChatGPT's `state`. `iss` is not
   returned and `authorization_response_iss_parameter_supported` is not
   advertised (5.2 explains why).

**Cross-account linking inside the family (go/no-go for 14f).** The static
secret stops other connectors, but not the family's own. Suppose Participant taps
Connect, copies the gateway's authorize URL and sends it to Operator. Operator's
browser completes Google sign-in and consent, and the code arrives at the
family's callback carrying the `state` from Participant's ChatGPT. Whether
ChatGPT then attaches Operator's grant to Participant's connection depends on
whether ChatGPT checks `state` against the ChatGPT user signed in to the
finishing browser. The gateway cannot see that. Controls:

- **14f tests it:** start in one account, finish in another person's browser,
  and require ChatGPT to reject the link. If ChatGPT accepts it, nobody but
  Operator connects until there is a fix the owner approves.
- **One active grant per principal and client.** A new grant revokes the
  previous one, so a hijacked link cuts off the victim's own ChatGPT within
  one request, and the victim notices.
- **The consent page warns** as quoted above, and shows when the
  connection it replaces was made. A victim who reconnects then sees a
  connection they did not make.
- **Notifying the person directly** about every new grant, for example
  through the Family Inbox, is deferred. The gateway has no notification
  channel today, and adding one is a separate design.
- **`actingAs` in every tool result** shows whose access a conversation is
  using.
- **Audit:** `auth.oauth.consent_granted` records the replaced grant.

### 5.4 Tokens

- **Authorization code exchange** requires:
  - client authentication;
  - the same `redirect_uri` and `resource`;
  - a `code_verifier` that matches the stored S256 challenge.

  A second use of a code fails and revokes everything already issued from
  it (OAuth 2.1).

- **Access tokens** are opaque 256-bit random values, valid 15 minutes, and
  bound to one grant and the resource. They are looked up by SHA-256 hash on
  every MCP request (one indexed query over the Unix socket). Revocation
  takes effect on the next request, and there is no signing key to hold or
  rotate. Self-contained JWTs were rejected: they would add a key, and they
  would keep working after revocation until expiry.
- **Refresh tokens** are opaque 256-bit values, rotated on every use. They
  are bound to the grant, the client and the resource. The idle expiry is 14
  days. The absolute grant lifetime is 30 days (owner decision O3), after
  which the person reconnects with Google.
- **Rotation runs in one transaction that locks the grant row.** Concurrent
  refreshes therefore serialize, and exactly one wins.
- **Reuse detection:**
  - A retry that presents the immediate predecessor within 60 seconds of its
    rotation, while the newer token has never been used, gets
    `invalid_grant`. The grant is not revoked. This covers a lost response.
  - Any other reuse revokes the whole grant: an older generation, the
    predecessor after 60 seconds, or the predecessor after the newer token
    has been used (a thief refreshed first).
  - Either way, after a lost response ChatGPT may drop the connection and the
    person reconnects. The window only avoids revoking a grant that was not
    stolen.
- **`resource` on refresh:** when present it must equal the grant's. When
  absent it means the grant's, since OpenAI does not say whether ChatGPT
  sends it on refresh.
- **Every refresh re-checks the binding:** enabled, principal active, issuer
  and subject unchanged. Every MCP request already does the same through
  `AuthenticationService`, so disabling a binding cuts off ChatGPT on its
  next request.
- **Google is not consulted after sign-in.** Suspending someone's Google
  Workspace account alone does not end an existing grant until its idle or
  absolute expiry. Offboarding therefore means disabling the gateway binding
  as well. The runbook gains this in 14e.
- **Request authentication.** A new `IdentityProvider` implementation,
  `GatewayAccessTokenIdentityProvider`, resolves an access token to the
  Google issuer and subject stored on its grant, plus client ID `chatgpt`.
  The unchanged `AuthenticationService` then maps that to the principal on
  every request. Core code still sees only a verified, binding-mapped
  principal (Engineering Design 4.2). `authenticatedAt` is the grant's
  Google sign-in time.

### 5.5 Operational state (Engineering Design section 9 addition)

Seven tables and one column, created by a reviewed migration. They hold
hashes, bindings, expiry and metadata, and no Brain content.

| Table                          | Holds                                                                                                                                                                                      | Lifetime                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `oauth_authorization_requests` | client ID, redirect URI, ChatGPT `state`, code challenge, resource, browser-binding hash, Google `state` and `nonce` hashes, the Google PKCE verifier, principal after sign-in, CSRF hash  | 10 minutes; deleted when used                                         |
| `oauth_authorization_codes`    | code hash, request reference, principal ID, Google issuer and subject, code challenge, redirect URI, resource                                                                              | 60 seconds; kept consumed for reuse detection until swept             |
| `oauth_grants`                 | principal ID, Google issuer and subject, client ID, scope, resource, created, Google sign-in time, last used, absolute expiry, revoked at and reason                                       | 30 days absolute; revoked rows kept 90 days for audit, then swept     |
| `oauth_refresh_tokens`         | token hash, grant, generation, issued, idle expiry, rotated at                                                                                                                             | until the grant ends                                                  |
| `oauth_access_tokens`          | token hash, grant, expiry                                                                                                                                                                  | 15 minutes; swept                                                     |
| `browser_confirmations`        | purpose (elevation or approval), challenge or approval ID, decision, expected principal, cookie hash, Google `state` and `nonce` hashes, the Google PKCE verifier, CSRF hash, confirmed at | 10 minutes; the confirmed fact is kept with the challenge or approval |
| `oauth_client_assertion_jtis`  | `jti` hash and expiry (CIMD fallback only, created only if that fallback is approved)                                                                                                      | until the assertion expires                                           |

The added column is on the existing elevation challenges:
`browser_confirmed_at`, plus the reference of the confirmation that set it.
Approvals record their confirmation reference in the same way.

- **The Google PKCE verifier is the only raw secret-like value stored**, in
  both request tables. It lives 10 minutes, is useless without Google's code, and is deleted on use.
- **A sweep in the existing maintenance loop deletes expired rows.** It runs
  no new process and no timer.
- **Restore rule:** a database restore can bring back a grant that was
  revoked after the backup was taken. Every restore therefore ends by
  revoking all OAuth grants, and everyone reconnects. The backup and restore
  runbook gains this step in 14e.

### 5.6 Secrets (Engineering Design section 15 addition)

Two new secrets per environment, in the existing Secret Manager pattern,
read by the runtime service account:

- the Google OAuth web client secret;
- the hash of the ChatGPT client secret.

Neither is logged, returned or committed. The ChatGPT client secret itself
exists only in Operator's password manager and the ChatGPT workspace app
settings.

Rotation: generate a new secret, store its hash as a new version, update the
workspace app. Existing grants keep working, because refresh is bound to the
client ID rather than the secret version. Only the old secret stops working.

### 5.7 Revocation and administration

- **Admin surface:** no public admin endpoint (Engineering Design 18.3).
- **CLI:** `fbg oauth list` and `fbg oauth revoke --principal <key> | --grant <id> | --all`
  are added to the existing CLI, run by the operator on the VM. They print
  grant IDs, principals and dates only.
- **Disabling a principal's identity binding** blocks refresh and every MCP
  request at once.
- **Disconnecting in ChatGPT** leaves the gateway grant to expire on its idle
  or absolute limit. A revocation endpoint (RFC 7009) is not added, because
  ChatGPT does not document calling one.

## 6. Logging and audit (Engineering Design section 16 addition)

- **New audit events** go through the existing outbox:
  - `auth.oauth.authorization_started`, `auth.oauth.signin_failed`,
    `auth.oauth.consent_granted`, `auth.oauth.consent_cancelled`;
  - `auth.oauth.token_issued`, `auth.oauth.token_refreshed`;
  - `auth.oauth.refresh_reuse_detected`, `auth.oauth.code_reuse_detected`;
  - `auth.oauth.grant_revoked`;
  - `auth.confirm.started`, `auth.confirm.confirmed`,
    `auth.confirm.cancelled`, `auth.confirm.refused` (wrong principal) and
    `auth.confirm.expired`.

  They carry the principal when known, the client ID, the grant ID, the
  reason code and the request ID. They never carry a code, token, state,
  nonce, verifier, secret, cookie or email.

- **MCP tool calls** produce the existing `brain.*` events with client ID
  `chatgpt`. MCP adds no audit fields of its own.
- **Request logging is already disabled** in Fastify, and nginx has
  `access_log off`. Both must stay so for `/oauth/*`, where query strings
  carry codes and state.
- **nginx's `error_log` at `warn`** prints the request line, query string
  included, when the upstream fails. The `/oauth/` and `/confirm` locations
  therefore set `error_log … crit`, and the gateway's own structured logs
  cover their failures. A test asserts that no log line contains a
  generated code, token or secret, extending the existing no-secrets log
  tests.

## 7. Configuration (Engineering Design section 19 addition)

Per environment, validated at startup, fail-closed:

- **Issuer and resource:** `OAUTH_ISSUER` and `MCP_RESOURCE`, both HTTPS, on
  the deployment's own host.
- **ChatGPT client:** `CHATGPT_CLIENT_ID`, `CHATGPT_REDIRECT_URI` (exactly
  one, of the form `https://chatgpt.com/connector/oauth/<callback ID>`; 5.2) and
  `CHATGPT_CLIENT_SECRET_HASH_REF`.
- **Google client:** `GOOGLE_OAUTH_CLIENT_ID` (the existing `OIDC_AUDIENCE`
  value, so the verifier is reused unchanged) and
  `GOOGLE_OAUTH_CLIENT_SECRET_REF`.
- **Lifetimes:** `OAUTH_ACCESS_TTL=900s`, `OAUTH_REFRESH_IDLE=14d` and
  `OAUTH_GRANT_MAX=30d`, each with a hard cap in code.

Behavior when values are missing:

- **All values absent:** the MCP and OAuth routes are not registered, and
  the existing routes run as today. This is the test and local default.
- **Only some values present:** startup fails in every environment, so a
  half-configured production never silently drops the connector.
- **Production:** once ChatGPT use is approved, a configuration flag marks
  the connector required, and startup fails if it is not fully configured.

Startup also fails if the issuer host differs from the configured public
domain, or if a production process sees a dev issuer (R6).

## 8. Threat model

| Threat                                                                                                           | Control                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Consent phishing: someone else's connector starts the flow and sends the link to a family member                 | The static client secret (5.2) makes another connector's code unredeemable. Exact redirect URI. Google `select_account`. A consent page naming the principal. Audit of every grant.                                                                                                        |
| Authorization code interception                                                                                  | PKCE S256, client secret, exact redirect URI, 60-second single use, reuse revokes.                                                                                                                                                                                                         |
| Login CSRF or session swapping in the browser                                                                    | `__Host-` cookie binding across authorize, callback and consent; Google `state` and `nonce`; CSRF token on consent.                                                                                                                                                                        |
| Open redirect                                                                                                    | Never redirect before the client and exact redirect URI are validated; a single configured redirect.                                                                                                                                                                                       |
| Stolen access token (OpenAI-side breach or leak)                                                                 | Bound to resource and grant; 15 minutes; revocable on the next request; only usable on `/mcp`; the person's own permissions only.                                                                                                                                                          |
| Stolen refresh token                                                                                             | Rotation with reuse detection; idle and absolute expiry; client secret required to use it; CLI revocation. **Residual:** OpenAI holds live refresh tokens for each connected person; accepted, as with any ChatGPT connector.                                                              |
| Token passthrough or confused deputy                                                                             | ChatGPT tokens are never sent to providers. Providers keep their dedicated machine credentials; Google tokens from sign-in are discarded.                                                                                                                                                  |
| Identity spoofing by the model (for example "act as Operator")                                                   | Identity comes only from the grant's Google binding; tool schemas have no principal field; client-declared claims stay non-authoritative.                                                                                                                                                  |
| Prompt injection in Brain content steering ChatGPT to write or delete                                            | The gateway's own policy: Participant's limits, protected and legal-hold rules, approvals, elevation, idempotency and audit. ChatGPT's confirmation is extra. **Residual:** for routine writes, the gateway cannot tell a model-initiated call from an intended one, as for any AI client. |
| The model completes an elevation or approves a pending delete by itself                                          | The confirmation token never reaches the model. Elevated operations and approvals need the person to confirm in a browser, after Google sign-in as the same principal (section 4).                                                                                                         |
| Cross-account linking inside the family (a family member forwards their authorize link to a parent)              | 14f go/no-go test of ChatGPT's `state` handling; one active grant per principal; consent warning; `actingAs` in results; audit (5.3).                                                                                                                                                      |
| ChatGPT workspace sharing exposes Brain results across people (shared chats, projects, workspace memory or GPTs) | Outside gateway enforcement. Owner checks O7 before Steward or Participant connect. **Residual:** anything a person fetched and then shared inside ChatGPT is governed by ChatGPT, not the gateway.                                                                                        |
| A lost refresh response or two refreshes at once                                                                 | A row-locked rotation and a 60-second predecessor window that applies only while the newer token is unused, so a grant that was not stolen is not revoked. The person may still need to reconnect (5.4).                                                                                   |
| A stolen token replayed from outside OpenAI                                                                      | Optional hardening O8: require ChatGPT's OpenAI-managed client certificate on `/mcp` and `/oauth/token`. It does not tell one connector from another.                                                                                                                                      |
| A workspace admin changes or repoints the app                                                                    | Only Operator is a workspace admin (owner check O5). A repointed app gets no gateway tokens. A changed redirect URI fails the exact match.                                                                                                                                                 |
| DNS rebinding or browser calls to `/mcp`                                                                         | Requests with an `Origin` other than none, or `https://chatgpt.com` if 14f shows it is sent, are rejected; bearer token required.                                                                                                                                                          |
| Abuse of unauthenticated OAuth endpoints                                                                         | nginx per-address and global limits; small body limits; 10-minute request expiry and sweep; no Brain data reachable.                                                                                                                                                                       |
| Restore brings back a revoked grant                                                                              | Restore runbook revokes all grants (5.5).                                                                                                                                                                                                                                                  |
| Dev token used on prod                                                                                           | Separate issuer, resource, client, secrets and database; resource check on every token.                                                                                                                                                                                                    |
| Secrets in logs                                                                                                  | No request logging; explicit audit field allowlist; log-scan tests.                                                                                                                                                                                                                        |

## 9. Owner decisions

| #   | Decision                                                                                                                           | Recommendation                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Accept gateway-issued tokens, minted only after verified Google sign-in, as satisfying the identity invariant (section 11 wording) | Accept. It is the only way ChatGPT can connect, and every request still resolves through the immutable Google binding.                                                                                                                                                                                                |
| O2  | Client registration (plan D11)                                                                                                     | A static pre-registered confidential client, with CIMD restricted to the family app's callback as the fallback only (5.2).                                                                                                                                                                                            |
| O3  | Grant lifetime                                                                                                                     | 30 days absolute, 14 days idle: Steward and Participant reconnect with Google about monthly, which takes a few taps. 90 days is possible but triples the exposure of a leaked refresh token.                                                                                                                          |
| O4  | ChatGPT workspace approval setting for this app                                                                                    | "Always ask" through 14f and Operator's first real use. After that, consider "Allow all actions" for routine writes. It is defensible because elevated operations and approvals still need the browser confirmation (section 4), and the PRD names write friction as a problem. That needs a separate owner decision. |
| O5  | Workspace admins                                                                                                                   | Operator is the only admin or owner of the Business workspace. He confirms it before 14f.                                                                                                                                                                                                                             |
| O6  | Google OAuth consent screen                                                                                                        | Internal user type, in each environment's project, limited to the Example Workspace.                                                                                                                                                                                                                                  |
| O7  | ChatGPT workspace sharing settings                                                                                                 | Before Steward or Participant connect, Operator checks in the admin console that each app connection is per member and never shared. He also reviews chat and project sharing and workspace memory or GPT settings. The family agrees not to share Brain-using chats with Participant.                                |
| O8  | Require ChatGPT's OpenAI-managed client certificate                                                                                | Evaluate in 14e and 14f. nginx would verify the chain only on `/mcp` and `/oauth/token`, and the gateway would check the `mtls.prod.connectors.openai.com` SAN. Adopt only if ChatGPT presents the certificate there and browsers on the sign-in pages are never asked for one. Otherwise defer.                      |

## 10. Capacity and cost

**Capacity.**

- **Runtime:** the new routes run inside the existing gateway process on the
  e2-micro. No new container, timer or connection pool is added.
- **Per tool call:** one extra indexed lookup over the Unix socket for the
  access token, and one more row write per refresh, about every 15 minutes
  per connected person while in use.
- **Memory:** the form parser and metadata documents add negligible memory.
- **Measurement:** 14f still measures memory against the capacity report's
  ceilings while ChatGPT is connected.

**Cost.**

- **Compute, network and database:** none new. The routes run in the
  existing process, and the tables are a few kilobytes.
- **Secrets:** four new active versions, two per environment. These share
  the free 6 active versions with the existing secrets; beyond that, about
  USD 0.06 a month each. Worst case is about USD 0.24 a month.
- **ChatGPT seats:** licensed separately from the SIM-G hosting budget.
- **Total:** the expected total in the plan (about USD 4.6 to 5.4 a month)
  rises by at most about 0.24.

## 11. Exact amendments on approval

On approval, 14e applies these alongside the code, each with a pointer back
to this document:

- **`SECURITY.md`, first invariant.** It becomes: "Every Brain operation
  authenticates a distinct human Google OIDC identity, either directly by a
  verified Google ID token or through a gateway-issued token that the gateway
  minted only after verifying one, and maps the immutable issuer/subject
  binding to a Brain principal."
- **Engineering Design 23,** identity bullet. It becomes: "Identity comes
  from verified OIDC, directly or through a gateway token bound to a verified
  OIDC sign-in, never from client-declared user metadata."
- **Engineering Design 3, 4.1, 4.2, 9, 15, 16, 18.1, 19 and 22** each get a
  short note pointing to sections 3–7 of this document.
- **Engineering Design 18.1** also lists the new unauthenticated paths as
  OAuth-required and Brain-free.
- **The acceptance matrix** (14c) gains cases for:
  - an MCP call without a token, with an expired token, and with a dev token
    on prod;
  - code reuse and refresh reuse;
  - a wrong redirect, a wrong resource, and a missing or plain PKCE;
  - Participant's limits through MCP;
  - an elevated operation of each of the four mutation kinds, and an
    approval, through MCP: the token is never in
    the tool result, a confirm page by a different principal is refused,
    and a call without browser confirmation is refused;
  - a second grant revoking the first;
  - a form body with repeated parameters;
  - refresh races.

  Manual case M-ChatGPT covers web and phone, including the cross-account
  linking go/no-go test (5.3).

## 12. Tests and build order for 14e

Test-driven, smallest first. Fictional identities only, and a fake Google
(local JWKS and token endpoint) in tests:

1. Configuration validation and metadata documents.
2. OAuth state store port, PostgreSQL implementation and migration, with
   integration tests: expiry, single use, reuse revocation, sweep.
3. Authorize, callback, consent and token handlers, with exhaustive negative
   cases for every parameter in 5.3 and 5.4.
4. `GatewayAccessTokenIdentityProvider`, and authentication through the
   unchanged `AuthenticationService`.
5. MCP JSON-RPC handler, tool mapping and error mapping, with contract tests
   using the official MCP SDK client.
6. The confirm page and the elevation service's browser-confirmation path,
   so no confirmation token appears in any MCP result.
7. An end-to-end local test: SDK client, OAuth flow against the fake Google,
   then search, persist, Participant's denial and an elevated delete.
8. nginx `location = /mcp`, the `/oauth/` and `/confirm` error-log levels,
   and the restore and offboarding runbook steps.
9. Then 14f, live in dev with ChatGPT on the web and then the phone, with
   owner approval.

## 13. Sources (read 2026-11-05)

- [OpenAI: Plugin authentication](https://developers.openai.com/plugins/build/auth):
  protected resource and authorization server metadata, S256, CIMD client
  IDs, static clients, redirect URIs, `resource`, token checks,
  `mcp/www_authenticate`
- [OpenAI: Building an MCP server for plugins](https://developers.openai.com/plugins/build/mcp-server):
  streamable HTTP at `/mcp`, annotations, result shape, stable schemas
- [OpenAI: Building MCP servers for plugins and API integrations](https://developers.openai.com/api/docs/mcp)
- [MCP specification 2025-11-25: Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Pleo: installing an MCP server in ChatGPT Business](https://developers.pleo.io/docs/current/pleo-mcp/how-tos/installation/chatgpt-business):
  admin create, publish, Installed, per-member connect, approval settings

## 14. Independent security review (2026-11-05)

A separate reviewer agent, which had not seen the drafting conversation, read
this draft against `SECURITY.md`, the PRD, the Engineering Design, the
identity, authentication and elevation code, the nginx configuration, and
OpenAI's authentication documentation. The author checked its code-level
claims against the repository before accepting them. All 12 findings are
addressed in this revision:

| #   | Severity   | Finding                                                                                                                                  | Resolution                                                                                                                              |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High       | The elevation confirmation token reaches the model, so injected text could complete an elevated delete or an approval with no human step | The token never appears in a tool result; elevated operations and approvals are confirmed in a browser after Google sign-in (section 4) |
| 2   | High       | Cross-account linking through the family's own connector                                                                                 | 14f go/no-go test, one grant per principal, consent warning, `actingAs`, audit (5.3)                                                    |
| 3   | Medium     | A `__Host-` cookie with path `/oauth` is rejected by browsers                                                                            | `Path=/` (5.3)                                                                                                                          |
| 4   | Medium     | The app parses only JSON, so the token and consent form posts would fail                                                                 | A scoped form parser that rejects repeated parameters (section 3)                                                                       |
| 5   | Medium     | Unverified static-client support; weak fallback; wrong mix-up rationale                                                                  | Callback-specific redirect required; `iss` deliberately unadvertised; `private_key_jwt` CIMD fallback with pinned metadata (5.2)        |
| 6   | Medium     | Suspending someone in Google does not cut off ChatGPT; stale 15-minute claim                                                             | Offboarding disables the binding; text corrected (5.4, 5.7)                                                                             |
| 7   | Medium     | ChatGPT workspace sharing is outside gateway enforcement                                                                                 | Owner decision O7, threat-model row, residual risk recorded                                                                             |
| 8   | Low–medium | Refresh races revoke good grants; `resource` may be absent on refresh                                                                    | Row-locked rotation, 60-second predecessor window, absent `resource` means the grant's (5.4)                                            |
| 9   | Low–medium | OpenAI's mTLS client certificate is unused                                                                                               | Owner decision O8, evaluated in 14e and 14f                                                                                             |
| 10  | Low        | `update_record` is hard to reverse                                                                                                       | `destructiveHint: true` (section 4)                                                                                                     |
| 11  | Low        | `Origin`, protocol-version and reconnect-challenge details                                                                               | Allow absent or `https://chatgpt.com`; version list with the specification default; HTTP `401` challenge only (section 4)               |
| 12  | Low        | Codes in nginx error logs and referrers; `/mcp` guard; request cap; partial configuration                                                | `error_log crit`, a `303` to a clean URL, `no-referrer`, `$request_uri` guard, a 50-request cap, fail on partial configuration          |

The reviewer found these sound:

- opaque, hash-looked-up access tokens;
- Google tokens discarded and never passed to providers;
- the nonce, plus the existing hosted-domain, audience and email checks;
- exact redirect matching, with no redirect before validation;
- short, single-use codes with reuse revocation;
- identity always resolved through the unchanged binding check;
- operation IDs that a model-chosen request ID cannot cross;
- restore revoking all grants;
- no Dynamic Client Registration and no shared `client.json`.

**Re-review (2026-11-05).** The same reviewer re-read the revision.

Adequate as revised: the fixes for 3, 4, 6, 7, 9 and 10.

Gaps in the earlier fixes, now corrected:

- **Elevation (1):**
  - it covers all four mutations, not only deletes;
  - the MCP schemas take only the challenge ID;
  - approvals get their own confirmation state, confirmed by the resolving
    parent;
  - `/mcp` challenges last 10 minutes.
- **Client registration (5):**
  - section 7 now requires the callback form;
  - the fallback metadata, the accepted `aud` values and the `jti` table are
    specified.
- **Refresh races (8):** the predecessor window applies only while the newer
  token is unused, and the person may still have to reconnect.
- **Origin (11):** section 8 is consistent with section 4.
- **Request cap (12):** per-address and global limits, eviction instead of
  `503`, and separate linking and confirmation pools.

New problems the re-review found, now fixed:

- a Google return path and `state` purpose for the confirm flow;
- a separate confirm cookie;
- `auth.confirm.*` audit events;
- R4 reworded for the deliberate difference;
- lookalike-link phishing and the unchanged `/v1` token path recorded as
  residuals;
- the table count corrected;
- owner decisions in order.

Cross-account linking (2) stays a 14f go/no-go test with detection, not
prevention.
