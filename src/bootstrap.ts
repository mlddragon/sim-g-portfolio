import type { FastifyInstance } from 'fastify';

import { buildApp, type ApiOptions } from './api/build-app.js';
import {
  ApprovalRequestCoordinator,
  ApprovalService,
} from './application/approval-service.js';
import { AuditedBrainOperations } from './application/audited-brain-operations.js';
import { AuthenticationService } from './application/authentication-service.js';
import { BrainQueryService } from './application/brain-query-service.js';
import { ElevationService } from './application/elevation-service.js';
import { MutationService } from './application/mutation-service.js';
import {
  AuthorizationEngine,
  type RegisteredKnowledgeSurface,
} from './domain/authorization/authorization-engine.js';
import { DestructiveClassifier } from './domain/authorization/destructive-classifier.js';
import type { ExecutablePolicy } from './domain/policy/policy-loader.js';
import { CanonicalRouter } from './domain/routing/canonical-router.js';
import type { ApprovalProjectionPort } from './ports/approval-projection.js';
import type { Clock } from './ports/clock.js';
import type { IdentityProvider } from './ports/identity-provider.js';
import type {
  FetchableKnowledgeProvider,
  MutableKnowledgeProvider,
} from './ports/knowledge-provider.js';
import type { OperationalStateStore } from './ports/operational-state-store.js';
import type { TelemetrySink } from './ports/telemetry-sink.js';

/**
 * Already-constructed adapters behind their ports. Building them from the
 * environment configuration (secrets, provider clients) is the runtime
 * entry point's job; this module only wires the application.
 */
export interface GatewayPorts {
  readonly store: OperationalStateStore;
  readonly identity: IdentityProvider;
  readonly providers: {
    readonly notion: MutableKnowledgeProvider;
    readonly drive: MutableKnowledgeProvider;
    /** GitHub is read-only. */
    readonly github: FetchableKnowledgeProvider;
  };
  readonly surfaces: readonly RegisteredKnowledgeSurface[];
  readonly approvalProjection: ApprovalProjectionPort;
  readonly policy: ExecutablePolicy;
  readonly clock: Clock;
  readonly telemetry?: TelemetrySink;
  readonly providerTimeoutMs?: number;
}

/**
 * The single composition of the gateway: every Brain operation reaches the
 * client only through `AuditedBrainOperations`, and identity only through
 * `AuthenticationService`.
 */
export async function composeGateway(
  ports: GatewayPorts,
  api: ApiOptions = {},
): Promise<FastifyInstance> {
  // A provider call that cannot finish before the request deadline could
  // never produce a usable partial result.
  const operationTimeoutMs = api.operationTimeoutMs ?? 25_000;
  if (
    ports.providerTimeoutMs !== undefined &&
    ports.providerTimeoutMs >= operationTimeoutMs
  ) {
    throw new TypeError('invalid_gateway_options');
  }
  const { store, clock, policy, telemetry } = ports;
  const authorization = new AuthorizationEngine(policy, clock);
  const mutations = new MutationService(
    authorization,
    new DestructiveClassifier(),
    new CanonicalRouter(policy),
    store,
    [ports.providers.notion, ports.providers.drive],
    ports.surfaces,
    clock,
    new ApprovalRequestCoordinator(
      store,
      ports.approvalProjection,
      clock,
      telemetry,
    ),
    new ElevationService(store, clock),
  );
  const query = new BrainQueryService(
    authorization,
    store,
    [ports.providers.notion, ports.providers.drive, ports.providers.github],
    ports.surfaces,
    {
      clock,
      ...(telemetry === undefined ? {} : { telemetry }),
      ...(ports.providerTimeoutMs === undefined
        ? {}
        : { providerTimeoutMs: ports.providerTimeoutMs }),
    },
  );
  const approvals = new ApprovalService(
    authorization,
    store,
    ports.approvalProjection,
    mutations,
    clock,
    telemetry,
  );
  const operations = new AuditedBrainOperations(
    { query, mutations, approvals },
    store,
    clock,
  );
  return buildApp(
    {
      authentication: new AuthenticationService(ports.identity, store),
      operations,
      clock,
    },
    api,
  );
}
