import ExcelJS from 'exceljs';

export const XLSX_PARSER_VERSION = 'exceljs-4.4.0/fa-1';
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_SHEETS = 50;
const MAX_CELLS = 250_000;

export type NormalizedCellValue = string | number | boolean | null | { error: string };
export interface ParsedXlsxCell {
  address: string;
  row: number;
  column: number;
  value: NormalizedCellValue;
  formula: string | null;
  cachedFormulaResult: NormalizedCellValue;
  numberFormat: string | null;
  merge: null | { role: 'master' | 'inherited'; masterAddress: string; range: string };
}
export interface ParsedXlsxMerge { range: string; masterAddress: string; start: { row: number; column: number }; end: { row: number; column: number } }
export interface ParsedXlsxSheet { name: string; ordinal: number; cells: ParsedXlsxCell[]; merges: ParsedXlsxMerge[] }
export interface ParsedContractXlsx { parserVersion: string; dateSystem: '1900' | '1904'; sheets: ParsedXlsxSheet[] }

export class ContractXlsxError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ContractXlsxError'; }
}

export async function parseContractXlsx(bytes: Buffer): Promise<ParsedContractXlsx> {
  if (!bytes.byteLength) throw new ContractXlsxError('EMPTY_XLSX', 'XLSX payload is empty');
  if (bytes.byteLength > MAX_BYTES) throw new ContractXlsxError('XLSX_TOO_LARGE', 'XLSX payload exceeds 25 MiB');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  } catch {
    throw new ContractXlsxError('INVALID_XLSX', 'XLSX payload could not be parsed');
  }
  if (workbook.worksheets.length > MAX_SHEETS) throw new ContractXlsxError('TOO_MANY_SHEETS', 'XLSX exceeds 50 sheets');

  let cellCount = 0;
  const sheets = workbook.worksheets.map((sheet, index) => {
    const merges = sheet.model.merges.map(parseMergeRange).sort((a, b) =>
      a.start.row - b.start.row || a.start.column - b.start.column || a.end.row - b.end.row || a.end.column - b.end.column,
    );
    const mergeByAddress = new Map<string, ParsedXlsxMerge>();
    for (const merge of merges) {
      for (let row = merge.start.row; row <= merge.end.row; row += 1) {
        for (let column = merge.start.column; column <= merge.end.column; column += 1) {
          mergeByAddress.set(sheet.getCell(row, column).address, merge);
        }
      }
    }
    const cells: ParsedXlsxCell[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cellCount += 1;
        if (cellCount > MAX_CELLS) throw new ContractXlsxError('TOO_MANY_CELLS', 'XLSX exceeds 250000 populated cells');
        const formula = formulaOf(cell.value);
        const merge = mergeByAddress.get(cell.address);
        const inherited = merge !== undefined && cell.address !== merge.masterAddress;
        cells.push({
          address: cell.address, row: cell.fullAddress.row, column: cell.fullAddress.col,
          value: inherited || formula ? null : normalizeValue(cell.value),
          formula: inherited ? null : formula,
          cachedFormulaResult: inherited ? null : formula ? normalizeValue(formulaResultOf(cell.value)) : null,
          numberFormat: cell.numFmt || null,
          merge: merge ? { role: inherited ? 'inherited' : 'master', masterAddress: merge.masterAddress, range: merge.range } : null,
        });
      });
    });
    cells.sort((a, b) => a.row - b.row || a.column - b.column);
    return { name: sheet.name.normalize('NFC'), ordinal: index + 1, cells, merges };
  });
  return { parserVersion: XLSX_PARSER_VERSION, dateSystem: workbook.properties.date1904 ? '1904' : '1900', sheets };
}

function parseMergeRange(range: string): ParsedXlsxMerge {
  const [startText, endText] = range.split(':');
  if (!startText || !endText) throw new ContractXlsxError('INVALID_MERGE_RANGE', 'XLSX contains an invalid merge range');
  const start = parseAddress(startText);
  const end = parseAddress(endText);
  return { range, masterAddress: startText, start, end };
}

function parseAddress(address: string): { row: number; column: number } {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(address);
  if (!match) throw new ContractXlsxError('INVALID_CELL_ADDRESS', 'XLSX contains an invalid cell address');
  let column = 0;
  for (const char of match[1]!) column = column * 26 + char.charCodeAt(0) - 64;
  return { row: Number(match[2]), column };
}

function formulaOf(value: ExcelJS.CellValue): string | null {
  if (value !== null && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    return 'formula' in value ? value.formula ?? null : `SHARED:${value.sharedFormula}`;
  }
  return null;
}

function formulaResultOf(value: ExcelJS.CellValue): ExcelJS.CellValue {
  if (value !== null && typeof value === 'object' && 'result' in value) return value.result ?? null;
  return null;
}

function normalizeValue(value: ExcelJS.CellValue): NormalizedCellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ContractXlsxError('INVALID_NUMBER', 'XLSX contains a non-finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if ('error' in value) return { error: value.error };
  if ('richText' in value) return value.richText.map((part) => part.text).join('').normalize('NFC');
  if ('text' in value) return value.text.normalize('NFC');
  // Formula objects are handled by the caller and never executed here.
  if ('formula' in value || 'sharedFormula' in value) return normalizeValue(value.result ?? null);
  throw new ContractXlsxError('UNSUPPORTED_CELL_VALUE', 'XLSX contains an unsupported cell value');
}
