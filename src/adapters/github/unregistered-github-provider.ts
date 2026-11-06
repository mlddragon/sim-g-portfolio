import { DomainError } from '../../domain/errors.js';
import type {
  FetchableKnowledgeProvider,
  ProviderFetchRequest,
  ProviderSearchRequest,
  ProviderSearchResponse,
} from '../../ports/knowledge-provider.js';
import type { BrainRecord } from '../../domain/records.js';

function unbound(): DomainError {
  return new DomainError('provider_unavailable', true, {
    reason: 'github_registry_unbound',
  });
}

/**
 * GitHub until the canonical Project Registry is bound (owner decision
 * 2026-10-24): visibly unavailable in search completeness, never reading the
 * checked-in snapshot as if it were the live Registry.
 */
export class UnregisteredGitHubProvider implements FetchableKnowledgeProvider {
  readonly provider = 'github' as const;
  readonly availability = 'unavailable' as const;

  search(
    _request: ProviderSearchRequest,
    _signal: AbortSignal,
  ): Promise<ProviderSearchResponse> {
    return Promise.reject(unbound());
  }

  fetch(
    _request: ProviderFetchRequest,
    _signal: AbortSignal,
  ): Promise<BrainRecord> {
    return Promise.reject(unbound());
  }
}
