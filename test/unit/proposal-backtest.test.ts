import { describe, expect, it } from 'vitest';
import { evaluateProposalCorpus, ProposalBacktestError } from '../../src/modules/contracts/backtest-contract-rule-proposals.js';

const ast = { type: 'require' as const, key: 'has_fuel_category', then: { type: 'compare' as const, op: 'eq' as const,
  left: { type: 'fact' as const, key: 'has_fuel_category' }, right: { type: 'lit' as const, value: true } } };

describe('proposal backtest corpus', () => {
  it('deterministically records passing, failing, and unassessable evaluated evidence in case-key order', () => {
    const cases = [
      { caseKey: 'present', facts: { has_fuel_category: true }, expectedVerdict: 'PASS' as const },
      { caseKey: 'missing', facts: {}, expectedVerdict: 'UNASSESSABLE' as const },
      { caseKey: 'regression', facts: { has_fuel_category: false }, expectedVerdict: 'PASS' as const },
    ];
    const result = evaluateProposalCorpus(ast, ['has_fuel_category'], cases);
    expect(result.map(({ caseKey, actualVerdict, passed }) => ({ caseKey, actualVerdict, passed }))).toEqual([
      { caseKey: 'missing', actualVerdict: 'UNASSESSABLE', passed: true },
      { caseKey: 'present', actualVerdict: 'PASS', passed: true },
      { caseKey: 'regression', actualVerdict: 'FAIL', passed: false },
    ]);
    expect(evaluateProposalCorpus(ast, ['has_fuel_category'], [...cases].reverse())).toEqual(result);
    expect(result.every((item) => /^[a-f0-9]{64}$/.test(item.actualHash))).toBe(true);
  });

  it('fails closed on duplicate case keys and facts outside the proposal allowlist', () => {
    expect(() => evaluateProposalCorpus(ast, ['has_fuel_category'], [
      { caseKey: 'same', facts: {}, expectedVerdict: 'PASS' },
      { caseKey: 'same', facts: {}, expectedVerdict: 'FAIL' },
    ])).toThrowError(ProposalBacktestError);
    expect(() => evaluateProposalCorpus(ast, ['has_fuel_category'], [
      { caseKey: 'foreign', facts: { duplicate_invoice: true }, expectedVerdict: 'PASS' },
    ])).toThrowError(expect.objectContaining({ code: 'UNEXPECTED_FACT' }));
  });
});
