import type { RequestId } from './identifiers.js';

export interface RequestContext {
  readonly requestId: RequestId;
  readonly receivedAt: Date;
  readonly clientId?: string;
  readonly traceId?: string;
}
