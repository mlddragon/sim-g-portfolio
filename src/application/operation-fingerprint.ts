import { createHash } from 'node:crypto';

import {
  brainOperationNames,
  type BrainOperationName,
} from '../domain/operations.js';
import type { OperationalJsonValue } from '../ports/operational-state-store.js';

const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);

function invalidPayload(): TypeError {
  return new TypeError('invalid_operation_fingerprint_payload');
}

function normalize(
  value: unknown,
  ancestors: WeakSet<object>,
): OperationalJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw invalidPayload();
    ancestors.add(value);
    try {
      return value.map((item) => normalize(item, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }

  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw invalidPayload();
    }
    if (ancestors.has(value)) throw invalidPayload();
    ancestors.add(value);
    try {
      const normalized: Record<string, OperationalJsonValue> = {};
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key !== 'string'))
        throw invalidPayload();
      for (const key of (ownKeys as string[]).sort()) {
        if (unsafeKeys.has(key)) throw invalidPayload();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !Object.hasOwn(descriptor, 'value') ||
          descriptor.enumerable !== true
        ) {
          throw invalidPayload();
        }
        normalized[key] = normalize(descriptor.value, ancestors);
      }
      return normalized;
    } finally {
      ancestors.delete(value);
    }
  }

  throw invalidPayload();
}

/** Hashes a deterministic, coercion-free snapshot of one semantic operation. */
export function operationFingerprint(
  operation: BrainOperationName,
  payload: unknown,
): string {
  if (!brainOperationNames.includes(operation)) throw invalidPayload();
  const canonical = normalize({ operation, payload }, new WeakSet<object>());
  return createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
}
