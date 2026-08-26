import { z } from 'zod';

const cellSchema = z.object({
  rowIndex: z.number().int().nonnegative(), columnIndex: z.number().int().nonnegative(),
  rowSpan: z.number().int().positive().optional(), columnSpan: z.number().int().positive().optional(),
  content: z.string(), kind: z.string().optional(),
  boundingRegions: z.array(z.object({ pageNumber: z.number().int().positive(), polygon: z.array(z.number()).optional() })).optional(),
}).passthrough();
const tableSchema = z.object({
  rowCount: z.number().int().positive(), columnCount: z.number().int().positive(),
  cells: z.array(cellSchema),
  boundingRegions: z.array(z.object({ pageNumber: z.number().int().positive(), polygon: z.array(z.number()).optional() })).optional(),
}).passthrough();
export const AzureLayoutTablesSchema = z.array(tableSchema);

export interface ReassembledCell {
  rowIndex: number; columnIndex: number; rowSpan: number; columnSpan: number; content: string;
  source: { tableIndex: number; pageNumber: number; rowIndex: number; columnIndex: number; boundingRegions: unknown[] };
}
export interface ReassembledTable {
  columnCount: number; rowCount: number; headerSignature: string;
  sourceTableIndexes: number[]; pageNumbers: number[]; cells: ReassembledCell[];
}

export function reassembleMultipageTables(untrustedTables: unknown): ReassembledTable[] {
  const tables = AzureLayoutTablesSchema.parse(untrustedTables).map((table, tableIndex) => ({
    table, tableIndex, pageNumber: singlePage(table), headerSignature: headerSignature(table),
  })).sort((a, b) => (a.pageNumber ?? Number.MAX_SAFE_INTEGER) - (b.pageNumber ?? Number.MAX_SAFE_INTEGER) || a.tableIndex - b.tableIndex);

  const output: ReassembledTable[] = [];
  for (const fragment of tables) {
    const prior = output.at(-1);
    const canJoin = prior !== undefined && fragment.pageNumber !== null
      && prior.pageNumbers.at(-1)! + 1 === fragment.pageNumber
      && prior.columnCount === fragment.table.columnCount
      && prior.headerSignature !== '' && prior.headerSignature === fragment.headerSignature;
    if (!canJoin) {
      output.push(buildTable(fragment));
      continue;
    }
    const headerRows = headerRowIndexes(fragment.table);
    const firstDataRow = headerRows.size ? Math.max(...headerRows) + 1 : 0;
    const rowOffset = prior.rowCount - firstDataRow;
    for (const cell of fragment.table.cells) {
      if (cell.rowIndex < firstDataRow) continue;
      prior.cells.push(normalizeCell(cell, fragment.tableIndex, fragment.pageNumber!, cell.rowIndex + rowOffset));
    }
    prior.rowCount += fragment.table.rowCount - firstDataRow;
    prior.sourceTableIndexes.push(fragment.tableIndex);
    prior.pageNumbers.push(fragment.pageNumber!);
  }
  return output;
}

type ParsedTable = z.infer<typeof tableSchema>;
function buildTable(fragment: { table: ParsedTable; tableIndex: number; pageNumber: number | null; headerSignature: string }): ReassembledTable {
  return {
    columnCount: fragment.table.columnCount, rowCount: fragment.table.rowCount,
    headerSignature: fragment.headerSignature, sourceTableIndexes: [fragment.tableIndex],
    pageNumbers: fragment.pageNumber === null ? [] : [fragment.pageNumber],
    cells: fragment.table.cells.map((cell) => normalizeCell(cell, fragment.tableIndex, fragment.pageNumber, cell.rowIndex)),
  };
}

function normalizeCell(cell: z.infer<typeof cellSchema>, tableIndex: number, pageNumber: number | null, rowIndex: number): ReassembledCell {
  return {
    rowIndex, columnIndex: cell.columnIndex, rowSpan: cell.rowSpan ?? 1, columnSpan: cell.columnSpan ?? 1,
    content: cell.content.normalize('NFC'),
    source: { tableIndex, pageNumber: pageNumber ?? cell.boundingRegions?.[0]?.pageNumber ?? 0,
      rowIndex: cell.rowIndex, columnIndex: cell.columnIndex, boundingRegions: cell.boundingRegions ?? [] },
  };
}

function singlePage(table: ParsedTable): number | null {
  const pages = new Set([...(table.boundingRegions ?? []).map((region) => region.pageNumber),
    ...table.cells.flatMap((cell) => (cell.boundingRegions ?? []).map((region) => region.pageNumber))]);
  return pages.size === 1 ? [...pages][0]! : null;
}

function headerRowIndexes(table: ParsedTable): Set<number> {
  const explicit = new Set(table.cells.filter((cell) => cell.kind === 'columnHeader').map((cell) => cell.rowIndex));
  return explicit.size ? explicit : new Set([0]);
}

function headerSignature(table: ParsedTable): string {
  const rows = headerRowIndexes(table);
  return table.cells.filter((cell) => rows.has(cell.rowIndex)).sort((a, b) => a.rowIndex - b.rowIndex || a.columnIndex - b.columnIndex)
    .map((cell) => `${cell.columnIndex}:${cell.content.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')}`).join('|');
}
