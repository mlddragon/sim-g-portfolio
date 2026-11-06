import { z } from 'zod';

import type {
  ListApprovalsResponse,
  ResolveApprovalRequest,
  ResolveApprovalResponse,
} from '../../domain/approvals.js';
import { approvalRequestId } from '../../domain/identifiers.js';
import { opaqueIdentifier } from './identifiers.js';

const listApprovalsBody = z.strictObject({});

/** No filters or identity fields: the caller's own role decides visibility. */
export function parseListApprovalsBody(body: unknown): boolean {
  return body === undefined || listApprovalsBody.safeParse(body).success;
}

const resolveApprovalBody = z.strictObject({
  approvalRequestId: opaqueIdentifier,
  resolution: z.enum(['approve', 'decline', 'cancel']),
  // Mirrors the service: non-empty, untrimmed-free and at most 1,000 chars.
  reason: z
    .string()
    .min(1)
    .max(1_000)
    .refine((reason) => reason.trim() === reason)
    .refine((reason) => !reason.includes('\u0000') && reason.isWellFormed())
    .optional(),
});

/** Strict: the resolver is always the authenticated caller. */
export function parseResolveApprovalBody(
  body: unknown,
): ResolveApprovalRequest | undefined {
  const parsed = resolveApprovalBody.safeParse(body);
  if (!parsed.success) return undefined;
  const { reason } = parsed.data;
  return {
    approvalRequestId: approvalRequestId(parsed.data.approvalRequestId),
    resolution: parsed.data.resolution,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function listApprovalsResponseBody(
  response: ListApprovalsResponse,
): Record<string, unknown> {
  return {
    approvals: response.approvals.map((approval) => ({
      approvalRequestId: approval.approvalRequestId,
      operationId: approval.operationId,
      status: approval.status,
      summary: {
        requestedByDisplayName: approval.summary.requestedByDisplayName,
        action: approval.summary.action,
        safeTargetDescription: approval.summary.safeTargetDescription,
      },
      createdAt: approval.createdAt.toISOString(),
    })),
  };
}

export function resolveApprovalResponseBody(
  response: ResolveApprovalResponse,
): Record<string, unknown> {
  return {
    approvalRequestId: response.approvalRequestId,
    operationId: response.operationId,
    approvalStatus: response.approvalStatus,
    operationState: response.operationState,
  };
}
