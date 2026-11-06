import { z } from 'zod';

import { DomainError, domainErrorCodes } from '../errors.js';
import { brainOperationNames } from '../operations.js';
import { knowledgeProviderNames } from '../records.js';

const identifier = z.string().min(1).max(512);
const auditMetadata = z.object({
  eventType: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9_.]*$/u),
  requestId: identifier,
  principalId: identifier,
  clientId: identifier.optional(),
  operationId: identifier.optional(),
  operation: z.enum(brainOperationNames),
  provider: z.enum(knowledgeProviderNames).optional(),
  brainRecordId: identifier.optional(),
  providerRecordId: identifier.optional(),
  approvalRequestId: identifier.optional(),
  policyVersion: z.string().min(1).max(256).optional(),
  providerVersion: z.string().min(1).max(1024).optional(),
  integrityHash: z.string().min(1).max(256).optional(),
  reasonCode: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-z][a-z0-9_.]*$/u)
    .optional(),
  outcome: z.enum([
    'RECEIVED',
    'AUTHORIZATION_REQUIRED',
    'APPROVAL_PENDING',
    'ELEVATION_PENDING',
    'EXECUTING',
    'COMPLETED',
    'FAILED',
    'OUTCOME_UNKNOWN',
    'CANCELLED',
    'SUPERSEDED',
    'DENIED',
  ]),
  timestamp: z.date(),
});

const operationState = auditMetadata.shape.outcome.exclude(['DENIED']);
const auditedTransition = auditMetadata
  .pick({
    operationId: true,
    provider: true,
    providerRecordId: true,
    providerVersion: true,
    policyVersion: true,
  })
  .extend({
    operationId: identifier,
    expectedStates: z.array(operationState),
    nextState: operationState,
    errorCode: z.enum(domainErrorCodes).optional(),
    transitionedAt: z
      .date()
      .transform((date) => Date.prototype.toISOString.call(date)),
  });

/** Snapshot primitive transition metadata before a storage driver can coerce it. */
export function parseAuditedTransition(request: unknown) {
  try {
    return auditedTransition.parse(request);
  } catch {
    throw new DomainError('invalid_request', false, {
      reason: 'invalid_audit_event',
    });
  }
}

export type SerializedAuditEvent = Omit<
  z.output<typeof auditMetadata>,
  'timestamp'
> & {
  readonly timestamp: string;
};

/** The same metadata-only boundary applies before persistence and before output. */
export function serializeAuditEvent(event: unknown): SerializedAuditEvent {
  try {
    // Strip unknown keys; reject non-primitive known values before JSON can
    // invoke serialization hooks or preserve nested provider payloads.
    const metadata = auditMetadata.parse(event);
    return {
      ...metadata,
      timestamp: Date.prototype.toISOString.call(metadata.timestamp),
    };
  } catch {
    throw new DomainError('invalid_request', false, {
      reason: 'invalid_audit_event',
    });
  }
}
