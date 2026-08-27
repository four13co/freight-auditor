import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { reassembleMultipageTables, type ReassembledCell, type ReassembledTable } from './reassemble-multipage-tables.js';

const sourceSchema = z.object({
  tableIndex: z.number().int().nonnegative(), pageNumber: z.number().int().positive(),
  rowIndex: z.number().int().nonnegative(), columnIndex: z.number().int().nonnegative(),
  boundingRegions: z.array(z.unknown()),
}).strict();
const cellSchema = z.object({
  rowIndex: z.number().int().nonnegative(), columnIndex: z.number().int().nonnegative(),
  rowSpan: z.number().int().positive(), columnSpan: z.number().int().positive(),
  content: z.string(), source: sourceSchema,
}).strict();
const reassembledTableSchema = z.object({
  columnCount: z.number().int().positive(), rowCount: z.number().int().positive(),
  headerSignature: z.string(), sourceTableIndexes: z.array(z.number().int().nonnegative()).min(1),
  pageNumbers: z.array(z.number().int().positive()), cells: z.array(cellSchema),
}).strict();

export type TableOrientation = 'ROW_BRACKETS' | 'COLUMN_BRACKETS' | 'AMBIGUOUS';
export type TableValidationCode =
  | 'CELL_OUT_OF_BOUNDS' | 'OVERLAPPING_CELLS' | 'EMPTY_VALUE' | 'INVALID_NUMERIC_VALUE'
  | 'BRACKETS_NOT_FOUND' | 'AMBIGUOUS_ORIENTATION' | 'NON_MONOTONIC_BRACKETS';
export interface TableValidationIssue {
  code: TableValidationCode;
  message: string;
  cells: Array<{ rowIndex: number; columnIndex: number; source: ReassembledCell['source'] }>;
}
export interface ValidatedRateTable {
  valid: boolean;
  orientation: TableOrientation;
  bracketAxisIndex: number | null;
  bracketValues: string[];
  issues: TableValidationIssue[];
  table: ReassembledTable;
}

interface Candidate { orientation: Exclude<TableOrientation, 'AMBIGUOUS'>; axisIndex: number; cells: ReassembledCell[]; values: Decimal[]; headerScore: number }

/** Schema-validates provider tables, reassembles adjacent fragments, then validates every resulting table. */
export function reassembleAndValidateRateTables(untrustedTables: unknown): ValidatedRateTable[] {
  return reassembleMultipageTables(untrustedTables).map(validateRateTable);
}

/** Validates an OCR/XLSX rate-table candidate without repairing or inferring any source value. */
export function validateRateTable(untrustedTable: unknown): ValidatedRateTable {
  const table = reassembledTableSchema.parse(untrustedTable) as ReassembledTable;
  const issues: TableValidationIssue[] = [];
  const occupied = new Map<string, ReassembledCell>();

  for (const cell of table.cells) {
    const refs = [{ rowIndex: cell.rowIndex, columnIndex: cell.columnIndex, source: cell.source }];
    if (cell.rowIndex + cell.rowSpan > table.rowCount || cell.columnIndex + cell.columnSpan > table.columnCount) {
      issues.push({ code: 'CELL_OUT_OF_BOUNDS', message: 'Cell span exceeds the declared table bounds', cells: refs });
      continue;
    }
    if (!cell.content.trim()) issues.push({ code: 'EMPTY_VALUE', message: 'Extracted cell value is empty', cells: refs });
    if (looksNumeric(cell.content) && parseDecimal(cell.content) === null) {
      issues.push({ code: 'INVALID_NUMERIC_VALUE', message: `Numeric-looking value is not an exact finite decimal: ${cell.content}`, cells: refs });
    }
    for (let row = cell.rowIndex; row < cell.rowIndex + cell.rowSpan; row += 1) {
      for (let column = cell.columnIndex; column < cell.columnIndex + cell.columnSpan; column += 1) {
        const key = `${row}:${column}`;
        const prior = occupied.get(key);
        if (prior) issues.push({ code: 'OVERLAPPING_CELLS', message: `Multiple source cells occupy row ${row}, column ${column}`,
          cells: [prior, cell].map((item) => ({ rowIndex: item.rowIndex, columnIndex: item.columnIndex, source: item.source })) });
        else occupied.set(key, cell);
      }
    }
  }

  const candidates = bracketCandidates(table);
  const selected = chooseCandidate(candidates);
  if (!selected) {
    issues.push({ code: candidates.length ? 'AMBIGUOUS_ORIENTATION' : 'BRACKETS_NOT_FOUND',
      message: candidates.length ? 'Both row- and column-oriented bracket sequences are plausible' : 'No cited numeric bracket sequence was found',
      cells: candidates.flatMap((candidate) => candidate.cells.map((cell) => ({ rowIndex: cell.rowIndex, columnIndex: cell.columnIndex, source: cell.source }))),
    });
  } else if (!strictlyMonotonic(selected.values)) {
    issues.push({ code: 'NON_MONOTONIC_BRACKETS', message: 'Bracket thresholds must be strictly monotonic without duplicates or reversals',
      cells: selected.cells.map((cell) => ({ rowIndex: cell.rowIndex, columnIndex: cell.columnIndex, source: cell.source })),
    });
  }

  return { valid: issues.length === 0, orientation: selected?.orientation ?? 'AMBIGUOUS',
    bracketAxisIndex: selected?.axisIndex ?? null, bracketValues: selected?.values.map((value) => value.toFixed()) ?? [], issues, table };
}

