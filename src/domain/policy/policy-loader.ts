import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { DomainError } from '../errors.js';
import { brainOperationNames } from '../operations.js';
import { principalRoles } from '../principal.js';
import { brainScopes } from '../records.js';
import type { BrainScope } from '../records.js';

const exactOwnerScopes = [
  'family_shared',
  'parent_and_stewardship',
  'governance',
  'security',
  'legal',
] as const;
const exactParentScopes = [
  'family_shared',
  'parent_and_stewardship',
  'legal',
] as const;
const exactParticipantScopes = ['family_shared'] as const;
const exactParentOperations = brainOperationNames;
const exactParticipantOperations = [
  'search_brain',
  'fetch_record',
  'persist_knowledge',
  'update_record',
  'append_to_record',
  'delete_record',
] as const;

function exactTuple<T extends readonly [string, ...string[]]>(values: T) {
  return z.tuple(
    values.map((value) => z.literal(value)) as {
      [Index in keyof T]: z.ZodLiteral<T[Index]>;
    },
  );
}

const sensitivityContainersSchema = z.strictObject({
  family_shared: z.string().min(1).max(256),
  parent_and_stewardship: z.string().min(1).max(256),
  restricted: z.string().min(1).max(256),
  protected: z.string().min(1).max(256),
});

const executablePolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^family-brain-v1\.[0-9]+\.[0-9]+$/u),
  correctionWindowMs: z.literal(900_000),
  elevationTtlMs: z.literal(300_000),
  roleScopes: z.strictObject({
    owner_operator: exactTuple(exactOwnerScopes),
    parent_steward: exactTuple(exactParentScopes),
    family_participant: exactTuple(exactParticipantScopes),
  }),
  roleOperations: z.strictObject({
    owner_operator: exactTuple(exactParentOperations),
    parent_steward: exactTuple(exactParentOperations),
    family_participant: exactTuple(exactParticipantOperations),
  }),
  controlPlaneScopes: exactTuple(['governance', 'security']),
  protectedMutationScopes: exactTuple(['legal']),
  legalHoldEvidence: z.literal('immutable'),
  routing: z.strictObject({
    notionRecordTypes: exactTuple([
      'structured_record',
      'knowledge',
      'decision',
      'procedure',
    ]),
    driveRecordTypes: exactTuple([
      'source_document',
      'file_artifact',
      'legal_record',
    ]),
    containers: z.strictObject({
      notion: sensitivityContainersSchema,
      drive: sensitivityContainersSchema,
    }),
  }),
  // Owner decision 2026-10-24, pinned exactly: a changed mapping or a
  // registered generic restricted container does not load.
  containerPolicies: z.strictObject({
    family_shared: z.strictObject({
      scope: z.literal('family_shared'),
      sensitivity: z.literal('family_shared'),
      protectedClass: z.literal('none'),
    }),
    parent_and_stewardship: z.strictObject({
      scope: z.literal('parent_and_stewardship'),
      sensitivity: z.literal('parent_and_stewardship'),
      protectedClass: z.literal('none'),
    }),
    protected: z.strictObject({
      scope: z.literal('legal'),
      sensitivity: z.literal('protected'),
      protectedClass: z.literal('protected'),
    }),
  }),
});

export type ExecutablePolicy = z.infer<typeof executablePolicySchema>;

const repositoryName = z
  .string()
  .min(3)
  .max(201)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const knowledgePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.split('/').some((component) => component === '..'),
  );
const projectRegistrySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    version: z.string().min(1).max(256),
    canonicalMarker: z.string().min(1).max(256),
    repositories: z.array(
      z.strictObject({
        repository: repositoryName,
        projectKey: z.string().min(1).max(256),
        scopes: z.array(z.enum(brainScopes)).min(1),
        knowledgePaths: z.array(knowledgePath).min(1),
      }),
    ),
  })
  .superRefine((registry, context) => {
    const repositories = new Set<string>();
    for (const [index, entry] of registry.repositories.entries()) {
      const normalized = entry.repository.toLowerCase();
      if (repositories.has(normalized)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate_repository',
          path: ['repositories', index, 'repository'],
        });
      }
      repositories.add(normalized);
      if (new Set(entry.scopes).size !== entry.scopes.length) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate_scope',
          path: ['repositories', index, 'scopes'],
        });
      }
      if (new Set(entry.knowledgePaths).size !== entry.knowledgePaths.length) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate_knowledge_path',
          path: ['repositories', index, 'knowledgePaths'],
        });
      }
    }
  });

export type ProjectRegistry = z.infer<typeof projectRegistrySchema>;

function decodeYaml(content: string, reason: string): unknown {
  try {
    return parseYaml(content) as unknown;
  } catch {
    throw new DomainError('invalid_request', false, { reason });
  }
}

export function loadExecutablePolicy(content: string): ExecutablePolicy {
  const parsed = executablePolicySchema.safeParse(
    decodeYaml(content, 'invalid_executable_policy'),
  );
  if (!parsed.success) {
    throw new DomainError('invalid_request', false, {
      reason: 'invalid_executable_policy',
    });
  }
  return parsed.data;
}

export function loadProjectRegistry(content: string): ProjectRegistry {
  const parsed = projectRegistrySchema.safeParse(
    decodeYaml(content, 'invalid_project_registry'),
  );
  if (!parsed.success) {
    throw new DomainError('invalid_request', false, {
      reason: 'invalid_project_registry',
    });
  }
  return parsed.data;
}

export function isRepositoryRegistered(
  registry: ProjectRegistry,
  repository: string,
  scope: BrainScope,
): boolean {
  const normalized = repository.toLowerCase();
  return registry.repositories.some(
    (entry) =>
      entry.repository.toLowerCase() === normalized &&
      entry.scopes.includes(scope),
  );
}

export const policyContract = {
  roles: principalRoles,
  scopes: brainScopes,
  operations: brainOperationNames,
} as const;
