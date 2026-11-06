import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  parseEnvironment,
  type EnvironmentConfig,
  type EnvironmentName,
} from '../../../src/config/environment.js';
import { DomainError } from '../../../src/domain/errors.js';

function scoped(environment: EnvironmentName, reference: string) {
  return { environment, reference } as const;
}

function secretHandle(environment: EnvironmentName, name: string) {
  return { environment, name } as const;
}

function providerCredential(
  environment: EnvironmentName,
  kind: 'secret' | 'workload_identity',
  name: string,
) {
  return { environment, kind, name } as const;
}

function machineIdentity(environment: EnvironmentName, id: string) {
  return { environment, id } as const;
}

function notionRoot(
  environment: EnvironmentName,
  container: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    environment,
    container,
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
    ...overrides,
  } as Record<string, unknown>;
}

function driveRoot(
  environment: EnvironmentName,
  container: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    environment,
    container,
    folderId: 'folder-family-shared',
    sharedDriveId: 'shared-drive-synthetic',
    displayPath: 'Family Shared',
    ...overrides,
  } as Record<string, unknown>;
}

function familyInbox(environment: EnvironmentName) {
  return {
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
  } as Record<string, unknown>;
}

function secretsFor(environment: EnvironmentName) {
  return environment === 'production'
    ? {
        provider: 'google_secret_manager' as const,
        projectNumber: '123456789012',
        bindings: {
          [`database_${environment}`]: 'gateway-database-url',
          [`notion_${environment}`]: 'gateway-notion-token',
          [`github_${environment}`]: 'gateway-github-app-key',
        } as Record<string, string>,
      }
    : {
        provider: 'environment' as const,
        bindings: {
          [`database_${environment}`]: 'DATABASE_URL',
          [`notion_${environment}`]: 'NOTION_TOKEN',
          [`github_${environment}`]: 'GITHUB_APP_PRIVATE_KEY',
        } as Record<string, string>,
      };
}

function validConfig(environment: EnvironmentName = 'development') {
  return {
    environment,
    server: { port: 8080, logLevel: 'info' },
    secrets: secretsFor(environment) as
      ReturnType<typeof secretsFor> | Record<string, unknown>,
    database: {
      connectionSecret: secretHandle(environment, `database_${environment}`),
    },
    identity: {
      issuer: 'https://accounts.google.com',
      audience: `gateway-${environment}.example.invalid`,
      hostedDomain: 'example.invalid',
    },
    policy: {
      executablePolicy: scoped(
        environment,
        `config://${environment}/gateway-policy`,
      ),
      governanceSource: scoped(
        environment,
        `governance://${environment}/canonical-policy`,
      ),
      projectRegistry: scoped(
        environment,
        `registry://${environment}/projects`,
      ),
    },
    providers: {
      notion: {
        machineIdentity: machineIdentity(
          environment,
          `synthetic-notion-integration-${environment}`,
        ),
        credential: providerCredential(
          environment,
          'secret',
          `notion_${environment}`,
        ),
        roots: [notionRoot(environment, 'family_shared')],
        familyInbox: familyInbox(environment),
      },
      drive: {
        machineIdentity: machineIdentity(
          environment,
          `synthetic-drive-service-account-${environment}@example.invalid`,
        ),
        credential: providerCredential(
          environment,
          'workload_identity',
          `drive_${environment}`,
        ),
        roots: [driveRoot(environment, 'family_shared')],
      },
      github: {
        machineIdentity: machineIdentity(
          environment,
          `synthetic-github-app-${environment}`,
        ),
        credential: providerCredential(
          environment,
          'secret',
          `github_${environment}`,
        ),
        projectRegistry: scoped(
          environment,
          `registry://${environment}/github-projects`,
        ),
      },
    },
  };
}

type TestEnvironmentConfig = ReturnType<typeof validConfig>;

