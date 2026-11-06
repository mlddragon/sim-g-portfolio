# SIM-G Task 14 production plan: ChatGPT on the phone first (14a)

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

**Owner:** Operator
**Date:** 2026-11-05
**Status:** Proposed for owner review. This is a repository-only plan. It
authorizes no cloud change, credential, DNS change, production data access or
spend. Each step below that touches the cloud, a credential, DNS or real
content still needs the owner's explicit go-ahead at the time (Task 14
approval, 2026-11-05).

The owner wants to set SIM-G up and use it in a real workflow. This plan
takes PLAN Task 14 from today's state to **Operator's first real use in
production through ChatGPT on his phone**, then names what remains before
Steward and Participant (step 6) and v1 completion (step 7). It follows the PLAN
order: automated acceptance, live dev checks and manual readiness come before
production promotion.

**Owner ruling (2026-11-05):** ChatGPT is the family's primary AI. ChatGPT on
a phone is Operator's primary interface and Steward's and Participant's only one. So
the ChatGPT connection is built before any live testing or going live; there
is no interim single-user connector (the local bridge first proposed here was
declined).

## 1. Where things stand

| Area                       | State                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway, policy, providers | Implemented and live-proven in dev for Notion and Drive (Stage C sessions 1 to 3): search, fetch, create, update, append, replace, delete, replay and idempotency.                                                                                              |
| GitHub retrieval           | The adapter is complete locally. The running gateway composes `UnregisteredGitHubProvider` until the canonical Project Registry is bound (owner decision 2026-10-24), so search reports GitHub as unavailable.                                                  |
| Recovery                   | R6 passed in dev: alerts, validated restore, about 11 minutes of data lost against a bound of about 16. The post-restore reconciliation that step 6 requires is not built.                                                                                      |
| Production Terraform       | `infra/google/environments/prod` exists: the same module, `environment = "production"`, `PREVENT` deletion policies, a static IPv4 and deletion protection. Checked offline only (`pnpm infra:check`). Never planned or applied against the production project. |
| Production project         | SIM-G Production exists, empty, labelled and billing-linked (bootstrap, 2026-10-28). None of the F13d preconditions done in dev have been done there.                                                                                                           |
| Promotion                  | Not built: the production deployer's read on the dev image repository, the promotion job (copying the exact dev-validated digest, never rebuilding) and the production environment's evidence gate (VM design section 10).                                      |
| Real AI client             | **Not built.** The gateway exposes only its HTTP API, which takes a Google ID token. Dev QA used the OAuth Playground and `curl`. No ChatGPT connection exists (QA readiness section 3.3), and the specs do not define one.                                     |
| Acceptance                 | `ACCEPTANCE-MATRIX.md` has 28 automated (A01–A28) and 11 manual (M01–M11) rows. `tests/acceptance` has 4 files (19 tests). PLAN step 1's six named acceptance files do not exist yet. M02 still names Cloud SQL, which the e2-micro decision retired.           |
| Infra items "not yet here" | State-bucket IAM, the disk-usage timer behind the 80 % disk event, and excluding audit lines from the `_Default` log bucket (`infra/google/README.md`).                                                                                                         |
| Dev environment            | Kept stopped past the 2026-11-07 trial deadline for Task 14 (owner, 2026-11-05). Booting it needs a new approval; 7.33 VM hours remain under the earlier budget.                                                                                                |

## 2. Findings that shape the plan

### 2.1 ChatGPT needs a remote MCP connector with OAuth on the gateway

What OpenAI documents today (read 2026-11-05, sources in section 7):

- **Custom GPTs and their actions are being retired** (reported for
  2026-12-11, later for some workspaces), and custom actions do not carry
  over. They are not a path.
- **The supported path is a ChatGPT plugin built from a custom MCP server:**
  a public HTTPS URL speaking streamable HTTP (or SSE), added under ChatGPT
  Plugins on the web, then installed and used in conversations.
- **Authentication is OAuth or none.** ChatGPT can register itself with
  Client ID Metadata Documents (CIMD, recommended by OpenAI when the
  authorization server advertises it) or Dynamic Client Registration, and
  uses pre-registered static client credentials when the creator supplies
  them. There is no static bearer-token option.
- **Write actions ask for confirmation by default.** A tool without the
  `readOnlyHint` annotation is treated as a write and confirmed; a
  remembered approval lasts one conversation.
- **Not stated in OpenAI's documentation:** whether the iPhone and Android
  apps can use a custom plugin once it is added on the web (third-party
  guides say yes), which plans may add one (guides say paid plans; Business
  and Enterprise admins can restrict it), and how write tools behave on
  individual Plus or Pro plans (guides disagree). Each person installs and
  connects with their own account. Sharing one plugin to others is
  documented for Business and Enterprise workspaces.

