import {
  environmentNames,
  type EnvironmentName,
} from '../../config/environment.js';
import { DomainError } from '../../domain/errors.js';
import type {
  SecretProvider,
  SecretReference,
  SecretValue,
} from '../../ports/secret-provider.js';

export interface EnvironmentSecretProviderOptions {
  readonly environment: EnvironmentName;
  /** Trusted composition-time allowlist: logical name -> local variable name. */
  readonly bindings: Readonly<Record<string, string>>;
  /** Explicitly injected; never falls back to the host's process.env. */
  readonly environmentValues: Readonly<Record<string, string | undefined>>;
}

const logicalSecretName = /^[a-z][a-z0-9_-]{0,127}$/u;
const environmentVariableName = /^[A-Z_][A-Z0-9_]{0,127}$/u;

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownData(record: unknown, key: string): unknown {
  if (!isRecord(record)) throw new TypeError('invalid_secret_input');
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError('invalid_secret_input');
  }
  return descriptor?.value as unknown;
}

function invalidConfiguration(): DomainError {
  return new DomainError('invalid_request', false, {
    reason: 'invalid_environment_secret_configuration',
  });
}

function forbiddenEnvironment(): DomainError {
  return new DomainError('environment_boundary_violation', false, {
    reason: 'environment_secret_provider_not_allowed',
  });
}

function cancelled(): DOMException {
  return new DOMException('Secret resolution cancelled', 'AbortError');
}

function isCancelled(signal: AbortSignal): boolean {
  // An injected source can abort synchronously; always reread the live state.
  return signal.aborted;
}

/** Internal local-development adapter; never a public secret endpoint. */
export class EnvironmentSecretProvider implements SecretProvider {
  readonly #environment: 'development' | 'test';
  readonly #bindings: ReadonlyMap<string, string>;
  // Keep a live source reference, not cached values, so revocation takes effect
  // on the next read. Private fields prevent accidental instance serialization.
  readonly #environmentValues: object;

  constructor(options: EnvironmentSecretProviderOptions) {
    let environment: unknown;
    try {
      environment = ownData(options, 'environment');
    } catch {
      throw invalidConfiguration();
    }
    if (environment === 'production') throw forbiddenEnvironment();
    if (environment !== 'development' && environment !== 'test') {
      throw invalidConfiguration();
    }
    this.#environment = environment;
    try {
      const bindings = ownData(options, 'bindings');
      const values = ownData(options, 'environmentValues');
      if (!isRecord(bindings) || !isRecord(values))
        throw invalidConfiguration();
      const prototype: unknown = Object.getPrototypeOf(bindings);
      if (prototype !== Object.prototype && prototype !== null)
        throw invalidConfiguration();
      const snapshot = new Map<string, string>();
      for (const name of Object.getOwnPropertyNames(bindings)) {
        const variable = ownData(bindings, name);
        if (
          !logicalSecretName.test(name) ||
          typeof variable !== 'string' ||
          !environmentVariableName.test(variable)
        ) {
          throw invalidConfiguration();
        }
        snapshot.set(name, variable);
      }
      this.#bindings = snapshot;
      this.#environmentValues = values;
    } catch {
      // Never include the raw configuration or errors from accessors/proxies.
      throw invalidConfiguration();
    }
  }

  get(reference: SecretReference, signal: AbortSignal): Promise<SecretValue> {
    if (isCancelled(signal)) return Promise.reject(cancelled());
    let environment: unknown;
    let name: unknown;
    try {
      environment = ownData(reference, 'environment');
      name = ownData(reference, 'name');
      const version = ownData(reference, 'version');
      if (
        !environmentNames.some((allowed) => allowed === environment) ||
        typeof name !== 'string' ||
        !logicalSecretName.test(name) ||
        version !== undefined
      ) {
        throw new TypeError('invalid_secret_reference');
      }
    } catch {
      return Promise.reject(
        new DomainError('invalid_request', false, {
          reason: 'invalid_environment_secret_reference',
        }),
      );
    }
    if (environment !== this.#environment)
      return Promise.reject(forbiddenEnvironment());
    const variable = this.#bindings.get(name);
    if (variable === undefined) return Promise.reject(this.notConfigured());

    let value: unknown;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(
        this.#environmentValues,
        variable,
      );
      // Accessors and inherited values are not process-environment entries.
      value = descriptor?.value as unknown;
    } catch {
      if (isCancelled(signal)) return Promise.reject(cancelled());
      return Promise.reject(
        new DomainError('provider_unavailable', true, {
          reason: 'environment_secret_read_failed',
        }),
      );
    }
    if (isCancelled(signal)) return Promise.reject(cancelled());
    if (typeof value !== 'string' || value.trim().length === 0) {
      return Promise.reject(this.notConfigured());
    }
    // 'environment' identifies the unversioned source; callers cannot pin it.
    return Promise.resolve({ value, version: 'environment' });
  }

  private notConfigured(): DomainError {
    return new DomainError('not_found', false, {
      reason: 'secret_not_configured',
    });
  }
}
