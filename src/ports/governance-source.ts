import type { EnvironmentName } from '../config/environment.js';

export type GovernanceArtifactKind =
  'canonical_governance' | 'executable_policy' | 'project_registry';

export interface GovernanceArtifactReference {
  readonly environment: EnvironmentName;
  readonly kind: GovernanceArtifactKind;
  readonly sourceReference: string;
}

export interface GovernanceSnapshot {
  readonly kind: GovernanceArtifactKind;
  readonly version: string;
  readonly contentHash: string;
  readonly canonicalMarker: string;
  readonly sourceReference: string;
  readonly content: string;
  readonly loadedAt: Date;
}

export interface GovernanceSource {
  load(
    reference: GovernanceArtifactReference,
    signal: AbortSignal,
  ): Promise<GovernanceSnapshot>;
}
