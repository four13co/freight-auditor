import type { FoldedCriterionOperations } from './fold-rubric-tiers.js';
import type { InheritAddCriterion, ResolvedCriterionMember } from './apply-inherit-add.js';

export const REPLACE_SEMANTICS_VERSION = 'replace-v1';

export class ReplaceResolutionError extends Error {
  readonly code = 'REPLACE_INVALID';
  constructor(readonly criterionKey: string, reason: string) {
    super(`Cannot resolve ${criterionKey}: ${reason}`);
    this.name = 'ReplaceResolutionError';
  }
}

/** Apply INHERIT, ADD, and REPLACE in tier order. */
export function applyReplace(
  folded: readonly FoldedCriterionOperations[],
): readonly InheritAddCriterion[] {
  return folded.map((criterion) => {
    let members: ResolvedCriterionMember[] = [];
    for (const operation of criterion.operations) {
      if (!['INHERIT', 'ADD', 'REPLACE'].includes(operation.overrideVerb)) {
        throw new ReplaceResolutionError(criterion.criterionKey, `unsupported verb ${operation.overrideVerb}`);
      }
      if (operation.overrideVerb === 'INHERIT' && members.length > 0) continue;
      if (operation.criterionVersionId === null) {
        throw new ReplaceResolutionError(criterion.criterionKey, `${operation.overrideVerb} requires a criterion version pin`);
      }
      if (operation.overrideVerb === 'REPLACE') {
        if (members.length === 0) throw new ReplaceResolutionError(criterion.criterionKey, 'REPLACE requires an upstream criterion');
        members = [{
          criterionVersionId: operation.criterionVersionId,
          introducedBy: operation.tier,
          rubricVersionId: operation.rubricVersionId,
          sourceVerb: 'REPLACE',
        }];
        continue;
      }
      if (members.some((member) => member.criterionVersionId === operation.criterionVersionId)) continue;
      members.push({
        criterionVersionId: operation.criterionVersionId,
        introducedBy: operation.tier,
        rubricVersionId: operation.rubricVersionId,
        sourceVerb: operation.overrideVerb === 'INHERIT' ? 'INHERIT' : 'ADD',
      });
    }
    if (members.length === 0) throw new ReplaceResolutionError(criterion.criterionKey, 'no resolved criterion version');
    return { criterionKey: criterion.criterionKey, members };
  });
}
