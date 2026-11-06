# SIM-G-002 An allowed Notion parent can disclose a restricted child title

- Status: open, unfixed
- Severity: low
- Validation: source-validated; no live-provider exploit performed
- Affected component: Notion retrieval across nested governed roots

## Impact and conditions

A caller who can retrieve an allowed parent page may receive the title of a
restricted child page or database when a more restrictive governed root is nested
inside the accessible root. The confirmed impact is title metadata disclosure.
Broader descendant-content disclosure was not established.

Direct retrieval of the restricted root is guarded. The problem occurs while
assembling the allowed ancestor's result, where authorization of the selected
parent does not establish authorization of every nested page boundary.

## Affected source

- Child-title projection:
  [notion-client.ts](../../src/adapters/notion/notion-client.ts#L394-L438)
- Parent fetch and child traversal:
  [notion-knowledge-provider.ts](../../src/adapters/notion/notion-knowledge-provider.ts#L145-L207)

Child page/database titles are represented as ordinary block text. The projected
block does not retain the page-boundary information needed for a fresh governed-root
check before returning that title.

## Workarounds and limits

Keep differently restricted roots as separate siblings rather than nesting a
restricted root under a broadly accessible root. Review provider sharing and root
mapping separately; do not assume a correct direct-fetch denial covers ancestor
rendering. Use fictional content and titles while evaluating the sample.

This is a configuration workaround for the described topology, not a code fix or
a guarantee about every possible provider boundary.

## Remediation direction

Preserve the child block type and page/database reference. Resolve and authorize
the child's governed root before including its title or traversing its subtree.
Omit unauthorized child information rather than inheriting the parent's access.

## Completion criteria

- Add a regression that fetches an allowed parent containing a restricted root.
- Assert that restricted child titles are absent from the returned content.
- Check child databases as well as child pages and preserve valid sibling results.
- Retain direct-fetch denial and bounded traversal behavior.
- Demonstrate the fix before changing this issue's status to resolved.

## Tracking identity

Canonical finding ID: `csf_23f3e2135c50a93f63faf07f`

Primary fingerprint:
`codex-security/v1:sha256:f2a641d77c23327008be2497f010388562109c9d2c7cc45e76b62d59e4bc4e4e`
