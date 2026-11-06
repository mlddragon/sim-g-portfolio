import { DomainError } from '../errors.js';
import type { MutationOperationName, SemanticMetadata } from '../operations.js';
import type { ExecutablePolicy } from '../policy/policy-loader.js';
import type { CanonicalLocation, KnowledgeProviderName } from '../records.js';

export type WritableKnowledgeProviderName = Exclude<
  KnowledgeProviderName,
  'github'
>;

export interface CanonicalRoute {
  readonly provider: WritableKnowledgeProviderName;
  readonly containerKey: string;
  readonly operation: MutationOperationName;
  readonly policyVersion: string;
  readonly routingReason: string;
}

export interface NewKnowledgeRouteRequest {
  readonly operation: 'persist_knowledge';
  readonly semanticMetadata: SemanticMetadata;
}

export interface ExistingKnowledgeRouteRequest {
  readonly operation: Exclude<MutationOperationName, 'persist_knowledge'>;
  readonly canonicalLocation: CanonicalLocation;
}

const routingQuestion =
  'Confirm whether this is durable structured knowledge or a canonical source file.';

function githubReadOnly(): never {
  throw new DomainError('provider_capability_unsupported', false, {
    provider: 'github',
    reason: 'github_read_only',
  });
}

export class CanonicalRouter {
  constructor(private readonly policy: ExecutablePolicy) {}

  route(request: NewKnowledgeRouteRequest): CanonicalRoute {
    const metadata = request.semanticMetadata;
    const missing: string[] = [];
    const recordType = metadata.recordType;
    const durability = metadata.durability;
    const sensitivity = metadata.sensitivity;
    if (recordType === undefined) missing.push('record_type');
    if (durability === undefined) missing.push('durability');
    if (sensitivity === undefined) missing.push('sensitivity');
    if (missing.length > 0) {
      throw new DomainError('insufficient_metadata', true, { missing });
    }

    // The exhaustive missing-field check above is the public error contract.
    if (
      recordType === undefined ||
      durability === undefined ||
      sensitivity === undefined
    ) {
      throw new DomainError('internal_error', false, {
        reason: 'routing_metadata_narrowing_failed',
      });
    }

    if (metadata.canonicalHint?.provider === 'github') {
      githubReadOnly();
    }

    const provider = this.providerForRecordType(recordType);
    if (
      metadata.canonicalHint?.provider !== undefined &&
      metadata.canonicalHint.provider !== provider
    ) {
      throw new DomainError('routing_ambiguous', true, {
        candidates: [provider, metadata.canonicalHint.provider],
        required_decision: routingQuestion,
      });
    }

    const containerKey = this.policy.routing.containers[provider][sensitivity];
    if (
      metadata.canonicalHint?.containerRef !== undefined &&
      metadata.canonicalHint.containerRef !== containerKey
    ) {
      throw new DomainError('routing_ambiguous', true, {
        candidates: [provider],
        reason: 'canonical_container_hint_conflict',
        required_decision: 'Remove the unregistered container hint.',
      });
    }

    return {
      provider,
      containerKey,
      operation: request.operation,
      policyVersion: this.policy.version,
      routingReason: `record_type_${recordType}`,
    };
  }

  routeExisting(request: ExistingKnowledgeRouteRequest): CanonicalRoute {
    const provider = request.canonicalLocation.provider;
    if (provider === 'github') {
      githubReadOnly();
    }
    const governedContainers = Object.values(
      this.policy.routing.containers[provider],
    );
    if (!governedContainers.includes(request.canonicalLocation.containerRef)) {
      throw new DomainError('provider_capability_unsupported', false, {
        provider,
        reason: 'canonical_container_not_governed',
      });
    }
    return {
      provider,
      containerKey: request.canonicalLocation.containerRef,
      operation: request.operation,
      policyVersion: this.policy.version,
      routingReason: 'authoritative_existing_record_location',
    };
  }

  private providerForRecordType(
    recordType: string,
  ): WritableKnowledgeProviderName {
    if (
      (this.policy.routing.notionRecordTypes as readonly string[]).includes(
        recordType,
      )
    ) {
      return 'notion';
    }
    if (
      (this.policy.routing.driveRecordTypes as readonly string[]).includes(
        recordType,
      )
    ) {
      return 'drive';
    }
    throw new DomainError('routing_ambiguous', true, {
      candidates: ['notion', 'drive'],
      reason: 'unsupported_record_type',
      required_decision: routingQuestion,
    });
  }
}
