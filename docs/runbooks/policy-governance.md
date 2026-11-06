# Policy and governance verification

The repository contains executable authorization and canonical-routing policy.
Human-readable Family Brain governance remains authoritative for intended
behavior. The lock files make disagreement explicit and block deployment rather
than silently selecting one source.

## Checked-in artifacts

- `config/policy/family-brain-v1.yaml` contains the exact v1 role, scope,
  operation, correction-window, elevation-window, and routing policy.
- `legalHoldEvidence: immutable` (added in `family-brain-v1.1.0` from the
  2026-10-22 owner decision) makes the authorization engine deny every
  mutation of a `legal_hold` target before approval, elevation or creator-window
  logic. Reads and separate new records are unaffected. Adapters assign
  `legal_hold` per governed root from configuration, so everything under such a
  root is immutable; keep derived working notes and indexes in a separate,
  non-legal-hold root.
- `containerPolicies` (added in `family-brain-v1.2.0` from the 2026-10-24 owner
  decision) assigns each governed routing container its record policy, the
  same for Notion and Drive:

  | Container                | Scope                    | Sensitivity              | Protected class |
  | ------------------------ | ------------------------ | ------------------------ | --------------- |
  | `family_shared`          | `family_shared`          | `family_shared`          | `none`          |
  | `parent_and_stewardship` | `parent_and_stewardship` | `parent_and_stewardship` | `none`          |
  | `protected`              | `legal`                  | `protected`              | `protected`     |

  The mapping is pinned exactly by the policy schema, so a changed entry fails
  to load. The generic `restricted` container is deliberately not registered:
  restricted (P3) records need explicit, narrowly scoped access and must not
  become readable by both parents merely because they are restricted. A record
  routed there fails closed until separately authorized restricted roots are
  defined. `legal` access stays with Operator and Steward. A root's scope and
  sensitivity come only from this mapping, never from configuration;
  configuration may only tighten a `protected` root to `legal_hold`. Nested
  roots resolve to the nearest configured root, so a `protected` root inside a
  Family Shared tree governs everything under it, and a caller without its scope
  is denied rather than falling back to the outer root. Never configure a less
  restrictive root inside a more restrictive one. Registered surfaces carry the container's
  protected class, so a create in the `protected` container is sent with the
  exact root policy the providers require. No Notion or Drive root carries
  `legal_hold` until provider settings (F12h) allow tightening a `protected`
  root; the immutability rule itself is unchanged.

- Before deploying a policy version bump, inspect and drain operations in
  `ELEVATION_PENDING`, `APPROVAL_PENDING`, `EXECUTING` and `OUTCOME_UNKNOWN`:
  challenges and approvals bound to the previous version are voided (superseded
  or failed), and an elevated uncertain outcome from the previous version can no
  longer reconcile automatically.
- `config/policy/governance-lock.json` binds the executable policy bytes and,
  once onboarding is complete, the authoritative governance source marker.
- `config/policy/project-registry.yaml` is the only repository allowlist input.
  It intentionally begins empty, so GitHub retrieval is fail-closed.
- `config/policy/project-registry-lock.json` binds the exact registry snapshot.

Run the deterministic local check from any working directory:

```bash
pnpm --dir /path/to/example-family-brain-gateway policy:verify
```

`pnpm verify` includes the same check, and CI runs it as a named gate. The
command validates strict schemas, exact policy versions, SHA-256 bindings, the
Project Registry marker, and the empty allowlist without contacting a provider.

## Live governance validation

Deployment validation loads canonical governance and the Project Registry only
through the provider-neutral `GovernanceSource` port. Source references come
from environment-specific variables named in the locks; a source reference is
never accepted from a request. Validation requires an exact match for artifact
kind, source reference, version, content hash, canonical marker, and content
integrity.

The canonical governance and Project Registry live bindings are currently
`pending`. This is deliberate: exact checked-in policy and empty-Registry bytes
remain hash-locked for local development, but dev or production promotion and
live Registry loading must fail with `policy_drift` until each isolated
authoritative source is connected and reviewed. Provider credential visibility
alone never registers a repository.

## Controlled update procedure

1. Confirm the proposed human-readable governance change is approved and note
   the exact environment and authoritative source.
2. Update the executable policy or Project Registry with the smallest matching
   change. Never add a repository because a GitHub App can see it.
3. Bump the relevant version or marker and calculate a new SHA-256 over the
   exact artifact bytes.
4. Update the corresponding lock in the same reviewed change.
5. Add or update table-driven tests for every affected role, operation, scope,
   boundary, and routing result.
6. Run `pnpm policy:verify`, the focused policy suites, and `pnpm verify`.
7. In the target environment, run live governance validation before deployment.

Never resolve drift by weakening a schema, accepting multiple possible hashes,
trusting client metadata, or asking an LLM to interpret governance at request
time. Unexpected drift is a release blocker.
