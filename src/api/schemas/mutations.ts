import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  brainRecordId,
  elevationChallengeId,
  operationId,
  requestId,
} from '../../domain/identifiers.js';
import type {
  ClientOperationState,
  ElevationConfirmation,
  MutationResponse,
  SemanticMetadata,
  UpdateMutation,
} from '../../domain/operations.js';
import { knowledgeProviderNames } from '../../domain/records.js';
import { opaqueIdentifier } from './identifiers.js';

/** Mirrors the mutation service's content ceiling. */
const maximumContentBytes = 1_048_576;
const maximumTitleLength = 2_000;
const maximumSemanticLength = 512;
const maximumConfirmationTokenLength = 512;

/** No NUL and no lone surrogate, matching what `jsonb` and providers store. */
const storable = (value: string): boolean =>
  !value.includes('\u0000') && value.isWellFormed();
const text = z.string().refine(storable);

const content = text
  .min(1)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= maximumContentBytes);
const title = text.min(1).max(maximumTitleLength);
const semanticString = text.min(1).max(maximumSemanticLength);

/**
 * The client's stable idempotency key (PRD §15). Replays are scoped to the
 * verified principal, so a client can only ever replay its own operations.
 */
const clientKeys = { requestId: opaqueIdentifier };

/**
 * The operation ID is derived, never client-chosen: stable across retries of
 * one principal's request, and never claimable or blockable by another principal.
 */
export function mutationOperationId(
  principal: string,
  operation: string,
  clientRequestId: string,
): ReturnType<typeof operationId> {
  const digest = createHash('sha256')
    .update(JSON.stringify([principal, operation, clientRequestId]))
    .digest('hex');
  return operationId(`op_${digest}`);
}

const elevation = z
  .strictObject({
    challengeId: opaqueIdentifier,
    confirmationToken: z.string().min(1).max(maximumConfirmationTokenLength),
  })
  .optional();

const semanticMetadata = z.strictObject({
  subject: semanticString.optional(),
  domain: semanticString.optional(),
  recordType: semanticString.optional(),
  durability: semanticString.optional(),
  provenance: semanticString.optional(),
  projectReference: semanticString.optional(),
  sensitivity: z
    .enum([
      'family_shared',
      'parent_and_stewardship',
      'restricted',
      'protected',
    ])
    .optional(),
  // Advisory only; the deterministic router remains authoritative.
  canonicalHint: z
    .strictObject({
      provider: z.enum(knowledgeProviderNames).optional(),
      containerRef: semanticString.optional(),
    })
    .refine((hint) => Object.keys(hint).length > 0)
    .optional(),
});

const persistBody = z.strictObject({
  ...clientKeys,
  title,
  content,
  semanticMetadata,
  elevation,
});

const updateMutation = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('patch'),
    patch: z
      .strictObject({
        title: title.optional(),
        content: text
          .refine(
            (value) => Buffer.byteLength(value, 'utf8') <= maximumContentBytes,
          )
          .optional(),
      })
      .refine((patch) => Object.keys(patch).length > 0),
  }),
  z.strictObject({
    mode: z.literal('replace'),
    replacement: z.strictObject({
      title: title.optional(),
      content: text.refine(
        (value) => Buffer.byteLength(value, 'utf8') <= maximumContentBytes,
      ),
    }),
  }),
]);

const updateBody = z.strictObject({
  ...clientKeys,
  brainRecordId: opaqueIdentifier,
  mutation: updateMutation,
  elevation,
});

const appendBody = z.strictObject({
  ...clientKeys,
  brainRecordId: opaqueIdentifier,
  content: content.refine((value) => value.trim().length > 0),
  elevation,
});

const deleteBody = z.strictObject({
  ...clientKeys,
  brainRecordId: opaqueIdentifier,
  // Inferred or broad deletion is never routine; only a literal true counts.
  explicitIntent: z.literal(true),
  elevation,
});

interface ClientKeys {
  readonly requestId: ReturnType<typeof requestId>;
}

function keysOf(body: { requestId: string }): ClientKeys {
  return { requestId: requestId(body.requestId) };
}

