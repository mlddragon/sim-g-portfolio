import { readFile } from 'node:fs/promises';

import pg, { type Pool } from 'pg';

import { GoogleOidcIdentityProvider } from '../adapters/identity/google-oidc-identity-provider.js';
import { createPostgresPool } from '../adapters/state/postgres/pool.js';
import { EnvironmentSecretProvider } from '../adapters/secrets/environment-secret-provider.js';
import {
  GoogleSecretManagerProvider,
  type SecretVersionAccessClient,
} from '../adapters/secrets/google-secret-manager-provider.js';
import {
  parseEnvironment,
  type EnvironmentConfig,
} from '../config/environment.js';
import { DomainError } from '../domain/errors.js';
import {
  verifyPolicyBundle,
  type VerifiedPolicyBundle,
} from '../domain/policy/governance-validator.js';
import type { IdentityProvider } from '../ports/identity-provider.js';
import type { SecretProvider } from '../ports/secret-provider.js';

const maximumConfigBytes = 64 * 1024;

function unloadable(
  reason:
    | 'environment_configuration_unreadable'
    | 'environment_configuration_too_large'
    | 'environment_configuration_malformed',
): DomainError {
  return new DomainError('invalid_request', false, { reason });
}

/**
 * Reads and validates the environment configuration document. Each read or
 * parse failure has a fixed, path-free reason and never carries the content or
 * cause; schema failures and environment-boundary violations come from
 * `parseEnvironment` with only safe paths.
 */
export async function loadEnvironmentConfig(
  path: string,
  read: (path: string) => Promise<string> = (file) => readFile(file, 'utf8'),
): Promise<EnvironmentConfig> {
  let content: string;
  try {
    content = await read(path);
  } catch {
    throw unloadable('environment_configuration_unreadable');
  }
  if (Buffer.byteLength(content, 'utf8') > maximumConfigBytes) {
    throw unloadable('environment_configuration_too_large');
  }
  let document: unknown;
  try {
    document = JSON.parse(content.replace(/^\uFEFF/u, '')) as unknown;
  } catch {
    throw unloadable('environment_configuration_malformed');
  }
  return parseEnvironment(document);
}

export interface SecretProviderSources {
  /** The process environment for the `environment` provider; never implicit. */
  readonly environmentValues?: Readonly<Record<string, string | undefined>>;
  /** Injected for tests; otherwise the official client with runtime identity. */
  readonly secretManagerClient?: SecretVersionAccessClient;
}

/** The secret provider the configuration selects for its environment. */
export function createSecretProvider(
  config: EnvironmentConfig,
  sources: SecretProviderSources,
): SecretProvider {
  const { secrets } = config;
  if (secrets.provider === 'environment') {
    if (
      sources.environmentValues === undefined ||
      config.environment === 'production'
    ) {
      throw new TypeError('invalid_runtime_options');
    }
    return new EnvironmentSecretProvider({
      environment: config.environment,
      bindings: secrets.bindings,
      environmentValues: sources.environmentValues,
    });
  }
  if (config.environment === 'test') {
    throw new TypeError('invalid_runtime_options');
  }
  return new GoogleSecretManagerProvider({
    environment: config.environment,
    projectNumber: secrets.projectNumber,
    bindings: secrets.bindings,
    ...(sources.secretManagerClient === undefined
      ? {}
      : { client: sources.secretManagerClient }),
  });
}

function invalidDatabaseSecret(): DomainError {
  return new DomainError('invalid_request', false, {
    reason: 'invalid_database_connection_secret',
  });
}

/**
 * A deployment's required database transport. `unix_socket` is the e2-micro
 * VM (owner decision 2026-10-27, Option A): only the local socket is accepted
 * there, even where the general rules would allow verified TLS TCP.
 */
export type DatabaseTransport = 'unix_socket';

export interface DatabaseUrlOptions {
  readonly transport?: DatabaseTransport;
}

