import { z } from 'zod';

import { DomainError } from '../domain/errors.js';

export const environmentNames = ['development', 'test', 'production'] as const;
export type EnvironmentName = (typeof environmentNames)[number];

const environmentNameSchema = z.enum(environmentNames);

const resourceReferenceSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[a-z][a-z0-9+.-]*:\/\/[\x21-\x7e]+$/u);

const scopedResourceReferenceSchema = z.strictObject({
  environment: environmentNameSchema,
  reference: resourceReferenceSchema,
});

export type ScopedResourceReference = z.infer<
  typeof scopedResourceReferenceSchema
>;

const logicalHandleNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/u);

const scopedSecretHandleSchema = z.strictObject({
  environment: environmentNameSchema,
  name: logicalHandleNameSchema,
});

export type ScopedSecretHandle = z.infer<typeof scopedSecretHandleSchema>;

const scopedMachineIdentitySchema = z.strictObject({
  environment: environmentNameSchema,
  id: z.string().regex(/^[\x21-\x7e]{1,512}$/u),
});

export type ScopedMachineIdentity = z.infer<typeof scopedMachineIdentitySchema>;

const providerCredentialSchema = z.strictObject({
  environment: environmentNameSchema,
  kind: z.enum(['secret', 'workload_identity']),
  name: logicalHandleNameSchema,
});

export type ProviderCredential = z.infer<typeof providerCredentialSchema>;

/**
 * A governed root names a registered policy container, never a scope: its
 * record policy comes only from the executable policy. `legalHold` can only
 * tighten a `protected` root.
 */
const containerNameSchema = z.enum([
  'family_shared',
  'parent_and_stewardship',
  'protected',
]);
// Accepted dashed or undashed in any case, then canonicalised to Notion's own
// dashed lower-case form so every comparison matches.
const notionObjectIdSchema = z
  .string()
  .regex(
    /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu,
  )
  .transform((id) => {
    const hex = id.replaceAll('-', '').toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });
const configurationIdSchema = z.string().regex(/^[\x21-\x7e]{1,256}$/u);
const driveIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u);
function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const displayPathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => value.trim() === value && !containsControlCharacter(value),
  );

const notionRootSchema = z.strictObject({
  environment: environmentNameSchema,
  container: containerNameSchema,
  object: z.strictObject({
    kind: z.enum(['page', 'data_source']),
    id: notionObjectIdSchema,
  }),
  displayPath: displayPathSchema,
  legalHold: z.literal(true).optional(),
  mutationPropertyIds: z
    .strictObject({
      title: configurationIdSchema,
      operationMarker: configurationIdSchema,
      contentType: configurationIdSchema,
      contentHash: configurationIdSchema,
    })
    .optional(),
});

const familyInboxSchema = z.strictObject({
  environment: environmentNameSchema,
  dataSourceId: notionObjectIdSchema,
  propertyIds: z.strictObject({
    title: configurationIdSchema,
    approvalRequestId: configurationIdSchema,
    operationId: configurationIdSchema,
    requestId: configurationIdSchema,
    requestedBy: configurationIdSchema,
    action: configurationIdSchema,
    safeTargetDescription: configurationIdSchema,
    status: configurationIdSchema,
    safeResolutionReason: configurationIdSchema,
  }),
  statusOptionIds: z.strictObject({
    pending: configurationIdSchema,
    approved: configurationIdSchema,
    declined: configurationIdSchema,
    cancelled: configurationIdSchema,
    superseded: configurationIdSchema,
    impossible: configurationIdSchema,
  }),
});

const driveRootSchema = z.strictObject({
  environment: environmentNameSchema,
  container: containerNameSchema,
  folderId: driveIdSchema,
  sharedDriveId: driveIdSchema.optional(),
  displayPath: displayPathSchema,
  legalHold: z.literal(true).optional(),
});

const maximumGovernedRoots = 32;

/**
 * Where credential handles resolve: process environment variables (local
 * development and tests only) or Google Secret Manager (deployed
 * environments). Bindings map each logical handle to its source.
 */
const secretsSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.literal('environment'),
    bindings: z.record(
      logicalHandleNameSchema,
      z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/u),
    ),
  }),
  z.strictObject({
    provider: z.literal('google_secret_manager'),
    projectNumber: z.string().regex(/^[1-9][0-9]{0,19}$/u),
    bindings: z.record(
      logicalHandleNameSchema,
      z.string().regex(/^[A-Za-z0-9_-]{1,255}$/u),
    ),
  }),
]);

const allowedSecretProviders: Readonly<
  Record<EnvironmentName, ReadonlySet<string>>
> = {
  development: new Set(['environment', 'google_secret_manager']),
  test: new Set(['environment']),
  production: new Set(['google_secret_manager']),
};

const environmentConfigSchema = z.strictObject({
  environment: environmentNameSchema,
  secrets: secretsSchema,
  server: z.strictObject({
    port: z.number().int().min(1).max(65_535),
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  }),
  database: z.strictObject({
    connectionSecret: scopedSecretHandleSchema,
  }),
  identity: z.strictObject({
    issuer: z.url({ protocol: /^https$/u }),
    audience: z.string().min(1).max(512),
    hostedDomain: z.string().min(1).max(253),
  }),
  policy: z.strictObject({
    executablePolicy: scopedResourceReferenceSchema,
    governanceSource: scopedResourceReferenceSchema,
    projectRegistry: scopedResourceReferenceSchema,
  }),
  providers: z.strictObject({
    notion: z.strictObject({
      machineIdentity: scopedMachineIdentitySchema,
      credential: providerCredentialSchema,
      roots: z.array(notionRootSchema).min(1).max(maximumGovernedRoots),
      familyInbox: familyInboxSchema,
    }),
    drive: z.strictObject({
      machineIdentity: scopedMachineIdentitySchema,
      credential: providerCredentialSchema,
      roots: z.array(driveRootSchema).min(1).max(maximumGovernedRoots),
    }),
    github: z.strictObject({
      machineIdentity: scopedMachineIdentitySchema,
      credential: providerCredentialSchema,
      projectRegistry: scopedResourceReferenceSchema,
    }),
  }),
});

