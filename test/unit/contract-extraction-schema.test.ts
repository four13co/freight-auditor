import { describe, expect, it } from 'vitest';
import {
  CONTRACT_EXTRACTION_SCHEMA_VERSION, ContractExtractionJsonSchema, parseContractExtraction,
} from '../../src/modules/contracts/contract-extraction-schema.js';

const citation = { pageNumber: 2, excerpt: 'Fuel surcharge is 12% of linehaul', span: { offset: 410, length: 36 } };
function found(rawText = '12%', normalizedValue: string | null = '12') {
  return { status: 'FOUND' as const, rawText, normalizedValue, confidence: 0.97, citations: [citation] };
}
function validOutput() {
  return {
    schemaVersion: CONTRACT_EXTRACTION_SCHEMA_VERSION,
    sourceDocumentSha256: 'a'.repeat(64),
    model: { provider: 'anthropic', modelId: 'claude-opus-4-8', promptVersion: 'contract-extract/1' },
    fields: [{ path: 'contract.validFrom', semanticType: 'DATE', value: found('January 1, 2026', '2026-01-01') }],
    clauses: [{ clauseReference: '4.2', title: 'Fuel surcharge', text: found('Fuel surcharge is 12% of linehaul', null) }],
    rateTables: [{ tableKey: 'fuel-brackets', title: found('Fuel surcharge table', null), orientation: 'ROW_BRACKETS',
      rowCount: 2, columnCount: 2, cells: [
        { rowIndex: 0, columnIndex: 0, rowSpan: 1, columnSpan: 1, role: 'COLUMN_HEADER', value: found('Index', null) },
        { rowIndex: 0, columnIndex: 1, rowSpan: 1, columnSpan: 1, role: 'COLUMN_HEADER', value: found('Rate', null) },
        { rowIndex: 1, columnIndex: 0, rowSpan: 1, columnSpan: 1, role: 'VALUE', value: found('4.00', '4.00') },
        { rowIndex: 1, columnIndex: 1, rowSpan: 1, columnSpan: 1, role: 'VALUE', value: found('12%', '12') },
      ] }],
  };
}

describe('ContractExtractionSchema', () => {
  it('accepts a pinned, citation-grounded structured extraction', () => {
    expect(parseContractExtraction(validOutput())).toEqual(validOutput());
    expect(ContractExtractionJsonSchema).toMatchObject({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' });
  });

  it('requires citations for every found value', () => {
    const output = validOutput();
    output.fields[0]!.value.citations = [];
    expect(() => parseContractExtraction(output)).toThrow();
  });

  it('represents missing and ambiguous values as actionable abstentions', () => {
    const output = validOutput();
    output.fields[0]!.value = { status: 'AMBIGUOUS', rawText: 'effective Jan.', normalizedValue: null,
      confidence: 0.2, citations: [citation], clarificationQuestion: 'Which year is the effective date?' } as never;
    expect(parseContractExtraction(output).fields[0]!.value).toMatchObject({ status: 'AMBIGUOUS', normalizedValue: null });
  });

  it('rejects unpinned, unknown, and authoritative calculation fields', () => {
    const unpinned = validOutput() as Record<string, unknown>;
    delete (unpinned.model as Record<string, unknown>).promptVersion;
    expect(() => parseContractExtraction(unpinned)).toThrow();

    const authoritative = { ...validOutput(), expectedCharge: { amount: '120.00', currency: 'USD' } };
    expect(() => parseContractExtraction(authoritative)).toThrow();
  });

  it('rejects duplicate identities and overlapping or out-of-bounds table cells', () => {
    const output = validOutput();
    output.fields.push({ ...output.fields[0]!, path: 'contract.validfrom' });
    output.rateTables[0]!.cells.push({ ...output.rateTables[0]!.cells[3]!, rowIndex: 1, columnIndex: 1 });
    output.rateTables[0]!.cells.push({ ...output.rateTables[0]!.cells[3]!, rowIndex: 2, columnIndex: 0 });
    const parsed = (() => { try { parseContractExtraction(output); return null; } catch (error) { return error; } })();
    expect(parsed).toBeTruthy();
  });

  it('rejects guessed values disguised as abstentions and citations without a source locator', () => {
    const guessed = validOutput();
    guessed.fields[0]!.value = { status: 'NOT_FOUND', rawText: null, normalizedValue: '2026-01-01', confidence: 0,
      citations: [], clarificationQuestion: 'What is the effective date?' } as never;
    expect(() => parseContractExtraction(guessed)).toThrow();

    const uncited = validOutput();
    uncited.clauses[0]!.text.citations = [{ pageNumber: 2, excerpt: 'Fuel surcharge is 12% of linehaul' } as never];
    expect(() => parseContractExtraction(uncited)).toThrow();
  });
});
