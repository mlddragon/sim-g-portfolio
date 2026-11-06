import { describe, expect, it } from 'vitest';

import { CloudLoggingAuditSink } from '../../../src/adapters/audit/cloud-logging-audit-sink.js';
import {
  operationId,
  principalId,
  requestId,
} from '../../../src/domain/identifiers.js';
import type { AuditEvent } from '../../../src/ports/audit-sink.js';

const timestamp = new Date('2042-06-07T08:09:10.000Z');

function event(): AuditEvent {
  return {
    eventType: 'brain.operation.completed',
    requestId: requestId('req_synthetic_audit'),
    principalId: principalId('prn_synthetic_operator'),
    clientId: 'synthetic-client',
    operationId: operationId('op_synthetic_audit'),
    operation: 'search_brain',
    provider: 'notion',
    policyVersion: 'family-brain-v1.2.0',
    outcome: 'COMPLETED',
    timestamp,
  };
}

describe('CloudLoggingAuditSink', () => {
  it('writes one exact metadata-only structured JSON line', async () => {
    const lines: string[] = [];
    const sink = new CloudLoggingAuditSink({
      write: (line) => {
        lines.push(line);
      },
    });
    const unsafeRuntimeEvent = {
      ...event(),
      content: 'SYNTHETIC_PRIVATE_BODY_SENTINEL',
      authorization: 'Bearer SYNTHETIC_TOKEN_SENTINEL',
      providerPayload: { blocks: ['SYNTHETIC_PROVIDER_PAYLOAD'] },
      error: new Error('SQL SYNTHETIC_DATABASE_DETAIL'),
    } as AuditEvent;

    await sink.emit(unsafeRuntimeEvent, new AbortController().signal);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      severity: 'NOTICE',
      logType: 'family_brain_audit',
      eventType: 'brain.operation.completed',
      requestId: 'req_synthetic_audit',
      principalId: 'prn_synthetic_operator',
      clientId: 'synthetic-client',
      operationId: 'op_synthetic_audit',
      operation: 'search_brain',
      provider: 'notion',
      policyVersion: 'family-brain-v1.2.0',
      outcome: 'COMPLETED',
      timestamp: timestamp.toISOString(),
    });
    expect(lines[0]).not.toMatch(
      /SYNTHETIC_PRIVATE_BODY|SYNTHETIC_TOKEN|SYNTHETIC_PROVIDER_PAYLOAD|SYNTHETIC_DATABASE_DETAIL/u,
    );
  });

  it('returns a stable safe error when the destination fails', async () => {
    const sink = new CloudLoggingAuditSink({
      write: () => {
        throw new Error('Bearer SYNTHETIC_SINK_SECRET');
      },
    });

    const error = await sink
      .emit(event(), new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'audit_sink_write_failed' },
    });
    expect(JSON.stringify(error)).not.toContain('SYNTHETIC_SINK_SECRET');
  });
});
