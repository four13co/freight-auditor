import type { InheritAddCriterion } from './apply-inherit-add.js';
import { applyExempt, type ExemptedCriterion } from './apply-exempt.js';
import type { FoldedCriterionOperations } from './fold-rubric-tiers.js';

export interface CriterionProtectionMetadata {
  criterionVersionId: string;
  kind: 'GATING' | 'SCORING';
  hardness: 'HUMAN_INPUT' | 'AI_CANON' | 'AI_DOCS' | 'FIRM_RULE';
}

export class HardStandardGateExemptionError extends Error {
  readonly code = 'EXEMPT_HARD_STANDARD_GATE';
  constructor(readonly criterionKey: string, reason = 'HARD STANDARD gates cannot be exempted') {
    super(reason);
    this.name = 'HardStandardGateExemptionError';
  }
}

export function applyPermittedExempt(
  current: InheritAddCriterion,
  operation: FoldedCriterionOperations['operations'][number],
  metadata: readonly CriterionProtectionMetadata[],
): ExemptedCriterion {
  const byVersion = new Map(metadata.map((item) => [item.criterionVersionId, item]));
  for (const member of current.members) {
    const protection = byVersion.get(member.criterionVersionId);
    if (!protection) {
      throw new HardStandardGateExemptionError(current.criterionKey, 'Criterion protection metadata is unavailable');
    }
    if (member.introducedBy === 'STANDARD' && protection.kind === 'GATING' && protection.hardness === 'FIRM_RULE') {
      throw new HardStandardGateExemptionError(current.criterionKey);
    }
  }
  return applyExempt(current, operation);
}
