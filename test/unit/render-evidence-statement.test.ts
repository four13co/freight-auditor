import { describe, it, expect } from 'vitest';
import {
  renderEvidenceStatement,
  renderEvidenceStatements,
  RenderEvidenceStatementError,
  type RenderableEvidenceLine,
} from '../../src/modules/disputes/render-evidence-statement.js';
import type { DefensibilityChain } from '../../src/modules/findings/get-defensibility-chain.js';

const baseChain: DefensibilityChain = {
  finding: { id: 'f1', auditRunId: 'ar1', classification: null, varianceAmount: '50.0000', currency: 'USD', evaluatedExpr: {} },
  criterion: { id: 'c1', key: 'CONTRACT.RATE_VARIANCE' },
  ruleVersion: { id: 'rv1', astHash: 'a'.repeat(64) },
  clause: { id: 'cl1', reference: 'Section 4.2', page: '12' },
  rateCell: null,
  sourceDocument: null,
  transportDocument: null,
  contributors: { billedChargeFactIds: [], expectedChargeIds: [] },
};

const line = (overrides: Partial<RenderableEvidenceLine> = {}): RenderableEvidenceLine => ({
  disputeLineId: 'dl1',
  amount: '1000.0000',
  currency: 'USD',
  defensibilityChain: baseChain,
  ...overrides,
});

describe('renderEvidenceStatement', () => {
  it('injects the stored amount, variance, and clause citation', () => {
    const result = renderEvidenceStatement(line());
    expect(result).toEqual({
      disputeLineId: 'dl1',
      amountLabel: '1000.00 USD',
      varianceLabel: '50.00 USD',
      citations: [{ kind: 'clause', reference: 'Section 4.2', page: '12' }],
      criterionKey: 'CONTRACT.RATE_VARIANCE',
    });
  });

  it('includes a rate-cell citation when present', () => {
    const chain: DefensibilityChain = { ...baseChain, clause: null, rateCell: { id: 'rc1', reference: 'Zone 3 / 500lb' } };
    const result = renderEvidenceStatement(line({ defensibilityChain: chain }));
    expect(result.citations).toEqual([{ kind: 'rate_cell', reference: 'Zone 3 / 500lb', page: null }]);
  });

  it('includes a source-document citation when present', () => {
    const chain: DefensibilityChain = {
      ...baseChain, clause: null,
      sourceDocument: { id: 'sd1', sha256: 'b'.repeat(64), storageUri: 's3://x' },
    };
    const result = renderEvidenceStatement(line({ defensibilityChain: chain }));
    expect(result.citations).toEqual([{ kind: 'source_document', reference: 'b'.repeat(64), page: null }]);
  });

  it('includes multiple citations when more than one is present', () => {
    const chain: DefensibilityChain = { ...baseChain, rateCell: { id: 'rc1', reference: 'Zone 3' } };
    const result = renderEvidenceStatement(line({ defensibilityChain: chain }));
    expect(result.citations).toHaveLength(2);
  });

  it('omits varianceLabel when the finding has no variance amount', () => {
    const chain: DefensibilityChain = { ...baseChain, finding: { ...baseChain.finding, varianceAmount: null } };
    const result = renderEvidenceStatement(line({ defensibilityChain: chain }));
    expect(result.varianceLabel).toBeNull();
  });

  it('rejects a line with no amount', () => {
    try {
      renderEvidenceStatement(line({ amount: null }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RenderEvidenceStatementError);
      expect((err as RenderEvidenceStatementError).code).toBe('MISSING_AMOUNT_CURRENCY');
    }
  });

  it('rejects a line with no currency', () => {
    try {
      renderEvidenceStatement(line({ currency: null }));
      expect.unreachable();
    } catch (err) {
      expect((err as RenderEvidenceStatementError).code).toBe('MISSING_AMOUNT_CURRENCY');
    }
  });

  it('rejects a chain with no citation at all', () => {
    const chain: DefensibilityChain = { ...baseChain, clause: null, rateCell: null, sourceDocument: null };
    try {
      renderEvidenceStatement(line({ defensibilityChain: chain }));
      expect.unreachable();
    } catch (err) {
      expect((err as RenderEvidenceStatementError).code).toBe('NO_CITATION');
    }
  });
});

describe('renderEvidenceStatements', () => {
  it('renders every line in the given order without re-sorting', () => {
    const lineA = line({ disputeLineId: 'dl-a' });
    const lineB = line({ disputeLineId: 'dl-b' });
    const results = renderEvidenceStatements([lineB, lineA]);
    expect(results.map((r) => r.disputeLineId)).toEqual(['dl-b', 'dl-a']);
  });

  it('propagates a per-line rendering error', () => {
    const badLine = line({ amount: null });
    expect(() => renderEvidenceStatements([line(), badLine])).toThrow(RenderEvidenceStatementError);
  });
});
