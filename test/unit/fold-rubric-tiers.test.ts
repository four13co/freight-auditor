import { describe, expect, it } from 'vitest';
import { foldRubricTiers } from '../../src/modules/rubric-resolver/fold-rubric-tiers.js';

const ids = {
  standardRubric: '11111111-1111-4111-8111-111111111111',
  standardVersion: '21111111-1111-4111-8111-111111111111',
  clientRubric: '31111111-1111-4111-8111-111111111111',
  clientVersion: '41111111-1111-4111-8111-111111111111',
  contractRubric: '51111111-1111-4111-8111-111111111111',
  contractVersion: '61111111-1111-4111-8111-111111111111',
  criterion: '71111111-1111-4111-8111-111111111111',
};

const membership = (overrideVerb: 'INHERIT' | 'ADD' | 'REPLACE', evalOrder = 10) => ({
  criterionKey: 'STD.AMOUNT_STATED', criterionVersionId: ids.criterion,
  overrideVerb, evalOrder,
});

describe('STANDARD -> CLIENT -> CONTRACT folding', () => {
  it('orders layers by tier regardless of database return order', () => {
    const folded = foldRubricTiers([
      { tier: 'CONTRACT', rubricId: ids.contractRubric, rubricVersionId: ids.contractVersion, memberships: [membership('REPLACE')] },
      { tier: 'STANDARD', rubricId: ids.standardRubric, rubricVersionId: ids.standardVersion, memberships: [membership('INHERIT')] },
      { tier: 'CLIENT', rubricId: ids.clientRubric, rubricVersionId: ids.clientVersion, memberships: [membership('ADD')] },
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.operations.map((operation) => operation.tier)).toEqual(['STANDARD', 'CLIENT', 'CONTRACT']);
    expect(folded[0]!.operations.map((operation) => operation.overrideVerb)).toEqual(['INHERIT', 'ADD', 'REPLACE']);
  });

  it('orders criteria deterministically by eval order then key', () => {
    const layer = {
      tier: 'STANDARD', rubricId: ids.standardRubric, rubricVersionId: ids.standardVersion,
      memberships: [membership('INHERIT', 20), { ...membership('INHERIT', 10), criterionKey: 'STD.B' }],
    };
    expect(foldRubricTiers([layer]).map((criterion) => criterion.criterionKey))
      .toEqual(['STD.B', 'STD.AMOUNT_STATED']);
  });

  it('fails closed when selection contains multiple versions for one tier', () => {
    const layer = { tier: 'STANDARD', rubricId: ids.standardRubric, rubricVersionId: ids.standardVersion, memberships: [] };
    expect(() => foldRubricTiers([layer, { ...layer, rubricVersionId: ids.clientVersion }]))
      .toThrow('Multiple selected rubric versions for one tier');
  });
});
