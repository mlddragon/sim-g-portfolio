# v1 acceptance matrix

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

This matrix translates PRD section 21 and the Engineering Design security
invariants into executable or manual evidence. Automated test names are stable
targets; they may begin as pending only until their owning implementation task.

## Automated acceptance

| ID  | Required behavior                                                                                                         |    Owning tasks | Required evidence                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Operator, Steward, and Participant authenticate independently and map from verified Google issuer plus immutable subject. |         2-4, 12 | Valid tokens map correctly; wrong signature, issuer, audience, hosted domain, expiry, and client-declared identity fail.                                                    |
| A02 | Role and Family Shared versus Parent & Stewardship boundaries are enforced on every operation.                            |        5, 10-12 | Table-driven principal/scope tests, including fresh authorization on targeted fetch.                                                                                        |
| A03 | `search_brain` fans out over every authorized Notion, Drive, and GitHub surface.                                          |        7-10, 12 | Provider-contract and application tests with normalized cross-provider fixtures.                                                                                            |
| A04 | Search results include stable IDs, provenance, canonical location, and per-provider completeness.                         |            7-10 | Response assertions for every normalized field and completeness state.                                                                                                      |
| A05 | `fetch_record` performs a current targeted provider fetch by opaque gateway ID.                                           |        7-10, 12 | Alias resolution, fresh authorization, current version/content, and stale-authorization denial tests.                                                                       |
| A06 | Canonical writes route deterministically to Notion or Drive only after policy.                                            |     5, 7, 8, 11 | Identical metadata gives identical routes; a provider call occurs only after an allowed decision.                                                                           |
| A07 | Missing or unsafe routing metadata yields structured retryable errors.                                                    |        2, 5, 12 | `insufficient_metadata` includes missing fields; `routing_ambiguous` includes candidates and required refinement.                                                           |
| A08 | GitHub is read-only at both type and runtime boundaries.                                                                  |     2, 6, 9, 11 | Adapter cannot satisfy the mutable port; all attempted GitHub mutations fail before an outbound call.                                                                       |
| A09 | GitHub retrieval intersects App access with the live-marker-verified Project Registry.                                    |            5, 9 | Registered repository passes; removed, malformed, drifted, or merely App-installed repositories fail closed.                                                                |
| A10 | Drive retrieval and writes remain inside explicitly registered roots.                                                     |            5, 8 | Direct/nested descendants pass; My Drive, broad corpora, supplied out-of-root IDs, and moved records fail.                                                                  |
| A11 | Provider operations use distinct least-privilege machine identities.                                                      |         6-9, 13 | Config and infrastructure tests reject human, duplicate cross-provider, and cross-environment credential bindings.                                                          |
| A12 | Participant's creator correction window is exactly 15 minutes.                                                            |           5, 11 | Gateway-derived creator/time tests at `14:59.999`, `15:00.000`, and `15:00.001`.                                                                                            |
| A13 | Protection, legal hold, and stricter policy override creator ownership and age.                                           |           5, 11 | Protected records cannot be replaced/deleted through the correction shortcut; legal-hold evidence rejects every update, append and delete, even with approval or elevation. |
| A14 | Approval-required operations are durable, non-expiring, and safely projected to Family Inbox.                             |        3, 7, 11 | Restart/time-passage tests plus an assertion that the projection contains no protected payload or secret.                                                                   |
| A15 | Either Operator or Steward may independently resolve a parent/steward approval.                                           |           5, 11 | Each parent can approve/decline/cancel; Participant and unauthenticated callers cannot resolve.                                                                             |
| A16 | Approval execution revalidates target, authorization, policy, and current state.                                          |           5, 11 | Changed, deleted, newly protected, unauthorized, superseded, and impossible targets never execute stale intent.                                                             |
| A17 | Mutations are idempotent across process restart.                                                                          |           3, 11 | Same principal/operation/key/fingerprint yields one provider mutation; changed fingerprint returns `idempotency_conflict`.                                                  |
| A18 | Uncertain provider outcomes reconcile before retry.                                                                       |     3, 7, 8, 11 | A simulated post-provider timeout enters `outcome_unknown`; retry fetches markers/state rather than mutating again.                                                         |
| A19 | Provider outage produces bounded partial reads with explicit metadata.                                                    |              10 | An adapter that fails or ignores cancellation cannot block the deadline; successful results remain marked incomplete.                                                       |
| A20 | Every operation, denial, approval, elevation, and outcome emits metadata-only durable audit.                              |     3, 6, 10-12 | Audit-outbox tests cover delivery/retry and required fields while excluding bodies, tokens, and secret values.                                                              |
| A21 | Broad or protected destructive actions never execute as routine writes.                                                   |    3, 5, 11, 12 | Classification tests plus bound, one-time, five-minute Operator/Steward elevation challenges; replay/mismatch and Participant fail.                                         |
| A22 | PostgreSQL persists operational machinery but not the Brain corpus.                                                       |               3 | Migration/restart tests cover bindings, operations, approvals, versions, reconciliation, elevation, and audit outbox only.                                                  |
| A23 | Development identities/configuration cannot mutate production.                                                            |        2, 6, 13 | Cross-environment configuration and credential/root tests fail closed.                                                                                                      |
| A24 | Executable policy and Project Registry cannot silently drift from governance.                                             |     3, 5, 9, 13 | Hash/source-marker validation blocks CI or promotion on missing, malformed, added, removed, or mismatched state.                                                            |
| A25 | Core semantics remain testable without Google or provider SDKs.                                                           | 2, 5, 6, 10, 11 | Port contract and architecture tests run entirely against fakes and reject infrastructure imports in core.                                                                  |
| A26 | Required operational telemetry is emitted without content leakage.                                                        |        6, 10-13 | Tests observe request/provider/database latency, timeout, partial frequency, errors by code, and approval age/count.                                                        |
| A27 | Provider capability limitations are stable and non-destructive.                                                           |             7-9 | Notion search limitation and Drive MIME matrix are surfaced; unsupported writes return `provider_capability_unsupported`.                                                   |
| A28 | API limits and safe errors prevent abuse and disclosure.                                                                  |           2, 12 | Authentication, body/content-type, rate, timeout, request-ID, error-shape, and no-stack/no-secret tests.                                                                    |

