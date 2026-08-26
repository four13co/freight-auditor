import { describe, expect, it } from 'vitest';
import { applyExempt } from '../../src/modules/rubric-resolver/apply-exempt.js';
import type { InheritAddCriterion } from '../../src/modules/rubric-resolver/apply-inherit-add.js';

const rubricVersionId = '11111111-1111-4111-8111-111111111111';
const criterionVersionId = '21111111-1111-4111-8111-111111111111';
const current: InheritAddCriterion = { criterionKey: 'STD.X', members: [{
  criterionVersionId, introducedBy: 'STANDARD', rubricVersionId, sourceVerb: 'INHERIT',
}] };
const operation = {
  criterionKey: 'STD.X', criterionVersionId: null, overrideVerb: 'EXEMPT' as const,
  overridePayload: { reason: 'Contract excludes this service', authority: 'MSA §4.2' },
  evalOrder: 1, tier: 'CONTRACT' as const, rubricVersionId,
};

describe('EXEMPT semantics', () => {
  it('returns explicit exemption evidence while retaining prior pins', () => {
    expect(applyExempt(current, operation)).toEqual({
      criterionKey: 'STD.X', status: 'EXEMPTED', priorMembers: current.members,
      reason: 'Contract excludes this service', authority: 'MSA §4.2',
      exemptedBy: { tier: 'CONTRACT', rubricVersionId },
    });
  });

  it('fails closed without upstream state or defensibility provenance', () => {
    expect(() => applyExempt(undefined, operation)).toThrow('no upstream criterion exists');
    expect(() => applyExempt(current, { ...operation, overridePayload: { reason: '' } }))
      .toThrow('reason and authority are required');
  });

  it('rejects self-exemption in the STANDARD layer', () => {
    expect(() => applyExempt(current, { ...operation, tier: 'STANDARD' })).toThrow('STANDARD cannot exempt');
  });
});
