import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { ContractXlsxError, parseContractXlsx, XLSX_PARSER_VERSION } from '../../src/modules/contracts/parse-contract-xlsx.js';

async function workbookBytes(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const second = workbook.addWorksheet('Z Rates');
  second.getCell('B2').value = 12.5;
  second.getCell('A1').value = 'Cafe\u0301';
  second.getCell('C2').value = { formula: 'B2*2', result: 25 };
  second.getCell('D2').value = new Date('2026-01-02T00:00:00.000Z');
  const first = workbook.addWorksheet('A Notes');
  first.getCell('A1').value = { richText: [{ text: 'Fuel ' }, { text: 'rate' }] };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('parseContractXlsx', () => {
  it('produces stable workbook/sheet/cell ordering and normalized scalar values', async () => {
    const bytes = await workbookBytes();
    const first = await parseContractXlsx(bytes);
    const second = await parseContractXlsx(bytes);
    expect(first).toEqual(second);
    expect(first.parserVersion).toBe(XLSX_PARSER_VERSION);
    expect(first.sheets.map((sheet) => sheet.name)).toEqual(['Z Rates', 'A Notes']);
    expect(first.sheets[0]!.cells.map((cell) => cell.address)).toEqual(['A1', 'B2', 'C2', 'D2']);
    expect(first.sheets[0]!.cells[0]!.value).toBe('Café');
    expect(first.sheets[1]!.cells[0]!.value).toBe('Fuel rate');
  });

  it('records formulas and cached values without executing arithmetic', async () => {
    const parsed = await parseContractXlsx(await workbookBytes());
    const formula = parsed.sheets[0]!.cells.find((cell) => cell.address === 'C2');
    expect(formula).toMatchObject({ value: null, formula: 'B2*2', cachedFormulaResult: 25 });
  });

  it('normalizes dates to UTC ISO strings', async () => {
    const parsed = await parseContractXlsx(await workbookBytes());
    expect(parsed.sheets[0]!.cells.find((cell) => cell.address === 'D2')?.value).toBe('2026-01-02T00:00:00.000Z');
  });

  it('rejects empty, malformed, and oversized payloads with stable codes', async () => {
    await expect(parseContractXlsx(Buffer.alloc(0))).rejects.toMatchObject({ code: 'EMPTY_XLSX' });
    await expect(parseContractXlsx(Buffer.from('not zip'))).rejects.toMatchObject({ code: 'INVALID_XLSX' });
    await expect(parseContractXlsx(Buffer.alloc(25 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'XLSX_TOO_LARGE' });
    expect(new ContractXlsxError('X', 'safe').message).toBe('safe');
  });
});