## Manual and deployed acceptance

| ID  | Required evidence                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M01 | Anonymous calls to all eight Brain operations return no Brain data; liveness exposes no infrastructure detail.                                         |
| M02 | Cloud SQL has no public IP or authorized public network and is reachable only over the private runtime path.                                           |
| M03 | Negative API probes and log review show that provider secrets, tokens, SQL, and full protected content are absent.                                     |
| M04 | A real Operator AI client completes authorization-code plus PKCE and executes authenticated search/fetch.                                              |
| M05 | Operator or Steward reviews and resolves a pending request conversationally; PostgreSQL, Inbox projection, execution, and audit correlate.             |
| M06 | Representative cross-provider queries have acceptable relevance, bounded latency, clear partial-result behavior, and no authority-breaking duplicates. |
| M07 | The real client understands returned stable IDs, provenance, canonical location, completeness, and targeted-fetch guidance.                            |
| M08 | Operator completes the normal daily retrieve/write/update/append/delete/approval workflow against designated safe records.                             |
| M09 | Steward and Participant sign in separately and complete allowed and denied representative workflows without repeated technical intervention.           |
| M10 | Backup/PITR restore, migration rollback, provider reconciliation, alerting, and incident/runbook steps are exercised in development.                   |
| M11 | The production plan promotes the exact development-validated image digest and has owner-approved cost, retention, HA/recovery, and reader settings.    |

## Fixed interpretations

- `replace` is the destructive mode of `update_record`, not a ninth operation.
- The creator window is `elapsed <= 15 minutes`, using provider/gateway-owned
  metadata and an injected clock.
- Pending approvals do not expire with time. PostgreSQL is authoritative;
  Family Inbox is a safe projection.
- v1 deletion means recoverable provider trash/archive. Permanent purge is not
  exposed.
- Unauthorized providers are omitted from a principal's search fan-out; an
  authorized provider outage is reported explicitly as partial.
- Governance or Registry drift blocks production promotion. Runtime policy is
  deterministic and contains no autonomous model.