const environmentBoundaryCases: readonly [
  path: string,
  mutate: (input: TestEnvironmentConfig) => void,
][] = [
  [
    'database.connectionSecret',
    (input) => {
      input.database.connectionSecret = {
        ...input.database.connectionSecret,
        environment: 'production',
      };
    },
  ],
  [
    'policy.executablePolicy',
    (input) => {
      input.policy.executablePolicy = {
        ...input.policy.executablePolicy,
        environment: 'production',
      };
    },
  ],
  [
    'policy.governanceSource',
    (input) => {
      input.policy.governanceSource = {
        ...input.policy.governanceSource,
        environment: 'production',
      };
    },
  ],
  [
    'policy.projectRegistry',
    (input) => {
      input.policy.projectRegistry = {
        ...input.policy.projectRegistry,
        environment: 'production',
      };
    },
  ],
  [
    'providers.notion.machineIdentity',
    (input) => {
      input.providers.notion.machineIdentity = {
        ...input.providers.notion.machineIdentity,
        environment: 'production',
      };
    },
  ],
  [
    'providers.notion.credential',
    (input) => {
      input.providers.notion.credential = {
        ...input.providers.notion.credential,
        environment: 'production',
      };
    },
  ],
  [
    'providers.notion.roots[0]',
    (input) => {
      input.providers.notion.roots = [
        notionRoot('production', 'family_shared'),
      ];
    },
  ],
  [
    'providers.notion.familyInbox',
    (input) => {
      input.providers.notion.familyInbox = familyInbox('production');
    },
  ],
  [
    'providers.drive.machineIdentity',
    (input) => {
      input.providers.drive.machineIdentity = {
        ...input.providers.drive.machineIdentity,
        environment: 'production',
      };
    },
  ],
  [
    'providers.drive.credential',
    (input) => {
      input.providers.drive.credential = {
        ...input.providers.drive.credential,
        environment: 'production',
      };
    },
  ],
  [
    'providers.drive.roots[0]',
    (input) => {
      input.providers.drive.roots = [driveRoot('production', 'family_shared')];
    },
  ],
  [
    'providers.github.machineIdentity',
    (input) => {
      input.providers.github.machineIdentity = {
        ...input.providers.github.machineIdentity,
        environment: 'production',
      };
    },
  ],
  [
    'providers.github.credential',
    (input) => {
      input.providers.github.credential = {
        ...input.providers.github.credential,
        environment: 'production',
      };
    },
  ],
  [
    'providers.github.projectRegistry',
    (input) => {
      input.providers.github.projectRegistry = {
        ...input.providers.github.projectRegistry,
        environment: 'production',
      };
    },
  ],
];

