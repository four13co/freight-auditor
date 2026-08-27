import { describe, expect, it } from 'vitest';
import type { ReassembledCell, ReassembledTable } from '../../src/modules/contracts/reassemble-multipage-tables.js';
import { reassembleAndValidateRateTables, validateRateTable } from '../../src/modules/contracts/validate-rate-table.js';

function cell(rowIndex: number, columnIndex: number, content: string): ReassembledCell {
  return { rowIndex, columnIndex, rowSpan: 1, columnSpan: 1, content,
    source: { tableIndex: 0, pageNumber: 1, rowIndex, columnIndex, boundingRegions: [{ pageNumber: 1 }] } };
}
function table(cells: ReassembledCell[], rowCount = 4, columnCount = 2): ReassembledTable {
  return { rowCount, columnCount, headerSignature: 'weight|rate', sourceTableIndexes: [0], pageNumbers: [1], cells };
}

describe('validateRateTable', () => {
  it('accepts cited row-oriented brackets and parses formatted decimals exactly', () => {
    const result = validateRateTable(table([
      cell(0, 0, 'Weight'), cell(0, 1, 'Rate'), cell(1, 0, '0'), cell(1, 1, '$10.00'),
      cell(2, 0, '1,000'), cell(2, 1, '$9.50'), cell(3, 0, '2,000'), cell(3, 1, '$9.00'),
    ]));
    expect(result).toMatchObject({ valid: true, orientation: 'ROW_BRACKETS', bracketAxisIndex: 0,
      bracketValues: ['0', '1000', '2000'], issues: [] });
  });

  it('detects a transposed, column-oriented table', () => {
    const result = validateRateTable(table([
      cell(0, 0, 'Weight'), cell(0, 1, '0'), cell(0, 2, '1000'), cell(0, 3, '2000'),
      cell(1, 0, 'Rate'), cell(1, 1, '10'), cell(1, 2, '9.5'), cell(1, 3, '9'),
    ], 2, 4));
    expect(result).toMatchObject({ valid: true, orientation: 'COLUMN_BRACKETS', bracketAxisIndex: 0,
      bracketValues: ['0', '1000', '2000'] });
  });

  it('fails safely for duplicate or reversed brackets while retaining source citations', () => {
    const result = validateRateTable(table([
      cell(0, 0, 'Weight'), cell(0, 1, 'Rate'), cell(1, 0, '0'), cell(1, 1, '10'),
      cell(2, 0, '1000'), cell(2, 1, '9'), cell(3, 0, '1000'), cell(3, 1, '8'),
    ]));
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'NON_MONOTONIC_BRACKETS',
      cells: expect.arrayContaining([expect.objectContaining({ source: expect.objectContaining({ pageNumber: 1, rowIndex: 3 }) })]) }));
  });

  it('does not guess when row and column bracket orientations are equally plausible', () => {
    const result = validateRateTable(table([
      cell(0, 0, 'x'), cell(0, 1, '1'), cell(1, 0, '2'), cell(1, 1, 'rate'),
    ], 2, 2));
    expect(result).toMatchObject({ valid: false, orientation: 'AMBIGUOUS', bracketAxisIndex: null });
    expect(result.issues.map((issue) => issue.code)).toContain('BRACKETS_NOT_FOUND');
  });

  it('rejects malformed values, overlapping spans, and out-of-bounds cells deterministically', () => {
    const overlapping = { ...cell(1, 0, '0'), columnSpan: 2 };
    const result = validateRateTable(table([
      cell(0, 0, 'Weight'), cell(0, 1, 'Rate'), overlapping, cell(1, 1, '10'),
      cell(2, 0, '1..5'), cell(2, 1, '9'), { ...cell(3, 1, '8'), columnSpan: 2 },
    ]));
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'OVERLAPPING_CELLS', 'INVALID_NUMERIC_VALUE', 'CELL_OUT_OF_BOUNDS',
    ]));
  });

  it('schema-rejects uncited cells before validation', () => {
    const malformed = table([cell(0, 0, 'Weight'), cell(1, 0, '100')]);
    malformed.cells[1]!.source.pageNumber = 0;
    expect(() => validateRateTable(malformed)).toThrow();
  });

  it('validates reassembled multi-page provider tables end to end', () => {
    const fragment = (pageNumber: number, threshold: string) => ({ rowCount: 2, columnCount: 2,
      boundingRegions: [{ pageNumber }], cells: [
        { rowIndex: 0, columnIndex: 0, content: 'Weight', kind: 'columnHeader', boundingRegions: [{ pageNumber }] },
        { rowIndex: 0, columnIndex: 1, content: 'Rate', kind: 'columnHeader', boundingRegions: [{ pageNumber }] },
        { rowIndex: 1, columnIndex: 0, content: threshold, boundingRegions: [{ pageNumber }] },
        { rowIndex: 1, columnIndex: 1, content: '$10', boundingRegions: [{ pageNumber }] },
      ] });
    const [result] = reassembleAndValidateRateTables([fragment(1, '0'), fragment(2, '1000')]);
    expect(result).toMatchObject({ valid: true, orientation: 'ROW_BRACKETS', bracketValues: ['0', '1000'],
      table: { rowCount: 3, pageNumbers: [1, 2] } });
  });
});