**Owner answer (D10, 2026-11-05): one ChatGPT Business workspace.** Operator,
Steward and Participant are members of the same Business workspace. Operator administers
the workspace and already pushes plugins to every member by default (Gmail,
for example). He has not yet added a custom MCP plugin, so the end-to-end
path is untested until 14f. Vendor guides for
Business workspaces (sources in section 7; OpenAI's help article was not
readable without sign-in) describe the flow as follows:

- **A workspace admin or owner creates the app** from the server URL with
  OAuth, then publishes it from Drafts.
- **The admin sets the action defaults:** new actions enabled, read-only or
  disabled, and approval from "Always ask" to "Allow all actions".
- **The admin then sets the app to Installed** for members.
- **Publishing authorizes no one.** Each member connects once with their own
  sign-in.

For SIM-G this means:

- **No one shares a token.** Each person's connection runs through their own
  Google sign-in at the gateway, so Participant's Family Shared limit and the
  15-minute rule come from her own verified identity, never from her
  workspace membership.
- **ChatGPT's approval setting is convenience only.** It can reduce write
  friction, but it is never a safeguard. Protected actions, elevation and
  approvals stay enforced by the gateway.
- **Workspace admins sit inside the trust boundary.** An admin can change the
  app, so 14b's threat model covers a changed or repointed app. Redirect URIs
  are limited to ChatGPT's callback, and tool names and schemas stay stable
  across republishes.
- **Phone use is still unverified.** 14f tests it on Operator's seat, both reads
  and writes, before anyone else connects.

What that means for the gateway:

- **An MCP endpoint** on the gateway (for example `/mcp`), exposing exactly
  the eight Brain operations as tools: never a generic provider proxy. Search,
  fetch and listing approvals carry `readOnlyHint`; writes keep ChatGPT's
  confirmation unless the design settles otherwise (the PRD's write-friction
  goal is weighed there).
- **The gateway becomes an OAuth authorization server for ChatGPT.** Google
  cannot be used directly: it supports neither CIMD nor DCR, and its access
  tokens are opaque, while the gateway trusts only verified Google ID tokens.
  The gateway therefore runs authorization code plus PKCE with ChatGPT, signs
  the person in with Google (OIDC, verified by the existing verifier and
  mapped through the immutable issuer and subject binding), and only then
  issues its own short-lived access token and rotating refresh token, bound
  to that principal and to the gateway as audience. Verified Google identity
  stays authoritative: no gateway token exists without it.
- **Client registration** is limited to ChatGPT: either one pre-registered
  confidential client, or CIMD accepting only ChatGPT's published client
  metadata URL and its `https://chatgpt.com/connector/oauth/...` redirects.
  Open DCR is not accepted.
- **New operational state** in PostgreSQL: authorization codes and hashed
  refresh tokens with expiry and revocation, no Brain content. Every grant,
  refresh, revocation and refusal is audited.
- **New surface to review:** this changes the identity boundary, so it needs
  an Engineering Design amendment, owner approval and an independent
  security review before implementation, plus a capacity re-check within
  the e2-micro envelope (F13b left about 445 MiB free).

### 2.2 Existing Notion pages are read-only through the gateway