// The only accepted socket directory: PostgreSQL on the same VM, with no TCP
// listener (e2-micro design section 6). Any other directory is refused, so a
// socket can never be aliased from elsewhere.
const localSocketDirectory = '/run/postgresql';
// Allowlisted query keys. Anything else (`ssl`, `uselibpqcompat`, `user`,
// `options`, `replication`, `hostaddr`, certificate files, ...) is refused.
const socketParameters: ReadonlySet<string> = new Set(['host']);
const tcpParameters: ReadonlySet<string> = new Set(['sslmode']);
// The client treats require and verify-ca as verify-full only through a
// deprecation alias; demand verify-full itself.
const verifiedTlsMode = 'verify-full';
// No IPv6 literal host is accepted: the client keeps the brackets in its
// host, so it never matches the parsed hostname.
const loopbackHosts: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);
// Every `%` must start a valid escape; whitespace and controls are refused,
// because the client re-encodes such strings and can then read a different
// host than this validator.
const malformedEscape = /%(?![0-9A-Fa-f]{2})/u;
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/u.test(character)) return true;
  }
  return false;
}
// `user:password@/database` (no TCP host) is the socket form. WHATWG URL
// rejects credentials without a host, so a placeholder host is used only to
// parse it.
const emptyHost = /^(postgres(?:ql)?:\/\/(?:[^@/?#]*@)?)\//u;

/** What node-postgres itself will use for this connection string. */
function clientView(value: string) {
  const client = new pg.Client({ connectionString: value });
  return {
    host: client.host,
    ssl: client.ssl as unknown,
  };
}

function verifiedTls(ssl: unknown): boolean {
  return (
    typeof ssl === 'object' &&
    ssl !== null &&
    (ssl as { rejectUnauthorized?: unknown }).rejectUnauthorized !== false
  );
}

/**
 * Resolves the database connection URL; the value is never echoed. Two
 * connectivity forms are accepted:
 * - the local socket `user:password@/database?host=/run/postgresql`, with a
 *   database and, in production, a role and password (SCRAM over the socket);
 * - TCP to a named host, with `sslmode=verify-full`, except that outside
 *   production a loopback host may omit TLS.
 * Validation covers both this parser and what node-postgres will actually use,
 * so the two can never disagree about the host or TLS. A deployment that
 * requires the socket (`transport: 'unix_socket'`) refuses every TCP form.
 */
export async function resolveDatabaseUrl(
  config: EnvironmentConfig,
  secrets: SecretProvider,
  signal: AbortSignal,
  options: DatabaseUrlOptions = {},
): Promise<string> {
  const { value } = await secrets.get(
    {
      environment: config.environment,
      name: config.database.connectionSecret.name,
    },
    signal,
  );
  if (
    value !== value.trim() ||
    malformedEscape.test(value) ||
    hasUnsafeCharacter(value)
  ) {
    throw invalidDatabaseSecret();
  }
  const socketForm = emptyHost.test(value);
  let url: URL;
  try {
    url = new URL(
      socketForm ? value.replace(emptyHost, '$1socket.invalid/') : value,
    );
  } catch {
    throw invalidDatabaseSecret();
  }
  const parameters = url.searchParams;
  const keys = [...parameters.keys()];
  if (
    (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') ||
    new Set(keys).size !== keys.length ||
    url.pathname.length <= 1 ||
    url.hash.length > 0
  ) {
    throw invalidDatabaseSecret();
  }
  const production = config.environment === 'production';
  // Allowlist first: the client's parser reads certificate files and throws
  // on unknown modes, so it must only ever see an already-allowed shape.
  const socketKeys = parameters.has('host');
  if (
    keys.some(
      (key) => !(socketKeys ? socketParameters : tcpParameters).has(key),
    )
  ) {
    throw invalidDatabaseSecret();
  }
  // Only verify-full, or disable for a development loopback host, is ever
  // accepted. Refuse the rest here, before the client parses them: it would
  // print an unstructured security warning for the alias modes.
  const sslmode = parameters.get('sslmode');
  if (
    sslmode !== null &&
    sslmode !== verifiedTlsMode &&
    sslmode !== 'disable'
  ) {
    throw invalidDatabaseSecret();
  }
  let view: ReturnType<typeof clientView>;
  try {
    view = clientView(value);
  } catch {
    throw invalidDatabaseSecret();
  }

  if (parameters.has('host')) {
    // A socket connection has no TCP host to confuse it with.
    if (
      !socketForm ||
      keys.some((key) => !socketParameters.has(key)) ||
      parameters.get('host') !== localSocketDirectory ||
      view.host !== localSocketDirectory ||
      Boolean(view.ssl) ||
      (production && (url.username.length === 0 || url.password.length === 0))
    ) {
      throw invalidDatabaseSecret();
    }
    return value;
  }
  if (options.transport === 'unix_socket') {
    throw new DomainError('invalid_request', false, {
      reason: 'database_socket_required',
    });
  }

  const hostname = url.hostname.replace(/^\[(.*)\]$/u, '$1');
  if (
    socketForm ||
    hostname.length === 0 ||
    url.hostname.includes('%') ||
    keys.some((key) => !tcpParameters.has(key)) ||
    view.host.startsWith('/') ||
    view.host.toLowerCase() !== hostname.toLowerCase()
  ) {
    throw invalidDatabaseSecret();
  }
  const tlsRequired = production || !loopbackHosts.has(hostname.toLowerCase());
  if (
    tlsRequired &&
    (parameters.get('sslmode') !== verifiedTlsMode || !verifiedTls(view.ssl))
  ) {
    throw invalidDatabaseSecret();
  }
  return value;
}

/** A bounded pool; it connects lazily, so creating it never contacts PostgreSQL. */
export function createDatabasePool(
  connectionString: string,
  onIdleClientError?: (line: string) => void,
): Pool {
  return createPostgresPool({
    connectionString,
    applicationName: 'family-brain-gateway',
    ...(onIdleClientError === undefined ? {} : { onIdleClientError }),
  });
}

/** Loads the four governed policy files and verifies them against the locks. */
export async function loadVerifiedPolicyBundle(
  directory: URL,
  read: (file: URL) => Promise<string> = (file) => readFile(file, 'utf8'),
): Promise<VerifiedPolicyBundle> {
  // Without the slash, relative file names would resolve in the parent.
  if (!directory.pathname.endsWith('/')) {
    throw new TypeError('invalid_policy_directory');
  }
  const [
    policyContent,
    governanceLockContent,
    projectRegistryContent,
    projectRegistryLockContent,
  ] = await Promise.all(
    [
      'family-brain-v1.yaml',
      'governance-lock.json',
      'project-registry.yaml',
      'project-registry-lock.json',
    ].map((name) => read(new URL(name, directory))),
  );
  return verifyPolicyBundle({
    policyContent: policyContent ?? '',
    governanceLockContent: governanceLockContent ?? '',
    projectRegistryContent: projectRegistryContent ?? '',
    projectRegistryLockContent: projectRegistryLockContent ?? '',
  });
}

/** The Google Workspace OIDC verifier for the configured audience and domain. */
export function createIdentityProvider(
  config: EnvironmentConfig,
): IdentityProvider {
  return new GoogleOidcIdentityProvider({
    issuer: config.identity.issuer,
    audience: config.identity.audience,
    hostedDomain: config.identity.hostedDomain,
  });
}
