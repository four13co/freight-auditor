import { describe, expect, it } from 'vitest';
import { applyInheritAdd } from '../../src/modules/rubric-resolver/apply-inherit-add.js';
import type { FoldedCriterionOperations } from '../../src/modules/rubric-resolver/fold-rubric-tiers.js';

const ids = {
  standardVersion: '11111111-1111-4111-8111-111111111111',
  clientVersion: '21111111-1111-4111-8111-111111111111',
  criterionA: '31111111-1111-4111-8111-111111111111',
  criterionB: '41111111-1111-4111-8111-111111111111',
};

const operation = (
  tier: 'STANDARD' | 'CLIENT',
  overrideVerb: 'INHERIT' | 'ADD' | 'REPLACE',
  criterionVersionId: string | null,
) => ({
  tier, overrideVerb, criterionVersionId, criterionKey: 'STD.X', evalOrder: 1,
  rubricVersionId: tier === 'STANDARD' ? ids.standardVersion : ids.clientVersion,
});

describe('INHERIT and ADD semantics', () => {
  it('preserves the upstream pin when a later tier inherits', () => {
    const folded: FoldedCriterionOperations[] = [{ criterionKey: 'STD.X', operations: [
      operation('STANDARD', 'INHERIT', ids.criterionA),
      operation('CLIENT', 'INHERIT', ids.criterionB),
    ] }];
    expect(applyInheritAdd(folded)[0]!.members).toEqual([{
      criterionVersionId: ids.criterionA, introducedBy: 'STANDARD',
      rubricVersionId: ids.standardVersion, sourceVerb: 'INHERIT',
    }]);
  });

  it('adds a distinct pin and deduplicates retry-equivalent additions', () => {
    const add = operation('CLIENT', 'ADD', ids.criterionB);
    const folded: FoldedCriterionOperations[] = [{ criterionKey: 'STD.X', operations: [
      operation('STANDARD', 'INHERIT', ids.criterionA), add, add,
    ] }];
    expect(applyInheritAdd(folded)[0]!.members.map((member) => member.criterionVersionId))
      .toEqual([ids.criterionA, ids.criterionB]);
  });

  it('allows ADD to introduce a criterion absent upstream', () => {
    const folded: FoldedCriterionOperations[] = [{ criterionKey: 'CLIENT.NEW', operations: [
      operation('CLIENT', 'ADD', ids.criterionB),
    ] }];
    expect(applyInheritAdd(folded)[0]!.members[0]).toMatchObject({
      criterionVersionId: ids.criterionB, introducedBy: 'CLIENT', sourceVerb: 'ADD',
    });
  });

  it('fails closed on missing pins or verbs owned by later stages', () => {
    expect(() => applyInheritAdd([{ criterionKey: 'STD.X', operations: [operation('STANDARD', 'INHERIT', null)] }]))
      .toThrow('requires a criterion version pin');
    expect(() => applyInheritAdd([{ criterionKey: 'STD.X', operations: [operation('CLIENT', 'REPLACE', ids.criterionB)] }]))
      .toThrow('unsupported verb REPLACE');
  });
});
