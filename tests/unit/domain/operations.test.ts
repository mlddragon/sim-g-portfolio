import { describe, expectTypeOf, it } from 'vitest';

import type {
  BrainOperationName,
  UpdateMutation,
} from '../../../src/domain/operations.js';

describe('operation contracts', () => {
  it('exposes exactly the eight approved public operations', () => {
    expectTypeOf<BrainOperationName>().toEqualTypeOf<
      | 'search_brain'
      | 'fetch_record'
      | 'persist_knowledge'
      | 'update_record'
      | 'append_to_record'
      | 'delete_record'
      | 'list_approvals'
      | 'resolve_approval'
    >();
  });

  it('distinguishes patch from destructive full replacement by shape', () => {
    expectTypeOf<
      Extract<UpdateMutation, { mode: 'patch' }>
    >().toMatchObjectType<{
      readonly patch: Readonly<Record<string, unknown>>;
    }>();
    expectTypeOf<
      Extract<UpdateMutation, { mode: 'replace' }>
    >().toMatchObjectType<{
      readonly replacement: {
        readonly title?: string;
        readonly content: string;
      };
    }>();
  });
});
