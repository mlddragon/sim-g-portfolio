import {
  Compute,
  ExternalAccountAuthorizedUserClient,
  Impersonated,
  JWT,
  UserRefreshClient,
} from 'google-auth-library';
import { describe, expect, it } from 'vitest';

import { parseEnvironment } from '../../../src/config/environment.js';
import {
  DRIVE_SCOPE,
  createDriveWorkloadAuth,
} from '../../../src/runtime/drive-auth.js';
import { syntheticConfigDocument } from '../../support/environment-fixtures.js';

const serviceAccount =
  'brain-drive-dev@example-brain-dev.iam.gserviceaccount.com';

function config(
  machineIdentity = serviceAccount,
  environment: 'development' | 'production' = 'development',
) {
  const document = syntheticConfigDocument(environment) as unknown as {
    providers: { drive: { machineIdentity: { id: string } } };
  };
  document.providers.drive.machineIdentity.id = machineIdentity;
  return parseEnvironment(document);
}

/** The Cloud Run runtime identity: the metadata-server client. */
const runtimeIdentity = new Compute();
const human = () =>
  new UserRefreshClient({
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
    refreshToken: 'synthetic-refresh',
  });
const keyFile = () =>
  new JWT({
    email: 'runner@example-brain-dev.iam.gserviceaccount.com',
    key: 'synthetic-key',
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

describe('createDriveWorkloadAuth', () => {
  it('impersonates the configured Drive machine identity with the Drive scope only', async () => {
    const auth = await createDriveWorkloadAuth(config(), {
      sourceClient: () => Promise.resolve(runtimeIdentity),
    });

    expect(auth).toBeInstanceOf(Impersonated);
    const fields = auth as unknown as {
      targetPrincipal: string;
      targetScopes: string[];
      delegates: string[];
    };
    expect(fields.targetPrincipal).toBe(serviceAccount);
    expect(fields.targetScopes).toEqual([DRIVE_SCOPE]);
    expect(fields.delegates).toEqual([]);
  });

  it.each([
    ['a user credential', human],
    [
      'a user credential chained through an impersonated service account',
      () =>
        new Impersonated({
          sourceClient: human(),
          targetPrincipal: 'chain@example-brain-dev.iam.gserviceaccount.com',
          targetScopes: ['https://www.googleapis.com/auth/cloud-platform'],
        }),
    ],
    [
      'a workforce user credential',
      () =>
        new ExternalAccountAuthorizedUserClient({
          type: 'external_account_authorized_user',
          audience:
            '//iam.googleapis.com/locations/global/workforcePools/synthetic/providers/synthetic',
          client_id: 'synthetic-client',
          client_secret: 'synthetic-secret',
          refresh_token: 'synthetic-refresh',
          token_url: 'https://sts.googleapis.com/v1/oauthtoken',
          token_info_url: 'https://sts.googleapis.com/v1/introspect',
        }),
    ],
  ])('never impersonates from %s', async (_, source) => {
    await expect(
      createDriveWorkloadAuth(config(), {
        sourceClient: () => Promise.resolve(source()),
      }),
    ).rejects.toThrow('source_credential_refused');
  });

  it('accepts a service-account key only outside production', async () => {
    await expect(
      createDriveWorkloadAuth(config(), {
        sourceClient: () => Promise.resolve(keyFile()),
      }),
    ).resolves.toBeInstanceOf(Impersonated);
    await expect(
      createDriveWorkloadAuth(config(serviceAccount, 'production'), {
        sourceClient: () => Promise.resolve(keyFile()),
      }),
    ).rejects.toThrow('source_credential_refused');
    await expect(
      createDriveWorkloadAuth(config(serviceAccount, 'production'), {
        sourceClient: () => Promise.resolve(new Compute()),
      }),
    ).resolves.toBeInstanceOf(Impersonated);
  });

  it.each([
    'drive-development',
    'someone@example.com',
    'brain-drive-dev@example-brain-dev.iam.gserviceaccount.com.evil.test',
  ])(
    'refuses a Drive machine identity %s that is not a service account',
    async (id) => {
      await expect(
        createDriveWorkloadAuth(config(id), {
          sourceClient: () => Promise.resolve(runtimeIdentity),
        }),
      ).rejects.toThrow('invalid_provider_configuration');
    },
  );
});
