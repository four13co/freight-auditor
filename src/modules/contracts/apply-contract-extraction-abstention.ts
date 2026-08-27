import { z } from 'zod';
import {
  ContractExtractionSchema, ExtractedContractValueSchema, type ContractExtraction,
} from './contract-extraction-schema.js';

const semanticType = z.enum(['TEXT', 'DATE', 'DECIMAL', 'PERCENTAGE', 'CURRENCY', 'DURATION', 'IDENTIFIER']);
export const ContractExtractionAbstentionPolicySchema = z.object({
  version: z.string().trim().min(1).max(200),
  minimumConfidence: z.number().finite().min(0).max(1),
  requiredFields: z.array(z.object({
    path: z.string().trim().min(1).max(500), semanticType,
    clarificationQuestion: z.string().trim().min(1).max(2_000),
  }).strict()).max(10_000),
}).strict().superRefine((policy, context) => {
  const seen = new Set<string>();
  for (const [index, field] of policy.requiredFields.entries()) {
    if (seen.has(field.path)) context.addIssue({ code: 'custom', path: ['requiredFields', index, 'path'], message: 'duplicate required field path' });
    seen.add(field.path);
  }
});

export type ContractExtractionAbstentionPolicy = z.infer<typeof ContractExtractionAbstentionPolicySchema>;
type ExtractedValue = z.infer<typeof ExtractedContractValueSchema>;
export interface ContractExtractionAbstention {
  path: string;
  status: 'NOT_FOUND' | 'AMBIGUOUS';
  reason: 'MISSING_REQUIRED_FIELD' | 'LOW_CONFIDENCE' | 'MODEL_ABSTENTION' | 'AMBIGUOUS_TABLE_ORIENTATION';
  clarificationQuestion: string;
}
export interface AbstentionPolicyResult {
  extraction: ContractExtraction;
  policyVersion: string;
  abstentions: ContractExtractionAbstention[];
}

/** Applies fail-safe abstention without inventing or normalizing any source value. */
export function applyContractExtractionAbstention(
  untrustedExtraction: unknown,
  untrustedPolicy: ContractExtractionAbstentionPolicy,
): AbstentionPolicyResult {
  const extraction = ContractExtractionSchema.parse(untrustedExtraction);
  const policy = ContractExtractionAbstentionPolicySchema.parse(untrustedPolicy);
  const abstentions: ContractExtractionAbstention[] = [];
  const required = new Map(policy.requiredFields.map((field) => [field.path, field]));

  for (const field of extraction.fields) {
    field.value = applyToValue(field.value, field.path, policy.minimumConfidence,
      required.get(field.path)?.clarificationQuestion, abstentions);
  }
  for (const requirement of policy.requiredFields) {
    if (extraction.fields.some((field) => field.path === requirement.path)) continue;
    fieldPathSchema.parse(requirement.path);
    extraction.fields.push({ path: requirement.path, semanticType: requirement.semanticType, value: {
      status: 'NOT_FOUND', rawText: null, normalizedValue: null, confidence: 0, citations: [],
      clarificationQuestion: requirement.clarificationQuestion,
    } });
    abstentions.push({ path: requirement.path, status: 'NOT_FOUND', reason: 'MISSING_REQUIRED_FIELD',
      clarificationQuestion: requirement.clarificationQuestion });
  }
  extraction.fields.sort((left, right) => left.path.localeCompare(right.path));

  for (const clause of extraction.clauses) {
    const path = `clauses[${JSON.stringify(clause.clauseReference)}].text`;
    clause.text = applyToValue(clause.text, path, policy.minimumConfidence, undefined, abstentions);
  }
  for (const table of extraction.rateTables) {
    const base = `rateTables[${JSON.stringify(table.tableKey)}]`;
    table.title = applyToValue(table.title, `${base}.title`, policy.minimumConfidence, undefined, abstentions);
    for (const cell of table.cells) cell.value = applyToValue(cell.value,
      `${base}.cells[${cell.rowIndex},${cell.columnIndex}]`, policy.minimumConfidence, undefined, abstentions);
    if (table.orientation === 'AMBIGUOUS') {
      const question = `Is ${table.tableKey} organized with brackets in rows or columns?`;
      abstentions.push({ path: `${base}.orientation`, status: 'AMBIGUOUS', reason: 'AMBIGUOUS_TABLE_ORIENTATION',
        clarificationQuestion: question });
    }
  }

  const validated = ContractExtractionSchema.parse(extraction);
  abstentions.sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
  return { extraction: validated, policyVersion: policy.version, abstentions };
}

const fieldPathSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]*(?:\[(?:\d+|[a-zA-Z0-9_-]+)\]|\.[a-z][a-zA-Z0-9_]*)*$/);

function applyToValue(
  value: ExtractedValue,
  path: string,
  minimumConfidence: number,
  preferredQuestion: string | undefined,
  abstentions: ContractExtractionAbstention[],
): ExtractedValue {
  if (value.status !== 'FOUND') {
    abstentions.push({ path, status: value.status, reason: 'MODEL_ABSTENTION', clarificationQuestion: value.clarificationQuestion });
    return value;
  }
  if (value.confidence >= minimumConfidence) return value;
  const question = preferredQuestion ?? `Please verify ${path} against the cited contract source.`;
  abstentions.push({ path, status: 'AMBIGUOUS', reason: 'LOW_CONFIDENCE', clarificationQuestion: question });
  return { status: 'AMBIGUOUS', rawText: value.rawText, normalizedValue: null, confidence: value.confidence,
    citations: value.citations, clarificationQuestion: question };
}