function bracketCandidates(table: ReassembledTable): Candidate[] {
  const candidates: Candidate[] = [];
  for (let column = 0; column < table.columnCount; column += 1) {
    const cells = axisCells(table.cells, 'columnIndex', column, 'rowIndex');
    const numeric = numericRun(cells);
    if (numeric) candidates.push({ orientation: 'ROW_BRACKETS', axisIndex: column, headerScore: bracketHeaderScore(cells), ...numeric });
  }
  for (let row = 0; row < table.rowCount; row += 1) {
    const cells = axisCells(table.cells, 'rowIndex', row, 'columnIndex');
    const numeric = numericRun(cells);
    if (numeric) candidates.push({ orientation: 'COLUMN_BRACKETS', axisIndex: row, headerScore: bracketHeaderScore(cells), ...numeric });
  }
  return candidates;
}

function axisCells(cells: ReassembledCell[], key: 'rowIndex' | 'columnIndex', index: number, order: 'rowIndex' | 'columnIndex') {
  return cells.filter((cell) => cell[key] === index && cell.rowSpan === 1 && cell.columnSpan === 1).sort((a, b) => a[order] - b[order]);
}

function numericRun(cells: ReassembledCell[]): { cells: ReassembledCell[]; values: Decimal[] } | null {
  const parsed = cells.map((cell) => ({ cell, value: parseDecimal(cell.content) })).filter((item) => item.value !== null) as Array<{ cell: ReassembledCell; value: Decimal }>;
  if (parsed.length < 2) return null;
  return { cells: parsed.map((item) => item.cell), values: parsed.map((item) => item.value) };
}

function chooseCandidate(candidates: Candidate[]): Candidate | null {
  if (!candidates.length) return null;
  const maxHeaderScore = Math.max(...candidates.map((candidate) => candidate.headerScore));
  const semantic = maxHeaderScore > 0 ? candidates.filter((candidate) => candidate.headerScore === maxHeaderScore) : candidates;
  const maxLength = Math.max(...semantic.map((candidate) => candidate.values.length));
  const longest = semantic.filter((candidate) => candidate.values.length === maxLength);
  if (longest.length !== 1) return null;
  return longest[0]!;
}

function bracketHeaderScore(cells: ReassembledCell[]): number {
  const header = cells.find((cell) => parseDecimal(cell.content) === null)?.content.normalize('NFKC').toLocaleLowerCase('en-US') ?? '';
  const terms = ['bracket', 'weight', 'distance', 'mile', 'zone', 'quantity', 'minimum', 'maximum', 'min', 'max', 'from', 'to'];
  return terms.reduce((score, term) => score + (new RegExp(`(^|\\W)${term}(\\W|$)`).test(header) ? 1 : 0), 0);
}

function strictlyMonotonic(values: Decimal[]): boolean {
  if (values.length < 2) return false;
  const direction = values[1]!.cmp(values[0]!);
  if (direction === 0) return false;
  return values.slice(1).every((value, index) => Math.sign(value.cmp(values[index]!)) === Math.sign(direction));
}

function looksNumeric(value: string): boolean {
  return /\d/.test(value) && /^[\s$€£¥()+\-.,%\d]+$/.test(value);
}

function parseDecimal(value: string): Decimal | null {
  let normalized = value.normalize('NFKC').trim();
  const negative = /^\(.*\)$/.test(normalized);
  if (negative) normalized = normalized.slice(1, -1);
  normalized = normalized.replace(/[$€£¥,%\s]/g, '').replace(/,/g, '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  try {
    const parsed = new Decimal(normalized);
    return parsed.isFinite() ? (negative ? parsed.negated() : parsed) : null;
  } catch {
    return null;
  }
}
