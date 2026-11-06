import { z } from 'zod';

import type {
  SearchBrainRequest,
  SearchBrainResponse,
} from '../../domain/operations.js';
import { summaryBody } from './records.js';

/** The transport ceiling; the search service enforces its own as well. */
export const maximumSearchLimit = 50;
const maximumQueryLength = 2_048;

const searchBrainBody = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(maximumQueryLength)
    .refine((query) => query.trim().length > 0),
  limit: z.number().int().min(1).max(maximumSearchLimit),
});

/** Strict: unknown fields such as a client-declared principal are rejected. */
export function parseSearchBrainBody(
  body: unknown,
): SearchBrainRequest | undefined {
  const parsed = searchBrainBody.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** Explicit field-by-field projection so nothing unlisted reaches the wire. */
export function searchBrainResponseBody(
  response: SearchBrainResponse,
): Record<string, unknown> {
  return {
    requestId: response.requestId,
    results: response.results.map(summaryBody),
    completeness: {
      complete: response.completeness.complete,
      providers: response.completeness.providers.map((provider) => ({
        provider: provider.provider,
        state: provider.state,
        ...(provider.errorCode === undefined
          ? {}
          : { errorCode: provider.errorCode }),
      })),
    },
  };
}
