import { describe, expect, it } from 'vitest';
import { applyReplace } from '../../src/modules/rubric-resolver/apply-replace.js';
import type { FoldedCriterionOperations } from '../../src/modules/rubric-resolver/fold-rubric-tiers.js';

const v1 = '11111111-1111-4111-8111-111111111111';
const v2 = '21111111-1111-4111-8111-111111111111';
const v3 = '31111111-1111-4111-8111-111111111111';
const rubric = '41111111-1111-4111-8111-111111111111';
const operation = (tier: 'STANDARD' | 'CLIENT' | 'CONTRACT', overrideVerb: 'INHERIT' | 'ADD' | 'REPLACE', pin: string | null) => ({
  criterionKey: 'STD.X', criterionVersionId: pin, overrideVerb, evalOrder: 1, tier, rubricVersionId: rubric,
});

describe('REPLACE semantics', () => {
  it('discards all upstream inherited and added members', () => {
    const folded: FoldedCriterionOperations[] = [{ criterionKey: 'STD.X', operations: [
      operation('STANDARD', 'INHERIT', v1), operation('CLIENT', 'ADD', v2), operation('CONTRACT', 'REPLACE', v3),
    ] }];
    expect(applyReplace(folded)[0]!.members).toEqual([{
      criterionVersionId: v3, introducedBy: 'CONTRACT', rubricVersionId: rubric, sourceVerb: 'REPLACE',
    }]);
  });

  it('allows a later ADD after replacement without resurrecting prior members', () => {
    const folded: FoldedCriterionOperations[] = [{ criterionKey: 'STD.X', operations: [
      operation('STANDARD', 'INHERIT', v1), operation('CLIENT', 'REPLACE', v2), operation('CONTRACT', 'ADD', v3),
    ] }];
    expect(applyReplace(folded)[0]!.members.map((member) => member.criterionVersionId)).toEqual([v2, v3]);
  });

  it('fails closed when replacement has no upstream or no pin', () => {
    expect(() => applyReplace([{ criterionKey: 'STD.X', operations: [operation('CLIENT', 'REPLACE', v2)] }]))
      .toThrow('requires an upstream criterion');
    expect(() => applyReplace([{ criterionKey: 'STD.X', operations: [
      operation('STANDARD', 'INHERIT', v1), operation('CLIENT', 'REPLACE', null),
    ] }])).toThrow('requires a criterion version pin');
  });
});