describe('parseEnvironment', () => {
  it.each<EnvironmentName>(['development', 'test', 'production'])(
    'returns a validated %s configuration discriminant',
    (environment) => {
      const parsed = parseEnvironment(validConfig(environment));

      expect(parsed.environment).toBe(environment);
      expect(parsed.providers.notion.machineIdentity.id).toBe(
        `synthetic-notion-integration-${environment}`,
      );
      expect(parsed.providers.drive.credential).toEqual({
        environment,
        kind: 'workload_identity',
        name: `drive_${environment}`,
      });
      expectTypeOf(parsed).toExtend<EnvironmentConfig>();
    },
  );

  it.each([
    ['production', { provider: 'environment', bindings: {} }],
    [
      'test',
      {
        provider: 'google_secret_manager',
        projectNumber: '123456789012',
        bindings: {},
      },
    ],
  ] as const)(
    'refuses a secret provider not allowed in %s',
    (environment, secrets) => {
      const input = validConfig(environment);
      // Binding values valid for the attempted provider, so only the
      // environment boundary can reject it.
      const names = Object.keys(secretsFor(environment).bindings);
      input.secrets = {
        ...secrets,
        bindings: Object.fromEntries(
          names.map((name) => [
            name,
            secrets.provider === 'environment'
              ? name.toUpperCase()
              : name.replaceAll('_', '-'),
          ]),
        ),
      };

      expect(() => parseEnvironment(input)).toThrow(
        expect.objectContaining({
          code: 'environment_boundary_violation',
          details: { paths: ['secrets.provider'] },
        }),
      );
    },
  );

  it('requires a binding for every secret credential handle and no others', () => {
    const missing = validConfig();
    const { database_development: _database, ...rest } =
      secretsFor('development').bindings;
    missing.secrets = { provider: 'environment', bindings: rest };
    expect(() => parseEnvironment(missing)).toThrow(
      'invalid_environment_configuration',
    );

    const extra = validConfig();
    extra.secrets = {
      provider: 'environment',
      bindings: {
        ...secretsFor('development').bindings,
        drive_development: 'DRIVE_KEY',
      },
    };
    expect(() => parseEnvironment(extra)).toThrow(
      'invalid_environment_configuration',
    );
  });

  it('needs no binding for a workload identity credential', () => {
    const parsed = parseEnvironment(validConfig());

    expect(Object.keys(parsed.secrets.bindings).sort()).toEqual([
      'database_development',
      'github_development',
      'notion_development',
    ]);
  });

  it.each([
    [
      {
        provider: 'environment',
        bindings: { database_development: 'database_url' },
      },
    ],
    [
      {
        provider: 'google_secret_manager',
        projectNumber: 'example-prod',
        bindings: {},
      },
    ],
    [{ provider: 'vault', bindings: {} }],
    [{ provider: 'environment', bindings: { 'Bad Name': 'DATABASE_URL' } }],
  ])('rejects malformed secret configuration %o', (secrets) => {
    const input = validConfig();
    input.secrets = secrets;

    expect(() => parseEnvironment(input)).toThrow(
      'invalid_environment_configuration',
    );
  });

  it('rejects a path-shaped Secret Manager secret ID', () => {
    const input = validConfig('production');
    input.secrets = {
      ...secretsFor('production'),
      bindings: {
        ...secretsFor('production').bindings,
        database_production: '../other-project/secret',
      },
    };

    expect(() => parseEnvironment(input)).toThrow(
      'invalid_environment_configuration',
    );
  });

  it.each(environmentBoundaryCases)(
    'rejects a wrong-environment value at %s with only its safe path',
    (path, mutate) => {
      const input = validConfig();
      mutate(input);

      try {
        parseEnvironment(input);
        expect.unreachable('expected environment boundary violation');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).toResponse()).toEqual({
          error: {
            code: 'environment_boundary_violation',
            retryable: false,
            details: { paths: [path] },
          },
        });
      }
    },
  );

  it('does not expose a wrong-environment provider root value', () => {
    const input = validConfig();
    input.providers.drive.roots = [
      driveRoot('production', 'family_shared', {
        folderId: 'private-family-root',
      }),
    ];

    expect(() => parseEnvironment(input)).toThrow(
      'environment_boundary_violation',
    );

    try {
      parseEnvironment(input);
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).toResponse()).toEqual({
        error: {
          code: 'environment_boundary_violation',
          retryable: false,
          details: { paths: ['providers.drive.roots[0]'] },
        },
      });
      expect(JSON.stringify((error as DomainError).toResponse())).not.toContain(
        'private-family-root',
      );
    }
  });

  it('rejects wrong-environment provider credentials and machine identities without exposing their values', () => {
    const input = validConfig('test');
    input.database.connectionSecret = secretHandle(
      'production',
      'private_database_handle',
    );
    input.providers.notion.credential = providerCredential(
      'production',
      'secret',
      'private_notion_handle',
    );
    input.providers.github.machineIdentity = machineIdentity(
      'development',
      'SYNTHETIC_PRIVATE_GITHUB_ID',
    );

    try {
      parseEnvironment(input);
      expect.unreachable('expected environment boundary violation');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).toResponse()).toEqual({
        error: {
          code: 'environment_boundary_violation',
          retryable: false,
          details: {
            paths: [
              'database.connectionSecret',
              'providers.notion.credential',
              'providers.github.machineIdentity',
            ],
          },
        },
      });
      expect(JSON.stringify((error as DomainError).toResponse())).not.toMatch(
        /private_database_handle|private_notion_handle|SYNTHETIC_PRIVATE_GITHUB_ID/u,
      );
    }
  });

  it('rejects inline provider secrets and unknown configuration keys', () => {
    const input = {
      ...validConfig(),
      providers: {
        ...validConfig().providers,
        notion: {
          ...validConfig().providers.notion,
          token: 'must-not-be-accepted',
        },
      },
    };

    expect(() => parseEnvironment(input)).toThrow(
      'invalid_environment_configuration',
    );
  });

  it('rejects a token-shaped value where a provider credential handle is required', () => {
    const input = validConfig();
    const privateValue = 'SYNTHETIC_NOT_A_REFERENCE_TOKEN';
    input.providers.notion.credential = providerCredential(
      'development',
      'secret',
      privateValue,
    );

    try {
      parseEnvironment(input);
      expect.unreachable('expected invalid environment configuration');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        'invalid_environment_configuration',
      );
      expect(String(error)).not.toContain(privateValue);
      expect(JSON.stringify(error)).not.toContain(privateValue);
    }
  });

  it.each([
    'secret://?',
    'secret://%ZZ',
    'secret://user:password@example.invalid',
    'secret://ghp_SYNTHETICINLINESECRET',
  ])('rejects malformed or credential-bearing provider handle %s', (name) => {
    const input = validConfig();
    input.providers.notion.credential = providerCredential(
      'development',
      'secret',
      name,
    );

    expect(() => parseEnvironment(input)).toThrow(
      'invalid_environment_configuration',
    );
  });

  it('rejects reuse of one credential handle across providers', () => {
    const input = validConfig();
    input.providers.github.credential = {
      ...input.providers.notion.credential,
    };

    expect(() => parseEnvironment(input)).toThrow(
      'invalid_environment_configuration',
    );
  });

  it('rejects reuse of a provider credential name for the database', () => {
    const input = validConfig();
    input.providers.drive.credential = providerCredential(
      'development',
      'workload_identity',
      input.database.connectionSecret.name,
    );

    expect(() => parseEnvironment(input)).toThrow(
      'invalid_environment_configuration',
    );
  });

  it('rejects reuse of one machine identity ID across providers', () => {
    const input = validConfig();
    input.providers.drive.machineIdentity = {
      ...input.providers.drive.machineIdentity,
      id: input.providers.notion.machineIdentity.id,
    };

    expect(() => parseEnvironment(input)).toThrow(
      'invalid_environment_configuration',
    );
  });

  it('accepts structured roots naming policy containers, never scopes', () => {
    const input = validConfig();
    input.providers.notion.roots = [
      notionRoot('development', 'family_shared'),
      notionRoot('development', 'protected', {
        object: { kind: 'page', id: '30000000-0000-4000-8000-000000000002' },
        displayPath: 'Family Shared / Legal',
        legalHold: true,
        mutationPropertyIds: undefined,
      }),
    ];
    input.providers.drive.roots = [
      driveRoot('development', 'family_shared'),
      driveRoot('development', 'parent_and_stewardship', {
        folderId: 'folder-parents',
      }),
    ];

    const parsed = parseEnvironment(JSON.parse(JSON.stringify(input)));

    expect(parsed.providers.notion.roots.map((root) => root.container)).toEqual(
      ['family_shared', 'protected'],
    );
    expect(parsed.providers.notion.roots[1]?.legalHold).toBe(true);
  });

  it.each([
    [
      'the unregistered restricted container',
      (input: TestEnvironmentConfig) => {
        input.providers.notion.roots = [
          notionRoot('development', 'restricted'),
        ];
      },
    ],
    [
      'a scope chosen by configuration',
      (input: TestEnvironmentConfig) => {
        input.providers.drive.roots = [
          driveRoot('development', 'family_shared', { scope: 'legal' }),
        ];
      },
    ],
    [
      'legal hold outside the protected container',
      (input: TestEnvironmentConfig) => {
        input.providers.drive.roots = [
          driveRoot('development', 'family_shared', { legalHold: true }),
        ];
      },
    ],
    [
      'two roots for one container',
      (input: TestEnvironmentConfig) => {
        input.providers.drive.roots = [
          driveRoot('development', 'family_shared'),
          driveRoot('development', 'family_shared', { folderId: 'other' }),
        ];
      },
    ],
    [
      'two roots for one Notion object',
      (input: TestEnvironmentConfig) => {
        input.providers.notion.roots = [
          notionRoot('development', 'family_shared'),
          notionRoot('development', 'parent_and_stewardship'),
        ];
      },
    ],
    [
      'mutation properties on a page root',
      (input: TestEnvironmentConfig) => {
        input.providers.notion.roots = [
          notionRoot('development', 'family_shared', {
            object: {
              kind: 'page',
              id: '30000000-0000-4000-8000-000000000003',
            },
          }),
        ];
      },
    ],
    [
      'no Notion mutation target',
      (input: TestEnvironmentConfig) => {
        input.providers.notion.roots = [
          notionRoot('development', 'family_shared', {
            mutationPropertyIds: undefined,
          }),
        ];
      },
    ],
    [
      'a malformed Notion object ID',
      (input: TestEnvironmentConfig) => {
        input.providers.notion.roots = [
          notionRoot('development', 'family_shared', {
            object: { kind: 'data_source', id: '../other' },
          }),
        ];
      },
    ],
    [
      'duplicate Family Inbox property IDs',
      (input: TestEnvironmentConfig) => {
        const inbox = familyInbox('development');
        input.providers.notion.familyInbox = {
          ...inbox,
          propertyIds: {
            ...(inbox['propertyIds'] as Record<string, string>),
            status: 'inbox-title',
          },
        };
      },
    ],
    [
      'a missing Family Inbox status option',
      (input: TestEnvironmentConfig) => {
        const inbox = familyInbox('development');
        const { impossible: _impossible, ...options } = inbox[
          'statusOptionIds'
        ] as Record<string, string>;
        input.providers.notion.familyInbox = {
          ...inbox,
          statusOptionIds: options,
        };
      },
    ],
  ])('rejects %s', (_, mutate) => {
    const input = validConfig();
    mutate(input);

    expect(() => parseEnvironment(JSON.parse(JSON.stringify(input)))).toThrow(
      'invalid_environment_configuration',
    );
  });

  it('rejects missing or malformed provider access configuration', () => {
    const missing = validConfig();
    delete (
      missing.providers.notion as Partial<typeof missing.providers.notion>
    ).credential;

    const blankIdentity = validConfig();
    blankIdentity.providers.drive.machineIdentity = machineIdentity(
      'development',
      '   ',
    );

    const whitespaceReference = validConfig();
    whitespaceReference.providers.github.credential = providerCredential(
      'development',
      'secret',
      ' github_development',
    );

    const trailingReferenceLineBreak = validConfig();
    trailingReferenceLineBreak.providers.notion.credential = providerCredential(
      'development',
      'secret',
      'notion_development\n',
    );

    const trailingIdentityLineBreak = validConfig();
    trailingIdentityLineBreak.providers.drive.machineIdentity = machineIdentity(
      'development',
      'synthetic-drive-service-account-development@example.invalid\n',
    );

    for (const input of [
      missing,
      blankIdentity,
      whitespaceReference,
      trailingReferenceLineBreak,
      trailingIdentityLineBreak,
    ]) {
      expect(() => parseEnvironment(input)).toThrow(
        'invalid_environment_configuration',
      );
    }
  });
});
