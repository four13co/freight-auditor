import { z } from 'zod';

export const CONTRACT_EXTRACTION_SCHEMA_VERSION = 'contract-extraction/1';

const finiteCoordinate = z.number().finite().nonnegative();
export const ExtractionCitationSchema = z.object({
  pageNumber: z.number().int().positive(),
  excerpt: z.string().trim().min(1).max(4_000),
  boundingBox: z.array(finiteCoordinate).min(8).max(32).optional(),
  span: z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive() }).strict().optional(),
}).strict().refine((citation) => citation.boundingBox !== undefined || citation.span !== undefined, {
  message: 'citation must include a boundingBox or source span',
});

const confidence = z.number().finite().min(0).max(1);
const foundValueSchema = z.object({
  status: z.literal('FOUND'),
  rawText: z.string().trim().min(1).max(20_000),
  normalizedValue: z.string().trim().min(1).max(20_000).nullable(),
  confidence,
  citations: z.array(ExtractionCitationSchema).min(1).max(20),
}).strict();
const abstainedValueSchema = z.object({
  status: z.enum(['NOT_FOUND', 'AMBIGUOUS']),
  rawText: z.string().trim().min(1).max(20_000).nullable(),
  normalizedValue: z.null(),
  confidence,
  citations: z.array(ExtractionCitationSchema).max(20),
  clarificationQuestion: z.string().trim().min(1).max(2_000),
}).strict();

/** Every extracted value is either source-grounded or an explicit, actionable abstention. */
export const ExtractedContractValueSchema = z.discriminatedUnion('status', [foundValueSchema, abstainedValueSchema]);

export const ContractExtractionFieldSchema = z.object({
  path: z.string().trim().min(1).max(500).regex(/^[a-z][a-zA-Z0-9_]*(?:\[(?:\d+|[a-zA-Z0-9_-]+)\]|\.[a-z][a-zA-Z0-9_]*)*$/),
  semanticType: z.enum(['TEXT', 'DATE', 'DECIMAL', 'PERCENTAGE', 'CURRENCY', 'DURATION', 'IDENTIFIER']),
  value: ExtractedContractValueSchema,
}).strict();

export const ExtractedContractClauseSchema = z.object({
  clauseReference: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(1_000).nullable(),
  text: ExtractedContractValueSchema,
}).strict();

export const ExtractedRateTableCellSchema = z.object({
  rowIndex: z.number().int().nonnegative(),
  columnIndex: z.number().int().nonnegative(),
  rowSpan: z.number().int().positive().max(10_000),
  columnSpan: z.number().int().positive().max(10_000),
  role: z.enum(['COLUMN_HEADER', 'ROW_HEADER', 'VALUE']),
  value: ExtractedContractValueSchema,
}).strict();

export const ExtractedRateTableSchema = z.object({
  tableKey: z.string().trim().min(1).max(300).regex(/^[a-z][a-z0-9_-]*$/),
  title: ExtractedContractValueSchema,
  orientation: z.enum(['ROW_BRACKETS', 'COLUMN_BRACKETS', 'AMBIGUOUS']),
  rowCount: z.number().int().positive().max(100_000),
  columnCount: z.number().int().positive().max(10_000),
  cells: z.array(ExtractedRateTableCellSchema).max(250_000),
}).strict().superRefine((table, context) => {
  const occupied = new Set<string>();
  for (const [index, cell] of table.cells.entries()) {
    if (cell.rowIndex + cell.rowSpan > table.rowCount || cell.columnIndex + cell.columnSpan > table.columnCount) {
      context.addIssue({ code: 'custom', path: ['cells', index], message: 'cell span exceeds declared table bounds' });
      continue;
    }
    for (let row = cell.rowIndex; row < cell.rowIndex + cell.rowSpan; row += 1) {
      for (let column = cell.columnIndex; column < cell.columnIndex + cell.columnSpan; column += 1) {
        const coordinate = `${row}:${column}`;
        if (occupied.has(coordinate)) context.addIssue({ code: 'custom', path: ['cells', index], message: `cell overlaps coordinate ${coordinate}` });
        occupied.add(coordinate);
      }
    }
  }
});

const modelPinSchema = z.object({
  provider: z.literal('anthropic'),
  modelId: z.string().trim().min(1).max(200),
  promptVersion: z.string().trim().min(1).max(200),
}).strict();

/**
 * Provider-output envelope for contract extraction. It deliberately has no rule AST,
 * lifecycle state, expected charge, or calculated amount fields: extraction may report
 * source text, but cannot activate rules or authoritatively calculate money.
 */
export const ContractExtractionSchema = z.object({
  schemaVersion: z.literal(CONTRACT_EXTRACTION_SCHEMA_VERSION),
  sourceDocumentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  model: modelPinSchema,
  fields: z.array(ContractExtractionFieldSchema).max(10_000),
  clauses: z.array(ExtractedContractClauseSchema).max(10_000),
  rateTables: z.array(ExtractedRateTableSchema).max(1_000),
}).strict().superRefine((extraction, context) => {
  rejectDuplicates(extraction.fields.map((field) => field.path), 'fields', 'field path', context);
  rejectDuplicates(extraction.clauses.map((clause) => clause.clauseReference), 'clauses', 'clause reference', context);
  rejectDuplicates(extraction.rateTables.map((table) => table.tableKey), 'rateTables', 'table key', context);
});

export type ContractExtraction = z.infer<typeof ContractExtractionSchema>;
export const ContractExtractionJsonSchema = z.toJSONSchema(ContractExtractionSchema, { target: 'draft-07' });

export function parseContractExtraction(untrustedOutput: unknown): ContractExtraction {
  return ContractExtractionSchema.parse(untrustedOutput);
}

function rejectDuplicates(values: string[], path: string, label: string, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const canonical = value.normalize('NFKC').toLocaleLowerCase('en-US');
    if (seen.has(canonical)) context.addIssue({ code: 'custom', path: [path, index], message: `duplicate ${label}: ${value}` });
    seen.add(canonical);
  }
}
