import { describe, expect, it, vi } from 'vitest';
import type { ContractExtraction } from '../../src/modules/contracts/contract-extraction-schema.js';
import { CLAUSE_NORMALIZATION_PROMPT, CLAUSE_NORMALIZATION_PROMPT_VERSION, CLAUSE_NORMALIZATION_SCHEMA_VERSION,
  ClauseNormalizationSchema, normalizeContractClauses } from '../../src/modules/contracts/clause-normalization.js';
import type { VersionedAnthropicProvider } from '../../src/modules/contracts/anthropic-provider.js';

const citation = { pageNumber: 2, excerpt: 'Fuel surcharge is 12% of linehaul', span: { offset: 410, length: 36 } };
const extraction: ContractExtraction = { schemaVersion: 'contract-extraction/1', sourceDocumentSha256: 'a'.repeat(64),
  model: { provider: 'anthropic', modelId: 'claude-opus-5', promptVersion: 'contract-extract/1' }, fields: [], rateTables: [],
  clauses: [{ clauseReference: '4.2', title: 'Fuel surcharge', text: { status: 'FOUND', rawText: citation.excerpt,
    normalizedValue: null, confidence: 0.97, citations: [citation] } }] };
const normalized = { schemaVersion: CLAUSE_NORMALIZATION_SCHEMA_VERSION, clauses: [{ status: 'NORMALIZED' as const,
  clauseReference: '4.2', category: 'ACCESSORIAL' as const, title: 'Fuel surcharge', summary: 'Fuel is stated as a linehaul percentage.',
  applicability: ['shipments governed by this contract'], terms: [{ key: 'fuel_percentage', semanticType: 'PERCENTAGE' as const,
    sourceValue: '12%', unit: 'percent of linehaul', citations: [citation] }], citations: [citation] }] };

describe('clause normalization prompt and schema', () => {
  it('accepts citation-grounded semantic proposals without executable rule fields', () => {
    expect(ClauseNormalizationSchema.parse(normalized)).toEqual(normalized);
    expect(JSON.stringify(normalized)).not.toMatch(/ruleAst|expectedCharge|varianceAmount|lifecycle/i);
    expect(CLAUSE_NORMALIZATION_PROMPT.version).toBe(CLAUSE_NORMALIZATION_PROMPT_VERSION);
    expect(CLAUSE_NORMALIZATION_PROMPT.system).toMatch(/Do not produce rule ASTs/);
    expect(CLAUSE_NORMALIZATION_PROMPT.system).toMatch(/authoritative calculations/);
  });

  it('requires citations for normalized clauses and every extracted term', () => {
    expect(() => ClauseNormalizationSchema.parse({ ...normalized, clauses: [{ ...normalized.clauses[0], citations: [] }] })).toThrow();
    expect(() => ClauseNormalizationSchema.parse({ ...normalized, clauses: [{ ...normalized.clauses[0],
      terms: [{ ...normalized.clauses[0]!.terms[0], citations: [] }] }] })).toThrow();
  });

  it('supports explicit abstention and rejects guessed normalized values', () => {
    const abstained = { schemaVersion: CLAUSE_NORMALIZATION_SCHEMA_VERSION, clauses: [{ status: 'ABSTAINED', clauseReference: '7',
      reason: 'AMBIGUOUS_MEANING', clarificationQuestion: 'Does weekend detention use calendar or business days?', citations: [citation] }] };
    expect(ClauseNormalizationSchema.parse(abstained)).toEqual(abstained);
    expect(() => ClauseNormalizationSchema.parse({ ...abstained, clauses: [{ ...abstained.clauses[0], normalizedValue: 'guess' }] })).toThrow();
  });

  it('rejects duplicate clauses, duplicate terms, malformed citations, and unknown fields', () => {
    expect(() => ClauseNormalizationSchema.parse({ ...normalized, clauses: [...normalized.clauses, normalized.clauses[0]] })).toThrow(/duplicate clause/i);
    expect(() => ClauseNormalizationSchema.parse({ ...normalized, clauses: [{ ...normalized.clauses[0],
      terms: [normalized.clauses[0]!.terms[0], normalized.clauses[0]!.terms[0]] }] })).toThrow(/duplicate semantic term/i);
    expect(() => ClauseNormalizationSchema.parse({ ...normalized, clauses: [{ ...normalized.clauses[0],
      citations: [{ pageNumber: 2, excerpt: 'unclear' }] }] })).toThrow();
    expect(() => ClauseNormalizationSchema.parse({ ...normalized, activated: true })).toThrow();
  });

  it('calls the versioned provider with only extracted evidence and pinned source provenance', async () => {
    const generateStructured = vi.fn().mockResolvedValue({ output: normalized });
    const result = await normalizeContractClauses({ generateStructured } as unknown as VersionedAnthropicProvider, extraction);
    expect(result.output).toBe(normalized);
    expect(generateStructured).toHaveBeenCalledWith({ prompt: CLAUSE_NORMALIZATION_PROMPT,
      outputSchema: ClauseNormalizationSchema, sourceDocumentSha256: 'a'.repeat(64),
      untrustedEvidence: JSON.stringify(extraction.clauses.map((clause) => ({ clauseReference: clause.clauseReference,
        title: clause.title, text: clause.text }))) });
  });

  it('fails closed when output references or citations do not match verified evidence', async () => {
    const generateStructured = vi.fn().mockResolvedValue({ output: { ...normalized, clauses: [{ ...normalized.clauses[0], clauseReference: '99' }] } });
    await expect(normalizeContractClauses({ generateStructured } as unknown as VersionedAnthropicProvider, extraction))
      .rejects.toMatchObject({ code: 'UNGROUNDED_OUTPUT' });
    generateStructured.mockResolvedValue({ output: { ...normalized, clauses: [{ ...normalized.clauses[0],
      citations: [{ ...citation, excerpt: 'invented citation' }] }] } });
    await expect(normalizeContractClauses({ generateStructured } as unknown as VersionedAnthropicProvider, extraction))
      .rejects.toMatchObject({ code: 'UNGROUNDED_OUTPUT' });
  });

  it('fails before provider invocation when verified extraction has no clauses', async () => {
    const generateStructured = vi.fn();
    await expect(normalizeContractClauses({ generateStructured } as unknown as VersionedAnthropicProvider,
      { ...extraction, clauses: [] })).rejects.toMatchObject({ code: 'NO_CLAUSES' });
    expect(generateStructured).not.toHaveBeenCalled();
  });
});