The gateway updates, appends to or deletes a Notion page only when its
stored content hash, content type and title properties match the body
Notion holds (the integrity check). Pages the gateway did not create have no
stored hash. So on day one, **everything already in the Brain is readable
through the gateway, but only records the gateway creates can be changed
through it.** A gateway-created page that another tool later edits directly
(for example ChatGPT's own Notion connector) also becomes read-only
through the gateway.

This is the same gap the owner ruled on 2026-11-05 (out-of-band edits and the
post-restore lost window): provider state the gateway's records do not
match. The governed fix is an audited "adopt" step, which records the
current body's hash after a parent confirms it. It belongs with the step 6
reconciliation design. For Operator's first use the recommendation is to accept
the limitation: read everything, and write new records through the gateway.

### 2.3 The real Notion workspace needs the gateway's structure

Production roots are configured, never committed, in the on-VM configuration
file:

- each Notion root that accepts new records is a **data source** with four
  gateway properties (title, operation marker, content type, content hash);
- the Family Inbox is a data source with nine properties and six status
  options (`docs/runbooks/notion-family-inbox.md`);
- at most one root per container (`family_shared`, `parent_and_stewardship`,
  `protected`), and a less restrictive root may not sit inside a more
  restrictive one.

The owner's real workspace may not have this shape yet. Preparing it means
the owner chooses which existing databases become roots (or creates new
ones) and adds the properties. That is a change to the real Brain, so the
owner makes it or approves it step by step. Notion root and property IDs go
only into the on-VM configuration file, never into the repository, GitHub,
chat or Notion pages. Agents read schema only, never page content, and only
with the owner's go-ahead.

**Root ancestry (onboarding decision still open):** with least-privilege
sharing, startup fails closed (`root_ancestry_unavailable`) when the
integration cannot see a root's ancestors. The owner either shares each
root's ancestry with the integration, or accepts treating an invisible
ancestor as the top (configuration runbook). Dev QA avoided this with
top-level roots.

### 2.4 GitHub can wait for first use, but not for v1

First use can run with GitHub honestly reported unavailable in every
search. The PRD's Definition of Done requires approved GitHub retrieval, so
binding the canonical Project Registry and composing the GitHub App adapter
is a v1 slice, after first use.

## 3. Slice sequence

Each slice is a reviewed PR with exact-head CI. Owner actions are given one
at a time when the slice runs.

| Slice | What                                                                                                                                                                                                                                                                                                                                                                                     | Kind                                    | Blocks first use |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | :--------------: |
| 14a   | This plan.                                                                                                                                                                                                                                                                                                                                                                               | Docs                                    |       Yes        |
| 14b   | **ChatGPT connector design (2.1):** an Engineering Design amendment for the MCP endpoint and the gateway's OAuth authorization server: tools and annotations, client registration, token lifetimes and revocation, re-checking the Google binding, audit events, threat model, capacity. Owner approval and an independent security review before any code.                              | Design                                  |       Yes        |
| 14c   | **Acceptance trace (PLAN steps 1 and 2):** map every A-row to named tests, add the six acceptance files where a row has no test, correct M02 for the e2-micro design, then run the complete automated gate from a clean checkout.                                                                                                                                                        | Code, tests, docs                       |       Yes        |
| 14d   | **Promotion and infra gaps:** the promotion workflow and production evidence gate, the production deployer's read on the dev repository, state-bucket IAM, the disk-usage timer, the `_Default` audit exclusion. Offline checks only.                                                                                                                                                    | Terraform, workflow, host units         |       Yes        |
| 14e   | **ChatGPT connector implementation:** the approved 14b design in several test-first PRs (state and migrations, the authorization server, the Google sign-in leg, the MCP endpoint and tools, ingress routes and rate limits), synthetic only, with acceptance rows for the new boundary.                                                                                                 | Code, tests                             |       Yes        |
| 14f   | **First live test, dev (PLAN step 3 remainder):** Operator adds the dev connector in ChatGPT on the web, signs in with Google, then uses it from ChatGPT on his phone against fictional records: search, fetch, each write, an approval, refusals. Also a promotion dry run and removing `r6-aside`. Needs a new VM-hours approval and the dev A record during the session.              | Live, dev only                          |       Yes        |
| 14g   | **Production bring-up:** the F13d preconditions in the production project, a production state bucket, the reviewed `terraform plan` (owner approves the plan output before apply), apply, the `brain.example.invalid` A and CAA records, the production `age` key in the owner's vault, the production Google OAuth client, the runtime password, and promotion of the exact 14f digest. | Live, production, owner-gated each step |       Yes        |
| 14h   | **Production providers:** the production Notion integration and prepared roots (2.3), the production Family Inbox, the registered Drive roots shared with the production `fbg-drive`, and Operator's identity binding. GitHub stays unbound.                                                                                                                                             | Owner, production                       |       Yes        |
| 14i   | **Operator's first real use (PLAN steps 4 and 5):** ChatGPT on his phone against production: the manual checks M01 to M08, read-first, then writes to designated safe records, then his day-to-day workflow. Owner sign-off records the result.                                                                                                                                          | Live, production, real data             |        —         |
| Later | GitHub Registry binding and composition; the adopt step plus step 6 reconciliation; Steward and Participant onboarding through their own ChatGPT accounts (step 6); v1 closure (step 7).                                                                                                                                                                                                 | Separate slices                         |        No        |

14b, 14c and 14d touch separate files and can run in parallel. 14e needs 14b
approved. 14f needs 14c, 14d and 14e. 14g needs 14f's digest.

## 4. Owner decisions

| #   | Decision                                                                                                      | Recommendation                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | First client path (2.1)                                                                                       | **Decided (owner, 2026-11-05):** ChatGPT through a remote connector, before any live testing.                                                                                                                                                                                                                                                                                         |
| D2  | Existing pages read-only through the gateway (2.2)                                                            | Accept for first use; build the adopt step with step 6 reconciliation.                                                                                                                                                                                                                                                                                                                |
| D3  | Which Notion databases and pages become the Family Shared, Parent & Stewardship and Inbox roots               | Owner chooses at 14h. New, empty gateway databases are the simplest and touch no existing page. Existing ones need the four properties added.                                                                                                                                                                                                                                         |
| D4  | Root ancestry visibility (2.3)                                                                                | Top-level roots shared with the integration, as in dev, so no invisible-ancestor exception is needed.                                                                                                                                                                                                                                                                                 |
| D5  | Which Drive folders become roots, and on which shared drive                                                   | Owner chooses at 14h. A dedicated shared drive keeps `fbg-drive` away from My Drive.                                                                                                                                                                                                                                                                                                  |
| D6  | First use without GitHub (2.4)                                                                                | Yes; bind the Registry as the first slice after first use.                                                                                                                                                                                                                                                                                                                            |
| D7  | Backup key custody: the vault format and an independent emergency recovery path (still open since 2026-10-27) | Close before 14g, because production backups start at apply.                                                                                                                                                                                                                                                                                                                          |
| D8  | Recovery objectives for Operator-only use                                                                     | Accept the R6-measured recent tier (about 16-minute worst-case loss) and the manual restore runbook as interim, as Task 14 step 6 already allows.                                                                                                                                                                                                                                     |
| D9  | Budget alert                                                                                                  | Supply `billing_account_id` at apply (never committed) for the USD 10 budget at 50 and 80 %.                                                                                                                                                                                                                                                                                          |
| D10 | Each family member's ChatGPT plan (2.1)                                                                       | **Decided (owner, 2026-11-05):** Operator, Steward and Participant are members of one ChatGPT Business workspace, each on its paid seat (licensed separately from the SIM-G hosting budget). A workspace admin publishes the connector once and sets it Installed; each member connects with their own Google sign-in. 14f still checks the phone and write tools on Operator's seat. |
| D11 | Client registration (2.1)                                                                                     | **Proposed in 14b** ([connector design](2026-11-05-chatgpt-connector-design.md) 5.2, decision O2): one static, pre-registered confidential client with a callback-specific redirect. The fallback is CIMD restricted to the family app's callback, with `private_key_jwt`. Never DCR or the shared `client.json`.                                                                     |

## 5. Cost

The F13b model's expected production total is **about USD 4.19 to 4.94 a
month** with tax (VM free tier, IPv4 about 3.65 to 3.72), rising to about
4.93 to 6.05 once Google starts charging for alerting (from September 2027),
depending on alerts kept. Changes since the model:

- **Dev kept stopped:** its 20 GB of standard disk plus production's 20 GB
  is 40 GB against the 30 GB-month free allowance, about **+0.40 a month**.
- **Dev VM hours while production runs:** the free e2-micro allowance covers
  one VM. Dev hours during approved sessions are paid, about 0.0084 an hour
  (third-party rate, to verify in the Cloud Billing catalog).
- **Secrets:** dev and production versions share the free 6 active versions;
  each extra is about 0.06 a month.

Expected total with dev kept: about **USD 4.6 to 5.4 a month**, under the
USD 10 limit and around the preferred USD 5. Budget alerts do not cap spend;
Compute Engine has no spend cap. Re-check the prices at 14g.

## 6. Unchanged boundaries

- Production uses its own project, identities, credentials, secrets,
  database and provider roots. Dev identities hold nothing in production.
- Real content is never committed, logged, pasted into chat or used in dev.
  Agents never read real page content to build the system.
- Promotion copies the exact dev-validated digest; production never builds.
- No anonymous operation; verified Google identity only; GitHub read-only;
  Drive restricted to registered roots; no generic proxy; no autonomous LLM
  in the gateway path.
- The production plan is reviewed as `terraform plan` output before any
  apply. No automatic upsizing or paid dependency to make anything fit.

## 7. Sources (read 2026-11-05)

OpenAI's own pages, which outrank the third-party guides where they differ:

- [Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [Building MCP servers for plugins and API integrations](https://developers.openai.com/api/docs/mcp)
- [Model Context Protocol (ChatGPT Learn)](https://learn.chatgpt.com/docs/extend/mcp)

Third-party reports, used only for what OpenAI's pages do not state (mobile
use, plans, Custom GPT retirement dates), and to be rechecked in 14b:

- [Harvard IT: OpenAI will retire Custom GPT functionality](https://www.huit.harvard.edu/news/2026/09/openai-will-retire-custom-gpt-functionality-chatgpt)
- [Custom GPTs retire Dec 11, 2026: how to migrate to plugins](https://www.developersdigest.tech/blog/custom-gpt-retirement-migrate-to-plugins)
- [ChatGPT MCP: setup, plans and limits (2026)](https://coworker.ai/blog/chatgpt-mcp)
- [ChatGPT MCP servers in Developer Mode](https://www.usecarly.com/blog/chatgpt-mcp/)
- [Pleo MCP: installing in ChatGPT Business](https://developers.pleo.io/docs/current/pleo-mcp/how-tos/installation/chatgpt-business) (admin create, publish, Installed, per-member connect)
- [Boomi: Connect ChatGPT setup](https://help.boomi.com/docs/Atomsphere/Platform/Connect_chatgpt_setup) (says a connector created on the web syncs to the mobile apps; a vendor claim)
