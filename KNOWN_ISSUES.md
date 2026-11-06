# Known security issues

This portfolio snapshot intentionally documents two unresolved, source-validated
security findings. Neither issue is fixed. Documentation makes the limitations
visible; it does not remove their impact. Do not treat this snapshot as cleared
for production use or deployment with real sensitive data.

| ID                                                       | Severity | Issue                                                          | Status        |
| -------------------------------------------------------- | -------- | -------------------------------------------------------------- | ------------- |
| [SIM-G-001](docs/issues/SIM-G-001-drive-append-race.md)  | Medium   | Drive append can overwrite an intervening edit                 | Open, unfixed |
| [SIM-G-002](docs/issues/SIM-G-002-notion-child-title.md) | Low      | An allowed Notion parent can disclose a restricted child title | Open, unfixed |

Each record describes the affected situation, bounded impact, available
workarounds, remediation direction and checks required before closing it.
The findings were validated through source review; no live-provider exploit or
real-user-data test was performed. Passing tests do not establish that these
uncovered cases are safe or that no other vulnerabilities exist.

Use synthetic fixtures for evaluation. Report newly suspected vulnerabilities
privately under [the security policy](SECURITY.md); do not include credentials,
provider payloads or real knowledge records in public reports.
