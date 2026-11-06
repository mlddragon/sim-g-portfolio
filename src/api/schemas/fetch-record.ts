import { z } from 'zod';

import { brainRecordId } from '../../domain/identifiers.js';
import type {
  FetchRecordRequest,
  FetchRecordResponse,
} from '../../domain/operations.js';
import { opaqueIdentifier } from './identifiers.js';
import { recordBody } from './records.js';

const fetchRecordBody = z.strictObject({ brainRecordId: opaqueIdentifier });

/** Strict: only the stable Brain ID; no provider IDs, hints or identity. */
export function parseFetchRecordBody(
  body: unknown,
): FetchRecordRequest | undefined {
  const parsed = fetchRecordBody.safeParse(body);
  return parsed.success
    ? { brainRecordId: brainRecordId(parsed.data.brainRecordId) }
    : undefined;
}

export function fetchRecordResponseBody(
  response: FetchRecordResponse,
): Record<string, unknown> {
  return { record: recordBody(response.record) };
}
