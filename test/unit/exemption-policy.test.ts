import { describe, expect, it } from 'vitest';
import { applyPermittedExempt } from '../../src/modules/rubric-resolver/exemption-policy.js';
import type { InheritAddCriterion } from '../../src/modules/rubric-resolver/apply-inherit-add.js';

const criterionVersionId = '11111111-1111-4111-8111-111111111111';
const rubricVersionId = '21111111-1111-4111-8111-111111111111';
const current = (introducedBy: 'STANDARD' | 'CLIENT'): InheritAddCriterion => ({
  criterionKey: 'STD.GATE', members: [{ criterionVersionId, introducedBy, rubricVersionId, sourceVerb: 'INHERIT' }],
});
const operation = {
  criterionKey: 'STD.GATE', criterionVersionId: null, overrideVerb: 'EXEMPT' as const,
  overridePayload: { reason: 'Allowed policy exception', authority: 'Client policy §2' },
  evalOrder: 1, tier: 'CLIENT' as const, rubricVersionId,
};

describe('HARD STANDARD gate exemption policy', () => {
  it('categorically rejects STANDARD gating FIRM_RULE criteria', () => {
    expect(() => applyPermittedExempt(current('STANDARD'), operation, [{
      criterionVersionId, kind: 'GATING', hardness: 'FIRM_RULE',
    }])).toThrowError(expect.objectContaining({ code: 'EXEMPT_HARD_STANDARD_GATE' }));
  });

  it('allows scoring criteria and non-STANDARD gates to reach EXEMPT semantics', () => {
    expect(applyPermittedExempt(current('STANDARD'), operation, [{
      criterionVersionId, kind: 'SCORING', hardness: 'FIRM_RULE',
    }]).status).toBe('EXEMPTED');
    expect(applyPermittedExempt(current('CLIENT'), operation, [{
      criterionVersionId, kind: 'GATING', hardness: 'FIRM_RULE',
    }]).status).toBe('EXEMPTED');
  });

  it('fails closed when protection metadata is incomplete', () => {
    expect(() => applyPermittedExempt(current('STANDARD'), operation, []))
      .toThrow('Criterion protection metadata is unavailable');
  });
});
