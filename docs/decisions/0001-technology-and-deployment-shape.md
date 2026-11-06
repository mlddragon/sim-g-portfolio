# ADR 0001: Technology and deployment shape

> Sanitized design archive. Names and deployment identifiers are fictional. Dates, alternatives and decision states are historical; this document does not grant deployment access or approval. See the decision index for precedence and current limitations.

- Status: accepted
- Date: 2026-09-03
- Authorities: v1 PRD and Engineering Design

## Decision

Implement the gateway as a Node.js 24 LTS TypeScript service using Fastify, PostgreSQL, SQL migrations, Vitest, and pnpm. Provision the Example deployment with Terraform on Google Cloud Run, private-IP Cloud SQL for PostgreSQL, Secret Manager, Artifact Registry, structured Cloud Logging, and GitHub Actions workload identity federation.

Core domain and application modules must not import Google Cloud, Notion, Drive, GitHub, Fastify, or PostgreSQL packages. They depend on normalized port interfaces. Adapter capability types distinguish read-only providers from mutable providers so the GitHub adapter cannot expose mutation methods in v1.

Google human identity is verified as OIDC. The stable binding key is issuer plus immutable `sub`; email and hosted domain are validated constraints but do not act as the durable principal key. Clients cannot declare their own identity.

Provider-native deletion is recoverable in v1: Notion pages are moved to trash and Drive files are trashed. Permanent Drive deletion requires materially broader `organizer` privilege and is not part of the approved v1 operation contract.

## Why

The selected stack is mature, directly supported by the available Node.js 24 and pnpm toolchain, small enough for Cloud Run, and strongly typed enough to enforce provider capability and portability boundaries. Direct VPC egress with private ranges provides Cloud Run-to-Cloud SQL connectivity without public PostgreSQL exposure.

## Consequences

- Local and CI behavior tests run against in-memory ports and synthetic fixtures; PostgreSQL integration tests run against PostgreSQL 17.
- Live provider tests require isolated dev roots and owner-created credentials.
- Cloud provisioning remains blocked until billing-backed dev/prod project IDs, region, Workspace/OIDC details, and provider scopes are supplied.
- Provider search limitations are surfaced as completeness metadata rather than hidden.