function elevationOf(
  value: { challengeId: string; confirmationToken: string } | undefined,
): { elevation?: ElevationConfirmation } {
  return value === undefined
    ? {}
    : {
        elevation: {
          challengeId: elevationChallengeId(value.challengeId),
          confirmationToken: value.confirmationToken,
        },
      };
}

function withoutUndefined<Value extends Record<string, unknown>>(
  value: Value,
): Value {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Value;
}

export function parsePersistBody(body: unknown) {
  const parsed = persistBody.safeParse(body);
  if (!parsed.success) return undefined;
  const { semanticMetadata: metadata } = parsed.data;
  const { canonicalHint, ...rest } = metadata;
  return {
    ...keysOf(parsed.data),
    title: parsed.data.title,
    content: parsed.data.content,
    // Undefined entries are removed, so the result is an exact SemanticMetadata.
    semanticMetadata: {
      ...withoutUndefined(rest),
      ...(canonicalHint === undefined
        ? {}
        : { canonicalHint: withoutUndefined(canonicalHint) }),
    } as SemanticMetadata,
    ...elevationOf(parsed.data.elevation),
  };
}

export function parseUpdateBody(body: unknown) {
  const parsed = updateBody.safeParse(body);
  if (!parsed.success) return undefined;
  const { mutation } = parsed.data;
  const normalized: UpdateMutation =
    mutation.mode === 'patch'
      ? { mode: 'patch', patch: withoutUndefined(mutation.patch) }
      : {
          mode: 'replace',
          replacement: withoutUndefined(mutation.replacement) as {
            title?: string;
            content: string;
          },
        };
  return {
    ...keysOf(parsed.data),
    brainRecordId: brainRecordId(parsed.data.brainRecordId),
    mutation: normalized,
    ...elevationOf(parsed.data.elevation),
  };
}

export function parseAppendBody(body: unknown) {
  const parsed = appendBody.safeParse(body);
  if (!parsed.success) return undefined;
  return {
    ...keysOf(parsed.data),
    brainRecordId: brainRecordId(parsed.data.brainRecordId),
    content: parsed.data.content,
    ...elevationOf(parsed.data.elevation),
  };
}

export function parseDeleteBody(body: unknown) {
  const parsed = deleteBody.safeParse(body);
  if (!parsed.success) return undefined;
  return {
    ...keysOf(parsed.data),
    brainRecordId: brainRecordId(parsed.data.brainRecordId),
    explicitIntent: true as const,
    ...elevationOf(parsed.data.elevation),
  };
}

/**
 * Completed is 200 and a terminal failure (including a policy denial) 422, so
 * a status-only client never mistakes it for success; anything the client must
 * follow up is 202.
 */
const statusByState: Readonly<Record<ClientOperationState, number>> = {
  completed: 200,
  failed: 422,
  approval_required: 202,
  elevation_required: 202,
  outcome_unknown: 202,
};

export function mutationStatus(response: MutationResponse): number {
  return statusByState[response.state];
}

/** Explicit field-by-field projection; request content is never echoed. */
export function mutationResponseBody(
  response: MutationResponse,
): Record<string, unknown> {
  const { record, elevation: grant } = response;
  return {
    operationId: response.operationId,
    state: response.state,
    ...(response.brainRecordId === undefined
      ? {}
      : { brainRecordId: response.brainRecordId }),
    ...(record === undefined
      ? {}
      : {
          record: {
            provider: record.provider,
            providerRecordId: record.providerRecordId,
            ...(record.providerVersion === undefined
              ? {}
              : { providerVersion: record.providerVersion }),
            canonicalLocation: {
              provider: record.canonicalLocation.provider,
              containerRef: record.canonicalLocation.containerRef,
              ...(record.canonicalLocation.displayPath === undefined
                ? {}
                : { displayPath: record.canonicalLocation.displayPath }),
            },
            ...(record.integrityHash === undefined
              ? {}
              : { integrityHash: record.integrityHash }),
          },
        }),
    // The one-time token goes only to the elevating caller, never to logs.
    ...(grant === undefined
      ? {}
      : {
          elevation: {
            challengeId: grant.challengeId,
            confirmationToken: grant.confirmationToken,
            expiresAt: grant.expiresAt.toISOString(),
          },
        }),
  };
}
