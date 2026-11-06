# Provider-neutral telemetry

> **Hosting note (2026-10-24).** Cloud Run references below describe the
> earlier deployment target. Production is now one Compute Engine `e2-micro`
> (PLAN Task 13). F13c revisits the production defaults that assumed Cloud Run:
> `GATEWAY_TRUSTED_PROXY_HOPS` 1, `GATEWAY_HOST` `0.0.0.0`, and the shutdown
> grace period. Until then, set them explicitly for the VM's actual ingress.

`TelemetrySink` is the core port for operational observations: request totals
and durations, authentication, policy, routing, provider and database
durations, provider timeouts, partial searches, error counts, and approval queue
size and age. Core services emit observations through `observeTelemetry`, which
never lets telemetry change authorization or a client-visible result.

## Cloud Logging adapter

`CloudLoggingTelemetrySink` writes one structured JSON line per observation to
stdout with `severity: INFO` and `logType: family_brain_telemetry`, for
Cloud Run's Cloud Logging agent and future log-based metrics (F13).

- **Closed vocabulary.** Only metric names from the port enum are written. Labels
  are limited to `operation` (Brain operations and Family Inbox projection
  steps), `outcome` (`complete`, `partial`, `denied`, `cancelled`, `failed`),
  `code` (domain error codes or `read_failed`), `provider` and `unit`, each with
  an allowlisted value. Any other key or value is dropped, so queries,
  identifiers, principals and content can never be written.
- **Strict snapshot.** Only own data properties are read; getters are never
  invoked. Non-plain tag objects, unknown kinds, non-finite numbers and negative
  counters or durations drop the whole observation.
- **Best effort.** `observe` never throws. Writes use a dedicated bounded
  stdout destination, separate from the audit destination's single pending
  write. Up to 16 writes may be in flight, so a same-tick burst (for example a
  partial search's request, duration, partial and timeout observations) is
  kept; beyond that, or while stdout needs to drain, observations are dropped
  rather than queued. Each write gives up after a one-second timeout, but its
  in-flight slot is released only when the stream callback fires, so a stdout
  that never drains drops later telemetry rather than growing memory. A failed,
  hung or synchronously throwing destination, a hostile proxy, or a failing
  clock drops the observation.
- **Drift guard.** The search, fetch and approval service tests run every
  observation those services really emit through the adapter and fail if any
  label would be dropped.

## Known limits

- Telemetry is lossy by design; durable, correlated records belong to the audit
  outbox, not telemetry.
- The adapter is not yet composed into a runtime; F12/F13 wire it and define the
  log-based metrics.
