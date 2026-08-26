import type { FoldedCriterionOperations } from './fold-rubric-tiers.js';
import type { RubricTier } from './select-applicable-rubrics.js';

export const INHERIT_ADD_SEMANTICS_VERSION = 'inherit-add-v1';

export interface ResolvedCriterionMember {
  criterionVersionId: string;
  introducedBy: RubricTier;
  rubricVersionId: string;
  sourceVerb: 'INHERIT' | 'ADD';
}

export interface InheritAddCriterion {
  criterionKey: string;
  members: ResolvedCriterionMember[];
}

export class InheritAddResolutionError extends Error {
  readonly code = 'INHERIT_ADD_INVALID';
  constructor(readonly criterionKey: string, reason: string) {
    super(`Cannot resolve ${criterionKey}: ${reason}`);
    this.name = 'InheritAddResolutionError';
  }
}

/** Apply only INHERIT/ADD operations; later tasks own all other verbs. */
export function applyInheritAdd(
  folded: readonly FoldedCriterionOperations[],
): readonly InheritAddCriterion[] {
  return folded.map((criterion) => {
    const members: ResolvedCriterionMember[] = [];
    const pinned = new Set<string>();
    for (const operation of criterion.operations) {
      if (operation.overrideVerb !== 'INHERIT' && operation.overrideVerb !== 'ADD') {
        throw new InheritAddResolutionError(criterion.criterionKey, `unsupported verb ${operation.overrideVerb}`);
      }
      if (operation.overrideVerb === 'INHERIT' && members.length > 0) continue;
      if (operation.criterionVersionId === null) {
        throw new InheritAddResolutionError(criterion.criterionKey, `${operation.overrideVerb} requires a criterion version pin`);
      }
      if (pinned.has(operation.criterionVersionId)) continue;
      pinned.add(operation.criterionVersionId);
      members.push({
        criterionVersionId: operation.criterionVersionId,
        introducedBy: operation.tier,
        rubricVersionId: operation.rubricVersionId,
        sourceVerb: operation.overrideVerb,
      });
    }
    if (members.length === 0) {
      throw new InheritAddResolutionError(criterion.criterionKey, 'no inherited or added criterion version');
    }
    return { criterionKey: criterion.criterionKey, members };
  });
}
