import { describe, expect, it } from 'vitest';
import { CLAUSE_NORMALIZATION_SCHEMA_VERSION, type ClauseNormalization } from '../../src/modules/contracts/clause-normalization.js';
import { requireProposalCitations, validateProposalCitations } from '../../src/modules/contracts/proposal-citation-gate.js';

const citationA = { pageNumber: 2, excerpt: 'Fuel applies.', span: { offset: 10, length: 13 } };
const citationB = { pageNumber: 4, excerpt: 'Detention applies.', span: { offset: 40, length: 18 } };
const normalization: ClauseNormalization = { schemaVersion: CLAUSE_NORMALIZATION_SCHEMA_VERSION, clauses: [
  { status: 'NORMALIZED', clauseReference: '4.2', category: 'ACCESSORIAL', title: 'Fuel', summary: 'Fuel.',
    applicability: [], terms: [], citations: [citationA] },
  { status: 'NORMALIZED', clauseReference: '7', category: 'ACCESSORIAL', title: 'Detention', summary: 'Detention.',
    applicability: [], terms: [], citations: [citationB] },
  { status: 'ABSTAINED', clauseReference: '9', reason: 'AMBIGUOUS_MEANING', clarificationQuestion: 'Clarify clause 9.', citations: [] },
] };
const criterion = (overrides: Partial<{ criterionKey: string; clauseReferences: string[]; citations: typeof citationA[] }> = {}) => ({
  criterionKey: 'CONTRACT.PROPOSED.ACCESSORIALS', clauseReferences: ['4.2'], citations: [citationA], ...overrides,
});

describe('proposal citation gate', () => {
  it('accepts a proposal only when every referenced clause has exact source citation coverage', () => {
    expect(validateProposalCitations({ criteria: [criterion({ clauseReferences: ['7', '4.2'], citations: [citationB, citationA] })] }, normalization))
      .toEqual({ accepted: true, rejections: [] });
  });

  it('rejects missing references and citations with stable codes', () => {
    expect(validateProposalCitations({ criteria: [criterion({ clauseReferences: [], citations: [] })] }, normalization)).toEqual({
      accepted: false, rejections: [
        { criterionKey: 'CONTRACT.PROPOSED.ACCESSORIALS', code: 'MISSING_CLAUSE_REFERENCE', clauseReference: null },
        { criterionKey: 'CONTRACT.PROPOSED.ACCESSORIALS', code: 'MISSING_CITATION', clauseReference: null },
      ],
    });
  });

  it('rejects unknown and abstained clause references', () => {
    const result = validateProposalCitations({ criteria: [criterion({ clauseReferences: ['99', '9'] })] }, normalization);
    expect(result.rejections).toContainEqual({ criterionKey: 'CONTRACT.PROPOSED.ACCESSORIALS', code: 'UNKNOWN_CLAUSE', clauseReference: '99' });
    expect(result.rejections).toContainEqual({ criterionKey: 'CONTRACT.PROPOSED.ACCESSORIALS', code: 'ABSTAINED_CLAUSE', clauseReference: '9' });
  });

  it('rejects partial coverage across multiple clauses and foreign citations', () => {
    const result = validateProposalCitations({ criteria: [criterion({ clauseReferences: ['4.2', '7'],
      citations: [citationA, { ...citationB, excerpt: 'invented' }] })] }, normalization);
    expect(result.rejections).toEqual([
      { criterionKey: 'CONTRACT.PROPOSED.ACCESSORIALS', code: 'UNCITED_CLAUSE', clauseReference: '7' },
      { criterionKey: 'CONTRACT.PROPOSED.ACCESSORIALS', code: 'UNKNOWN_CITATION', clauseReference: null },
    ]);
  });

  it('sorts criteria and references for deterministic retry results and throws one stable error', () => {
    const candidate = { criteria: [criterion({ criterionKey: 'CONTRACT.PROPOSED.Z', clauseReferences: ['99'] }),
      criterion({ criterionKey: 'CONTRACT.PROPOSED.A', clauseReferences: ['98'] })] };
    const first = validateProposalCitations(candidate, normalization); const retry = validateProposalCitations(candidate, normalization);
    expect(first).toEqual(retry);
    expect(first.rejections.map((item) => item.criterionKey)).toEqual([
      'CONTRACT.PROPOSED.A', 'CONTRACT.PROPOSED.A', 'CONTRACT.PROPOSED.Z', 'CONTRACT.PROPOSED.Z',
    ]);
    expect(() => requireProposalCitations(candidate, normalization)).toThrow(expect.objectContaining({ code: 'UNCITED_PROPOSAL', rejections: first.rejections }));
  });
});
