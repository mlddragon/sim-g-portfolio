# Architecture review guide

Requests enter src/api/build-app.ts after strict schema validation. Runtime
configuration and composition are in src/runtime/ and src/main.ts. Verified
identity maps issuer and subject to server-owned principals. Domain authorization
decides allowed, denied, approval-required or elevation-required outcomes before
provider mutation. Mutation state and the audit outbox are PostgreSQL-authoritative.

Ports isolate identity, secrets, governance, knowledge providers, operational state,
clock, audit and telemetry. Notion and Drive adapters enforce configured roots and
map provider records into one schema. The independent GitHub adapter pins reads to
commits and has no mutation capability. Runtime GitHub remains explicitly unavailable
until its real Registry binding and composition work are complete.

The VM templates use nginx ingress, non-root containers and a Unix-socket-only
PostgreSQL deployment. Backup tooling encrypts dumps to an operator-held recipient;
restore validation uses isolated containers and a held/approved evidence path.
Deploy tooling pins image digests and binds workload identity to a specific workflow.
The public candidate's deployment workflow is disabled as an example template.

The test suite is evidence of specified behavior, not proof of live security.
Read the runbooks for provider version races, uncertain outcomes and recovery limits.
