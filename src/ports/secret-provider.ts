import type { EnvironmentName } from '../config/environment.js';

export interface SecretReference {
  readonly environment: EnvironmentName;
  readonly name: string;
  readonly version?: string;
}

/** A secret remains opaque to callers except at the adapter composition boundary. */
export interface SecretValue {
  readonly value: string;
  readonly version?: string;
}

export interface SecretProvider {
  get(reference: SecretReference, signal: AbortSignal): Promise<SecretValue>;
}
