# Sanitization and refresh procedure

This is a local, unpublished, history-free mirror of a private project's
implementation and design decisions. It is intended for review without access to
the original knowledge systems or deployment environment.

## What is retained

- All 79 source files and 113 test/support paths from the reviewed implementation.
- Six SQL migrations, with fictional principals instead of real identities.
- Provider adapters, authorization and approval logic, audit/state handling,
  infrastructure templates, operating scripts and synthetic tests.
- The PRD, engineering design, implementation plan, acceptance matrix, threat
  model, architecture rulings and detailed hosting, recovery and connector decisions.
- Original alternatives and decision states, including unfinished and superseded work.

## What changes or stays private

Real people, organizations, hosted domains, private provider links, account numbers,
local user paths and operational source revisions are replaced or removed from the
design archive. These replacements are intentionally nonfunctional. The original
Git database, remote configuration, issues, releases, access settings, credentials,
runtime files, billing records and approval ledgers are not exported. Technical
lessons are separated from those private execution records.

The deployment workflow is an inactive example template. The source's deployment
permissions and approvals do not transfer to this mirror. Neither original household
data nor installed dependencies are vendored here. Third-party dependencies keep
their own licensing requirements. The initial portfolio release reserves rights,
recognizes GitHub's public viewing/forking terms and grants no additional reuse
license. Open-source licensing is deferred for a separate decision after V1 works.

## Updating the mirror

1. Select a new private-source snapshot and inspect its change list privately.
2. Export the intended source and decision documents into a separate review copy;
   do not fetch or push the private repository's refs into a public destination.
3. Replace identifying or operational values and preserve a private provenance map.
   Review new files and new kinds of data rather than relying only on old patterns.
4. Inspect the exact exported contents, run dedicated secret scanning and the
   documented checks, and review changes to design status and licensing.
5. Obtain owner approval of the exact files, terms and destination before publishing.

Updates are deliberate exports with review. There is no automatic synchronization
that could copy a future private commit or newly added operational record.

## Release scope and remaining checks

The portfolio snapshot intentionally retains the unfixed Drive append race and
nested Notion title-disclosure finding. Both are documented as open issues in
[KNOWN_ISSUES.md](../../KNOWN_ISSUES.md), with bounded impact, workarounds and
completion criteria. Their documented status does not make the affected behavior
safe for use with real sensitive data.

Publication uses the selected portfolio notice with rights reserved and GitHub's
public viewing/forking terms. The exact exported file set still requires its
final privacy, dedicated secret and IP checks and a selected public destination.
No original repository visibility change is required. No automatic synchronization
with the private source is configured.
