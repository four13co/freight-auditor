import { describe, expect, it, vi } from 'vitest';
import { CONTRACT_EXTRACTION_SCHEMA_VERSION } from '../../src/modules/contracts/contract-extraction-schema.js';
import { applyContractExtractionAbstention } from '../../src/modules/contracts/apply-contract-extraction-abstention.js';
import { persistValidatedContractExtractionWithAbstention,
  validateContractExtractionResponseWithAbstention } from '../../src/modules/contracts/validate-contract-extraction-response.js';

const pins = { provider: 'anthropic' as const, modelId: 'claude-opus-4-8', promptVersion: 'contract-extract/1', sourceDocumentSha256: 'a'.repeat(64) };
const citation = { pageNumber: 2, excerpt: 'Effective January 2026', span: { offset: 10, length: 22 } };
const policy = { version: 'abstention/1', minimumConfidence: 0.8, requiredFields: [
  { path: 'contract.validFrom', semanticType: 'DATE' as const, clarificationQuestion: 'What is the full contract effective date?' },
  { path: 'contract.currency', semanticType: 'CURRENCY' as const, clarificationQuestion: 'Which currency applies?' },
] };
function extraction() {
  return { schemaVersion: CONTRACT_EXTRACTION_SCHEMA_VERSION, sourceDocumentSha256: pins.sourceDocumentSha256,
    model: { provider: pins.provider, modelId: pins.modelId, promptVersion: pins.promptVersion }, fields: [
      { path: 'contract.validFrom', semanticType: 'DATE', value: { status: 'FOUND', rawText: 'January 2026',
        normalizedValue: '2026-01-01', confidence: 0.4, citations: [citation] } },
      { path: 'contract.name', semanticType: 'TEXT', value: { status: 'FOUND', rawText: 'Acme Contract',
        normalizedValue: 'Acme Contract', confidence: 0.99, citations: [citation] } },
    ], clauses: [], rateTables: [] };
}
function response() { return { ...pins, output: extraction() }; }

describe('applyContractExtractionAbstention', () => {
  it('downgrades low-confidence values and never retains a guessed normalization', () => {
    const result = applyContractExtractionAbstention(extraction(), policy);
    expect(result.extraction.fields.find((field) => field.path === 'contract.validFrom')!.value).toEqual({
      status: 'AMBIGUOUS', rawText: 'January 2026', normalizedValue: null, confidence: 0.4, citations: [citation],
      clarificationQuestion: 'What is the full contract effective date?',
    });
    expect(result.abstentions).toContainEqual(expect.objectContaining({ path: 'contract.validFrom', reason: 'LOW_CONFIDENCE' }));
  });

  it('adds explicit NOT_FOUND values for omitted required fields without inventing citations', () => {
    const result = applyContractExtractionAbstention(extraction(), policy);
    expect(result.extraction.fields.find((field) => field.path === 'contract.currency')!.value).toEqual({
      status: 'NOT_FOUND', rawText: null, normalizedValue: null, confidence: 0, citations: [], clarificationQuestion: 'Which currency applies?',
    });
    expect(result.abstentions).toContainEqual(expect.objectContaining({ path: 'contract.currency', reason: 'MISSING_REQUIRED_FIELD' }));
  });

  it('preserves confident cited values and existing model abstentions', () => {
    const value = extraction();
    value.fields.push({ path: 'contract.carrier', semanticType: 'TEXT', value: { status: 'NOT_FOUND', rawText: null,
      normalizedValue: null, confidence: 0, citations: [], clarificationQuestion: 'Who is the carrier?' } } as never);
    const result = applyContractExtractionAbstention(value, policy);
    expect(result.extraction.fields.find((field) => field.path === 'contract.name')!.value).toMatchObject({ status: 'FOUND', normalizedValue: 'Acme Contract' });
    expect(result.abstentions).toContainEqual(expect.objectContaining({ path: 'contract.carrier', reason: 'MODEL_ABSTENTION' }));
  });

  it('surfaces ambiguous table orientation as a fail-safe abstention', () => {
    const value = extraction();
    value.rateTables.push({ tableKey: 'fuel', title: { status: 'FOUND', rawText: 'Fuel', normalizedValue: null,
      confidence: 1, citations: [citation] }, orientation: 'AMBIGUOUS', rowCount: 1, columnCount: 1, cells: [] } as never);
    expect(applyContractExtractionAbstention(value, policy).abstentions).toContainEqual(expect.objectContaining({
      path: 'rateTables["fuel"].orientation', reason: 'AMBIGUOUS_TABLE_ORIENTATION', status: 'AMBIGUOUS',
    }));
  });

  it('is deterministic and rejects duplicate or malformed policy requirements', () => {
    expect(applyContractExtractionAbstention(extraction(), policy)).toEqual(applyContractExtractionAbstention(extraction(), policy));
    expect(() => applyContractExtractionAbstention(extraction(), { ...policy,
      requiredFields: [...policy.requiredFields, policy.requiredFields[0]!] })).toThrow();
  });

  it('runs after response validation and before persistence with a new content key', async () => {
    const processed = validateContractExtractionResponseWithAbstention(response(), pins, policy);
    const persist = vi.fn(async () => 'stored');
    const result = await persistValidatedContractExtractionWithAbstention(response(), pins, policy, persist);
    expect(result.idempotencyKey).toBe(processed.idempotencyKey);
    expect(result.idempotencyKey).not.toBe(validateContractExtractionResponseWithAbstention(
      { ...response(), output: { ...extraction(), fields: extraction().fields.map((field) => ({ ...field,
        value: { ...field.value, confidence: 1 } })) } }, pins, { ...policy, minimumConfidence: 1 },
    ).idempotencyKey);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ fields: expect.arrayContaining([
      expect.objectContaining({ path: 'contract.currency', value: expect.objectContaining({ status: 'NOT_FOUND' }) }),
    ]) }), result.idempotencyKey);
  });
});
