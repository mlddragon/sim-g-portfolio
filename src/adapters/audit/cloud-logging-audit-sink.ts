import { serializeAuditEvent } from '../../domain/audit/serialize-audit-event.js';
import type { AuditEvent, AuditSink } from '../../ports/audit-sink.js';
import {
  outputAborted,
  standardOutputDestination,
  type JsonLineDestination,
  writeJsonLine,
} from '../logging/json-line-destination.js';

export class CloudLoggingAuditSink implements AuditSink {
  constructor(
    private readonly destination: JsonLineDestination = standardOutputDestination,
  ) {}

  async emit(event: AuditEvent, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw outputAborted();
    await writeJsonLine(
      this.destination,
      {
        ...serializeAuditEvent(event),
        severity: 'NOTICE',
        logType: 'family_brain_audit',
      },
      'audit_sink_write_failed',
      signal,
    );
  }
}
