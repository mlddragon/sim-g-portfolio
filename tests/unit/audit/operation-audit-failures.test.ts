import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PostgresOperationalStateStore } from '../../../src/adapters/state/postgres/postgres-operational-state-store.js';
import { operationId } from '../../../src/domain/identifiers.js';

const transition = {
  operationId: operationId('op_synthetic_lifecycle'),
  expectedStates: ['RECEIVED'] as const,
  nextState: 'EXECUTING' as const,
  transitionedAt: new Date('2042-01-02T03:04:06.000Z'),
};
const operationRow = {
  id: 'op_synthetic_lifecycle',
  request_id: 'req_synthetic_lifecycle',
  principal_id: 'prn_operator',
  client_id: null,
  operation_type: 'update_record',
  state: 'EXECUTING',
  request_fingerprint: 'a'.repeat(64),
  semantic_metadata: null,
  mutation_payload: null,
  target_brain_record_id: null,
  provider: null,
  provider_record_id: null,
  provider_version: null,
  result_metadata: null,
  error_code: null,
  policy_version: null,
  created_at: new Date('2042-01-02T03:04:05.000Z'),
  updated_at: new Date('2042-01-02T03:04:06.000Z'),
};

describe('atomic audit transaction transport failures', () => {
  it.each([
    {
      name: 'lost COMMIT acknowledgement',
      failAt: 'COMMIT',
      rollbackFails: false,
    },
    {
      name: 'failed ROLLBACK after an insert failure',
      failAt: 'INSERT',
      rollbackFails: true,
    },
  ])(
    'sanitizes $name without repeating the transition and safely releases the client',
    async ({ failAt, rollbackFails }) => {
      const commands: string[] = [];
      const release = vi.fn<(destroy?: boolean) => void>();
      // Only the driver transport is faked: real PostgreSQL tests cover commit,
      // rollback and isolation. Here we inject failures at otherwise rare boundaries.
      const client = {
        release,
        query: (query: string | { text: string }) => {
          const text = typeof query === 'string' ? query : query.text;
          const command = text.split(/\s/u)[0] ?? '';
          commands.push(command);
          if (command === failAt || (command === 'ROLLBACK' && rollbackFails)) {
            return Promise.reject(new Error('SYNTHETIC_PRIVATE_DRIVER_ERROR'));
          }
          return Promise.resolve({
            rows: command === 'UPDATE' ? [operationRow] : [],
          });
        },
      };
      const pool = {
        connect: () => Promise.resolve(client),
      } as unknown as Pool;
      const error: unknown = await new PostgresOperationalStateStore(pool)
        .transitionOperationWithAudit(transition, {
          eventType: 'brain.operation.transitioned',
        })
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'provider_unavailable',
        retryable: true,
        details: { reason: 'operation_audit_state_unavailable' },
      });
      expect(JSON.stringify(error)).not.toContain(
        'SYNTHETIC_PRIVATE_DRIVER_ERROR',
      );
      expect(commands).toEqual(
        failAt === 'COMMIT'
          ? ['BEGIN', 'UPDATE', 'INSERT', 'COMMIT', 'ROLLBACK']
          : ['BEGIN', 'UPDATE', 'INSERT', 'ROLLBACK'],
      );
      expect(release).toHaveBeenCalledExactlyOnceWith(rollbackFails);
    },
  );
});
