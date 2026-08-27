import { describe, expect, it, vi } from 'vitest';
import { CONTRACT_EXTRACTION_SCHEMA_VERSION } from '../../src/modules/contracts/contract-extraction-schema.js';
import {
  ContractExtractionValidationError, persistValidatedContractExtraction, validateContractExtractionResponse,
} from '../../src/modules/contracts/validate-contract-extraction-response.js';

const pins = { provider: 'anthropic' as const, modelId: 'claude-opus-4-8', promptVersion: 'contract-extract/1', sourceDocumentSha256: 'a'.repeat(64) };
const citation = { pageNumber: 1, excerpt: 'Effective January 1, 2026', span: { offset: 10, length: 25 } };
function output() {
  return { schemaVersion: CONTRACT_EXTRACTION_SCHEMA_VERSION, sourceDocumentSha256: pins.sourceDocumentSha256,
    model: { provider: pins.provider, modelId: pins.modelId, promptVersion: pins.promptVersion },
    fields: [{ path: 'contract.validFrom', semanticType: 'DATE', value: { status: 'FOUND', rawText: 'January 1, 2026',
      normalizedValue: '2026-01-01', confidence: 0.99, citations: [citation] } }], clauses: [], rateTables: [] };
}
function response() { return { ...pins, output: output() }; }

describe('validateContractExtractionResponse', () => {
  it('returns typed validated output and a stable content idempotency key', () => {
    const first = validateContractExtractionResponse(response(), pins);
    const reordered = { ...response(), output: { ...output(), fields: output().fields } };
    const second = validateContractExtractionResponse(reordered, pins);
    expect(first.extraction.fields[0]).toMatchObject({ path: 'contract.validFrom', value: { status: 'FOUND' } });
    expect(first.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it.each(['modelId', 'promptVersion', 'sourceDocumentSha256'] as const)('rejects a mismatched trusted %s pin', (key) => {
    const mismatched = { ...response(), [key]: key === 'sourceDocumentSha256' ? 'b'.repeat(64) : 'unexpected' };
    expect(() => validateContractExtractionResponse(mismatched, pins)).toThrowError(expect.objectContaining({ code: 'PIN_MISMATCH' }));
  });

  it('rejects nested model metadata that disagrees with the trusted envelope', () => {
    const nested = response();
    nested.output.model.promptVersion = 'untrusted-prompt';
    expect(() => validateContractExtractionResponse(nested, pins)).toThrowError(expect.objectContaining({ code: 'PIN_MISMATCH' }));
  });

  it('rejects malformed and uncited extraction output with a stable public error', () => {
    const malformed = response();
    malformed.output.fields[0]!.value.citations = [];
    expect(() => validateContractExtractionResponse(malformed, pins)).toThrowError(
      new ContractExtractionValidationError('INVALID_EXTRACTION', 'contract extraction output failed schema validation'),
    );
    expect(() => validateContractExtractionResponse({ ...response(), unexpected: true }, pins))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE_ENVELOPE' }));
  });

  it('never crosses the persistence boundary for an invalid response', async () => {
    const persist = vi.fn(async () => 'stored');
    const malformed = response();
    malformed.output.fields[0]!.value.citations = [];
    await expect(persistValidatedContractExtraction(malformed, pins, persist)).rejects.toMatchObject({ code: 'INVALID_EXTRACTION' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('passes only validated data and the deterministic key to persistence', async () => {
    const persist = vi.fn(async (_value, key: string) => ({ created: true, key }));
    const completed = await persistValidatedContractExtraction(response(), pins, persist);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: CONTRACT_EXTRACTION_SCHEMA_VERSION }), completed.idempotencyKey);
    expect(completed.result).toEqual({ created: true, key: completed.idempotencyKey });
  });
});
