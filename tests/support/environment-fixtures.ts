/** A synthetic, schema-valid environment configuration document. */
export function syntheticConfigDocument(
  environment: 'development' | 'production' = 'development',
): Record<string, unknown> {
  const scoped = (reference: string) => ({ environment, reference });
  return {
    environment,
    secrets:
      environment === 'production'
        ? {
            provider: 'google_secret_manager',
            projectNumber: '123456789012',
            bindings: {
              database_production: 'gateway-database-url',
              notion_production: 'gateway-notion-token',
              github_production: 'gateway-github-app-key',
            },
          }
        : {
            provider: 'environment',
            bindings: {
              database_development: 'DATABASE_URL',
              notion_development: 'NOTION_TOKEN',
              github_development: 'GITHUB_APP_PRIVATE_KEY',
            },
          },
    server: { port: 8080, logLevel: 'info' },
    database: {
      connectionSecret: { environment, name: `database_${environment}` },
    },
    identity: {
      issuer: 'https://accounts.google.com',
      audience: `gateway-${environment}.example.invalid`,
      hostedDomain: 'example.invalid',
    },
    policy: {
      executablePolicy: scoped(`config://${environment}/policy`),
      governanceSource: scoped(`governance://${environment}/canonical`),
      projectRegistry: scoped(`registry://${environment}/projects`),
    },
    providers: {
      notion: {
        machineIdentity: { environment, id: `notion-${environment}` },
        credential: {
          environment,
          kind: 'secret',
          name: `notion_${environment}`,
        },
        roots: [
          {
            environment,
            container: 'family_shared',
            object: {
              kind: 'data_source',
              id: '30000000-0000-4000-8000-000000000001',
            },
            displayPath: 'Family Shared',
            mutationPropertyIds: {
              title: 'title',
              operationMarker: 'prop-marker',
              contentType: 'prop-type',
              contentHash: 'prop-hash',
            },
          },
          {
            environment,
            container: 'protected',
            object: {
              kind: 'page',
              id: '30000000-0000-4000-8000-000000000002',
            },
            displayPath: 'Family Shared / Legal',
            legalHold: true,
          },
        ],
        familyInbox: {
          environment,
          dataSourceId: '30000000-0000-4000-8000-000000000009',
          propertyIds: {
            title: 'inbox-title',
            approvalRequestId: 'inbox-approval',
            operationId: 'inbox-operation',
            requestId: 'inbox-request',
            requestedBy: 'inbox-requested-by',
            action: 'inbox-action',
            safeTargetDescription: 'inbox-target',
            status: 'inbox-status',
            safeResolutionReason: 'inbox-reason',
          },
          statusOptionIds: {
            pending: 'opt-pending',
            approved: 'opt-approved',
            declined: 'opt-declined',
            cancelled: 'opt-cancelled',
            superseded: 'opt-superseded',
            impossible: 'opt-impossible',
          },
        },
      },
      drive: {
        machineIdentity: { environment, id: `drive-${environment}` },
        credential: {
          environment,
          kind: 'workload_identity',
          name: `drive_${environment}`,
        },
        roots: [
          {
            environment,
            container: 'family_shared',
            folderId: 'folder-family-shared',
            sharedDriveId: 'shared-drive-synthetic',
            displayPath: 'Family Shared',
          },
        ],
      },
      github: {
        machineIdentity: { environment, id: `github-${environment}` },
        credential: {
          environment,
          kind: 'secret',
          name: `github_${environment}`,
        },
        projectRegistry: scoped(`registry://${environment}/github`),
      },
    },
  };
}
