import { z } from 'zod';
import type { InheritAddCriterion } from './apply-inherit-add.js';
import type { FoldedCriterionOperations } from './fold-rubric-tiers.js';

export const EXEMPT_SEMANTICS_VERSION = 'exempt-v1';
const PayloadSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  authority: z.string().trim().min(1).max(255),
}).strict();

export interface ExemptedCriterion {
  criterionKey: string;
  status: 'EXEMPTED';
  priorMembers: InheritAddCriterion['members'];
  reason: string;
  authority: string;
  exemptedBy: {
    tier: 'CLIENT' | 'CONTRACT';
    rubricVersionId: string;
  };
}

export class ExemptResolutionError extends Error {
  readonly code = 'EXEMPT_INVALID';
  constructor(readonly criterionKey: string, reason: string) {
    super(`Cannot exempt ${criterionKey}: ${reason}`);
    this.name = 'ExemptResolutionError';
  }
}

/** Apply one EXEMPT operation to an already-resolved criterion. */
export function applyExempt(
  current: InheritAddCriterion | undefined,
  operation: FoldedCriterionOperations['operations'][number],
): ExemptedCriterion {
  if (operation.overrideVerb !== 'EXEMPT') {
    throw new ExemptResolutionError(operation.criterionKey, `expected EXEMPT, received ${operation.overrideVerb}`);
  }
  if (!current || current.members.length === 0) {
    throw new ExemptResolutionError(operation.criterionKey, 'no upstream criterion exists');
  }
  if (operation.tier === 'STANDARD') {
    throw new ExemptResolutionError(operation.criterionKey, 'STANDARD cannot exempt its own criterion');
  }
  const payload = PayloadSchema.safeParse(operation.overridePayload);
  if (!payload.success) throw new ExemptResolutionError(operation.criterionKey, 'reason and authority are required');
  return {
    criterionKey: operation.criterionKey,
    status: 'EXEMPTED',
    priorMembers: [...current.members],
    reason: payload.data.reason,
    authority: payload.data.authority,
    exemptedBy: { tier: operation.tier, rubricVersionId: operation.rubricVersionId },
  };
}
