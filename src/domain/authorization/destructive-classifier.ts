import { z } from 'zod';

import type { BrainOperationName, UpdateMutation } from '../operations.js';
import type { ProtectedClass } from '../records.js';

export type DestructiveClassificationKind =
  | 'NON_DESTRUCTIVE'
  | 'ROUTINE_DESTRUCTIVE'
  | 'HIGH_BLAST_RADIUS'
  | 'PROTECTED_DESTRUCTIVE'
  | 'FORBIDDEN_DESTRUCTIVE';

export interface DestructiveClassification {
  readonly kind: DestructiveClassificationKind;
  readonly reasonCode: string;
}

export interface DestructiveClassificationInput {
  readonly operation: BrainOperationName;
  readonly updateMutation?: UpdateMutation;
  readonly targetCount: number;
  readonly selection: 'explicit' | 'broad' | 'inferred';
  readonly explicitIntent: boolean;
  readonly protectedClass: ProtectedClass;
}

function result(
  kind: DestructiveClassificationKind,
  reasonCode: string,
): DestructiveClassification {
  return { kind, reasonCode };
}

// Ordinary record edits have a closed semantic shape. Provider fields and
// authorization metadata must never pass through a patch as routine writes.
const updateMutationSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('patch'),
    patch: z
      .strictObject({
        title: z.string().min(1).optional(),
        content: z.string().optional(),
      })
      .refine(
        (patch) => patch.title !== undefined || patch.content !== undefined,
      ),
  }),
  z.strictObject({
    mode: z.literal('replace'),
    replacement: z.strictObject({
      title: z.string().min(1).optional(),
      content: z.string(),
    }),
  }),
]);

export class DestructiveClassifier {
  classify(input: DestructiveClassificationInput): DestructiveClassification {
    if (
      input.operation === 'update_record' &&
      input.updateMutation === undefined
    ) {
      return result('FORBIDDEN_DESTRUCTIVE', 'update_mutation_required');
    }

    let replacementContent: string | undefined;
    if (input.operation === 'update_record') {
      const parsed = updateMutationSchema.safeParse(input.updateMutation);
      if (!parsed.success) {
        return result('FORBIDDEN_DESTRUCTIVE', 'invalid_update_mutation');
      }
      replacementContent =
        parsed.data.mode === 'replace'
          ? parsed.data.replacement.content
          : parsed.data.patch.content;
    }
    // Supplying the entire content field replaces the body even when a client
    // labels it a patch. Apply the same creator/protection rules to both modes.
    const replacement = replacementContent !== undefined;
    const deletion = input.operation === 'delete_record';
    if (!replacement && !deletion) {
      return result(
        'NON_DESTRUCTIVE',
        input.operation === 'update_record'
          ? 'ordinary_update'
          : 'non_destructive_operation',
      );
    }

    if (input.protectedClass === 'legal_hold') {
      return result(
        'FORBIDDEN_DESTRUCTIVE',
        'legal_hold_destructive_forbidden',
      );
    }
    if (input.protectedClass !== 'none') {
      return result(
        'PROTECTED_DESTRUCTIVE',
        `${input.protectedClass}_record_destructive`,
      );
    }

    if (replacementContent?.length === 0) {
      return result('HIGH_BLAST_RADIUS', 'empty_body_replacement');
    }
    if (input.targetCount !== 1) {
      return result('HIGH_BLAST_RADIUS', 'multiple_or_missing_targets');
    }
    if (input.selection === 'broad') {
      return result('HIGH_BLAST_RADIUS', 'broad_selector');
    }
    if (input.selection === 'inferred') {
      return result('HIGH_BLAST_RADIUS', 'inferred_destructive_intent');
    }
    if (!input.explicitIntent) {
      return result('HIGH_BLAST_RADIUS', 'explicit_intent_required');
    }

    return result(
      'ROUTINE_DESTRUCTIVE',
      deletion ? 'explicit_single_delete' : 'explicit_single_replacement',
    );
  }
}
