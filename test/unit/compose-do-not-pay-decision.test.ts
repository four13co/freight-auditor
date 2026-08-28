import { describe, expect, it } from 'vitest';
import {
  composeDoNotPayDecision,
  DoNotPayDecisionError,
} from '../../src/modules/payments/compose-do-not-pay-decision.js';

describe('composeDoNotPayDecision', () => {
  it('composes a rationale from one gate failure with a citation', () => {
    const result = composeDoNotPayDecision([
      { id: 'f1', defect: 'Currency not stated', citation: 'EDI 310 C3-01' },
    ]);
    expect(result).toEqual({
      rationale: 'Currency not stated (EDI 310 C3-01)',
      gateFailureIds: ['f1'],
    });
  });

  it('composes a rationale from multiple gate failures in deterministic id order, not input order', () => {
    const result = composeDoNotPayDecision([
      { id: 'f2', defect: 'Missing shipment reference', citation: null },
      { id: 'f1', defect: 'Currency not stated', citation: 'EDI 310 C3-01' },
    ]);
    expect(result.gateFailureIds).toEqual(['f1', 'f2']);
    expect(result.rationale).toBe('Currency not stated (EDI 310 C3-01); Missing shipment reference');
  });

  it('omits the citation parenthetical when a gate failure has none', () => {
    const result = composeDoNotPayDecision([{ id: 'f1', defect: 'Structural defect', citation: null }]);
    expect(result.rationale).toBe('Structural defect');
  });

  it('rejects an empty gate-failure set rather than composing an empty decision', () => {
    expect(() => composeDoNotPayDecision([])).toThrow(DoNotPayDecisionError);
    expect(() => composeDoNotPayDecision([])).toThrow(expect.objectContaining({ code: 'NO_GATE_FAILURES' }));
  });

  it('is deterministic: the same unordered input always composes the same rationale', () => {
    const a = composeDoNotPayDecision([
      { id: 'f2', defect: 'B', citation: null },
      { id: 'f1', defect: 'A', citation: null },
    ]);
    const b = composeDoNotPayDecision([
      { id: 'f1', defect: 'A', citation: null },
      { id: 'f2', defect: 'B', citation: null },
    ]);
    expect(a).toEqual(b);
  });
});
