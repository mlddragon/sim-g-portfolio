import type { RegisteredKnowledgeSurface } from '../authorization/authorization-engine.js';
import type { RecordPolicyMetadata } from '../records.js';
import type { ExecutablePolicy } from './policy-loader.js';

type RegisteredContainer = keyof ExecutablePolicy['containerPolicies'];

const registeredContainers: readonly RegisteredContainer[] = [
  'family_shared',
  'parent_and_stewardship',
  'protected',
];
const mutableProviders = ['notion', 'drive'] as const;

/**
 * The record policy of a routing container, from the executable policy only.
 * An unregistered container (such as the generic restricted one) has none, so
 * it can never be configured as a governed root.
 */
export function containerRecordPolicy(
  policy: ExecutablePolicy,
  containerKey: string,
): RecordPolicyMetadata | undefined {
  for (const provider of mutableProviders) {
    for (const container of registeredContainers) {
      if (policy.routing.containers[provider][container] === containerKey) {
        return policy.containerPolicies[container];
      }
    }
  }
  return undefined;
}

/** The registered knowledge surfaces the policy defines, in a stable order. */
export function registeredSurfaces(
  policy: ExecutablePolicy,
): readonly RegisteredKnowledgeSurface[] {
  return mutableProviders.flatMap((provider) =>
    registeredContainers.map((container) => ({
      provider,
      containerKey: policy.routing.containers[provider][container],
      scope: policy.containerPolicies[container].scope,
      protectedClass: policy.containerPolicies[container].protectedClass,
    })),
  );
}