export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;

interface LocatedReference {
  readonly path: string;
  readonly resource: { readonly environment: EnvironmentName };
}

function locatedReferences(
  config: EnvironmentConfig,
): readonly LocatedReference[] {
  return [
    {
      path: 'database.connectionSecret',
      resource: config.database.connectionSecret,
    },
    {
      path: 'policy.executablePolicy',
      resource: config.policy.executablePolicy,
    },
    {
      path: 'policy.governanceSource',
      resource: config.policy.governanceSource,
    },
    {
      path: 'policy.projectRegistry',
      resource: config.policy.projectRegistry,
    },
    {
      path: 'providers.notion.machineIdentity',
      resource: config.providers.notion.machineIdentity,
    },
    {
      path: 'providers.notion.credential',
      resource: config.providers.notion.credential,
    },
    ...config.providers.notion.roots.map((resource, index) => ({
      path: `providers.notion.roots[${String(index)}]`,
      resource,
    })),
    {
      path: 'providers.notion.familyInbox',
      resource: config.providers.notion.familyInbox,
    },
    {
      path: 'providers.drive.machineIdentity',
      resource: config.providers.drive.machineIdentity,
    },
    {
      path: 'providers.drive.credential',
      resource: config.providers.drive.credential,
    },
    ...config.providers.drive.roots.map((resource, index) => ({
      path: `providers.drive.roots[${String(index)}]`,
      resource,
    })),
    {
      path: 'providers.github.machineIdentity',
      resource: config.providers.github.machineIdentity,
    },
    {
      path: 'providers.github.credential',
      resource: config.providers.github.credential,
    },
    {
      path: 'providers.github.projectRegistry',
      resource: config.providers.github.projectRegistry,
    },
  ];
}

function containsDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/** Cross-field root rules the schema alone cannot express. */
function validGovernedRoots(config: EnvironmentConfig): boolean {
  const { notion, drive } = config.providers;
  const allRoots = [...notion.roots, ...drive.roots];
  if (
    allRoots.some(
      (root) => root.legalHold === true && root.container !== 'protected',
    )
  ) {
    return false;
  }
  if (
    containsDuplicate(notion.roots.map((root) => root.container)) ||
    containsDuplicate(drive.roots.map((root) => root.container)) ||
    containsDuplicate([
      ...notion.roots.map((root) => root.object.id),
      notion.familyInbox.dataSourceId,
    ]) ||
    containsDuplicate(drive.roots.map((root) => root.folderId))
  ) {
    return false;
  }
  const targets = notion.roots.filter(
    (root) => root.mutationPropertyIds !== undefined,
  );
  if (
    targets.length === 0 ||
    targets.some(
      (root) =>
        root.object.kind !== 'data_source' ||
        containsDuplicate(Object.values(root.mutationPropertyIds ?? {})),
    )
  ) {
    return false;
  }
  return (
    !containsDuplicate(Object.values(notion.familyInbox.propertyIds)) &&
    !containsDuplicate(Object.values(notion.familyInbox.statusOptionIds))
  );
}

export function parseEnvironment(input: unknown): EnvironmentConfig {
  const parsed = environmentConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new TypeError('invalid_environment_configuration');
  }

  const paths = locatedReferences(parsed.data)
    .filter(({ resource }) => resource.environment !== parsed.data.environment)
    .map(({ path }) => path);

  if (paths.length > 0) {
    throw new DomainError('environment_boundary_violation', false, { paths });
  }

  const credentialHandleNames = [
    parsed.data.database.connectionSecret.name,
    parsed.data.providers.notion.credential.name,
    parsed.data.providers.drive.credential.name,
    parsed.data.providers.github.credential.name,
  ];
  const machineIdentityIds = [
    parsed.data.providers.notion.machineIdentity.id,
    parsed.data.providers.drive.machineIdentity.id,
    parsed.data.providers.github.machineIdentity.id,
  ];
  if (
    containsDuplicate(credentialHandleNames) ||
    containsDuplicate(machineIdentityIds)
  ) {
    throw new TypeError('invalid_environment_configuration');
  }

  if (!validGovernedRoots(parsed.data)) {
    throw new TypeError('invalid_environment_configuration');
  }

  const { secrets } = parsed.data;
  if (!allowedSecretProviders[parsed.data.environment].has(secrets.provider)) {
    throw new DomainError('environment_boundary_violation', false, {
      paths: ['secrets.provider'],
    });
  }
  // Exactly the secret-backed handles are bound: no missing binding and no
  // extra secret the service could read.
  const required = [
    parsed.data.database.connectionSecret.name,
    ...[
      parsed.data.providers.notion.credential,
      parsed.data.providers.drive.credential,
      parsed.data.providers.github.credential,
    ]
      .filter((credential) => credential.kind === 'secret')
      .map((credential) => credential.name),
  ].sort();
  const bound = Object.keys(secrets.bindings).sort();
  if (
    required.length !== bound.length ||
    required.some((name, index) => name !== bound[index])
  ) {
    throw new TypeError('invalid_environment_configuration');
  }

  return parsed.data;
}
