import { describe, expect, it } from 'vitest';
import { reassembleMultipageTables } from '../../src/modules/contracts/reassemble-multipage-tables.js';

function table(pageNumber: number, header = 'Weight', value = '100', columnCount = 2) {
  return { rowCount: 2, columnCount, boundingRegions: [{ pageNumber }], cells: [
    { rowIndex: 0, columnIndex: 0, content: header, kind: 'columnHeader', boundingRegions: [{ pageNumber }] },
    { rowIndex: 0, columnIndex: 1, content: 'Rate', kind: 'columnHeader', boundingRegions: [{ pageNumber }] },
    { rowIndex: 1, columnIndex: 0, content: value, boundingRegions: [{ pageNumber }] },
    { rowIndex: 1, columnIndex: 1, content: '$10', boundingRegions: [{ pageNumber, polygon: [0, 0, 1, 1] }] },
  ] };
}

describe('reassembleMultipageTables', () => {
  it('joins adjacent fragments with identical normalized headers and removes the repeated header', () => {
    const result = reassembleMultipageTables([table(1), table(2, '  WEIGHT  ', '200')]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rowCount: 3, pageNumbers: [1, 2], sourceTableIndexes: [0, 1] });
    expect(result[0]!.cells.filter((cell) => cell.rowIndex === 0)).toHaveLength(2);
    expect(result[0]!.cells.find((cell) => cell.content === '200')).toMatchObject({ rowIndex: 2, source: { pageNumber: 2, rowIndex: 1, tableIndex: 1 } });
  });

  it('keeps nonadjacent, header-mismatched, and column-mismatched tables separate', () => {
    expect(reassembleMultipageTables([table(1), table(3)])).toHaveLength(2);
    expect(reassembleMultipageTables([table(1), table(2, 'Distance')])).toHaveLength(2);
    expect(reassembleMultipageTables([table(1), table(2, 'Weight', '200', 3)])).toHaveLength(2);
  });

  it('keeps ambiguous multi-page/uncited fragments separate and stable', () => {
    const ambiguous = table(1);
    ambiguous.boundingRegions = [{ pageNumber: 1 }, { pageNumber: 2 }];
    expect(reassembleMultipageTables([table(2), ambiguous]).map((item) => item.sourceTableIndexes)).toEqual([[0], [1]]);
  });

  it('rejects malformed provider tables before transformation', () => {
    expect(() => reassembleMultipageTables([{ rowCount: 0, columnCount: 2, cells: [] }])).toThrow();
  });
});
