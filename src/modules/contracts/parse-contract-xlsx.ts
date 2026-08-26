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
}
export interface ParsedXlsxSheet { name: string; ordinal: number; cells: ParsedXlsxCell[] }
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
    const cells: ParsedXlsxCell[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cellCount += 1;
        if (cellCount > MAX_CELLS) throw new ContractXlsxError('TOO_MANY_CELLS', 'XLSX exceeds 250000 populated cells');
        const formula = formulaOf(cell.value);
        cells.push({
          address: cell.address, row: cell.fullAddress.row, column: cell.fullAddress.col,
          value: formula ? null : normalizeValue(cell.value),
          formula,
          cachedFormulaResult: formula ? normalizeValue(formulaResultOf(cell.value)) : null,
          numberFormat: cell.numFmt || null,
        });
      });
    });
    cells.sort((a, b) => a.row - b.row || a.column - b.column);
    return { name: sheet.name.normalize('NFC'), ordinal: index + 1, cells };
  });
  return { parserVersion: XLSX_PARSER_VERSION, dateSystem: workbook.properties.date1904 ? '1904' : '1900', sheets };
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
