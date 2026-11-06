import {
  Compute,
  GoogleAuth,
  Impersonated,
  JWT,
  type AuthClient,
} from 'google-auth-library';

import type { EnvironmentConfig } from '../config/environment.js';

/** The governed roots are enforced by the root guard; this is the API scope. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const sourceScope = 'https://www.googleapis.com/auth/cloud-platform';
const tokenLifetimeSeconds = 3_600;
const serviceAccountEmail =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u;

export interface DriveWorkloadAuthOptions {
  /** The runtime's own credentials; defaults to Application Default Credentials. */
  readonly sourceClient?: () => Promise<AuthClient>;
}

/**
 * Drive authenticates as its dedicated machine identity: the runtime's own
 * service account impersonates the configured Drive service account with only
 * the Drive scope. The source is allowlisted, never denylisted: the Cloud Run
 * metadata-server identity everywhere, and a service-account key outside
 * production. User, workforce-user and chained (impersonated) credentials are
 * refused, so a human token can never become the Drive source.
 */
export async function createDriveWorkloadAuth(
  config: EnvironmentConfig,
  options: DriveWorkloadAuthOptions = {},
): Promise<Impersonated> {
  const { machineIdentity, credential } = config.providers.drive;
  if (
    credential.kind !== 'workload_identity' ||
    !serviceAccountEmail.test(machineIdentity.id)
  ) {
    throw new TypeError('invalid_provider_configuration');
  }
  const source = await (
    options.sourceClient ??
    (() => new GoogleAuth({ scopes: [sourceScope] }).getClient())
  )();
  const machine =
    source instanceof Compute ||
    (config.environment !== 'production' && source instanceof JWT);
  if (!machine) throw new TypeError('source_credential_refused');
  return new Impersonated({
    sourceClient: source,
    targetPrincipal: machineIdentity.id,
    targetScopes: [DRIVE_SCOPE],
    delegates: [],
    lifetime: tokenLifetimeSeconds,
  });
}
