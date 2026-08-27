import { z } from 'zod';
import { ContractExtractionSchema, ExtractionCitationSchema, type ContractExtraction } from './contract-extraction-schema.js';
export { ExtractionCitationSchema } from './contract-extraction-schema.js';
import type { AnthropicStructuredResult, VersionedAnthropicProvider, VersionedPrompt } from './anthropic-provider.js';

export const CLAUSE_NORMALIZATION_SCHEMA_VERSION = 'clause-normalization/1';
export const CLAUSE_NORMALIZATION_PROMPT_VERSION = 'contract-clause-normalization/1';

const semanticTermSchema = z.object({
  key: z.string().trim().min(1).max(200).regex(/^[a-z][a-z0-9_]*$/),
  semanticType: z.enum(['TEXT', 'DATE', 'DECIMAL', 'PERCENTAGE', 'CURRENCY', 'DURATION', 'IDENTIFIER']),
  /** Source-stated value only. It is deliberately text, never authoritative arithmetic. */
  sourceValue: z.string().trim().min(1).max(20_000),
  unit: z.string().trim().min(1).max(100).nullable(),
  citations: z.array(ExtractionCitationSchema).min(1).max(20),
}).strict();

const normalizedClauseSchema = z.object({
  status: z.literal('NORMALIZED'),
  clauseReference: z.string().trim().min(1).max(300),
  category: z.enum(['RATE', 'ACCESSORIAL', 'PAYMENT', 'SERVICE', 'LIABILITY', 'TERM', 'AMENDMENT', 'OTHER']),
  title: z.string().trim().min(1).max(1_000).nullable(),
  summary: z.string().trim().min(1).max(4_000),
  applicability: z.array(z.string().trim().min(1).max(1_000)).max(100),
  terms: z.array(semanticTermSchema).max(500),
  citations: z.array(ExtractionCitationSchema).min(1).max(20),
}).strict();

const abstainedClauseSchema = z.object({
  status: z.literal('ABSTAINED'),
  clauseReference: z.string().trim().min(1).max(300),
  reason: z.enum(['MISSING_TEXT', 'AMBIGUOUS_MEANING', 'CONFLICTING_TERMS', 'INSUFFICIENT_CITATION']),
  clarificationQuestion: z.string().trim().min(1).max(2_000),
  citations: z.array(ExtractionCitationSchema).max(20),
}).strict();

export const ClauseNormalizationSchema = z.object({
  schemaVersion: z.literal(CLAUSE_NORMALIZATION_SCHEMA_VERSION),
  clauses: z.array(z.discriminatedUnion('status', [normalizedClauseSchema, abstainedClauseSchema])).max(10_000),
}).strict().superRefine((output, context) => {
  const seen = new Set<string>();
  for (const [index, clause] of output.clauses.entries()) {
    const reference = clause.clauseReference.normalize('NFKC').toLowerCase();
    if (seen.has(reference)) context.addIssue({ code: 'custom', path: ['clauses', index, 'clauseReference'], message: 'duplicate clause reference' });
    seen.add(reference);
    if (clause.status === 'NORMALIZED') {
      const termKeys = new Set<string>();
      for (const [termIndex, term] of clause.terms.entries()) {
        if (termKeys.has(term.key)) context.addIssue({ code: 'custom', path: ['clauses', index, 'terms', termIndex, 'key'], message: 'duplicate semantic term key' });
        termKeys.add(term.key);
      }
    }
  }
});

export type ClauseNormalization = z.infer<typeof ClauseNormalizationSchema>;

export const CLAUSE_NORMALIZATION_PROMPT: VersionedPrompt = {
  version: CLAUSE_NORMALIZATION_PROMPT_VERSION,
  system: [
    'Normalize already-extracted freight-contract clauses into semantic, human-reviewable proposals.',
    'Preserve clause references and source-stated terms. Every normalized clause and term must include precise source citations.',
    'Do not invent missing terms. If meaning or evidence is incomplete, abstain and ask one actionable clarification question.',
    'Do not produce rule ASTs, criterion lifecycle state, expected charges, variance amounts, totals, or authoritative calculations.',
    'Numeric and monetary language may only be copied as sourceValue text with its stated unit and citation.',
  ].join(' '),
};

export async function normalizeContractClauses(
  provider: VersionedAnthropicProvider,
  extraction: ContractExtraction,
): Promise<AnthropicStructuredResult<ClauseNormalization>> {
  const verified = ContractExtractionSchema.parse(extraction);
  if (!verified.clauses.length) throw new ClauseNormalizationError('NO_CLAUSES', 'verified extraction contains no clauses');
  const evidence = verified.clauses.map((clause) => ({ clauseReference: clause.clauseReference,
    title: clause.title, text: clause.text }));
  const result = await provider.generateStructured({ prompt: CLAUSE_NORMALIZATION_PROMPT, outputSchema: ClauseNormalizationSchema,
    sourceDocumentSha256: verified.sourceDocumentSha256, untrustedEvidence: JSON.stringify(evidence) });
  assertGrounded(result.output, verified);
  return result;
}

export class ClauseNormalizationError extends Error {
  constructor(readonly code: 'NO_CLAUSES' | 'UNGROUNDED_OUTPUT', message: string) { super(message); this.name = 'ClauseNormalizationError'; }
}

function assertGrounded(output: ClauseNormalization, extraction: ContractExtraction): void {
  const sourceByReference = new Map(extraction.clauses.map((clause) => [clause.clauseReference.normalize('NFKC').toLowerCase(), clause]));
  const outputReferences = new Set(output.clauses.map((clause) => clause.clauseReference.normalize('NFKC').toLowerCase()));
  if (outputReferences.size !== sourceByReference.size || [...sourceByReference.keys()].some((reference) => !outputReferences.has(reference))) {
    throw new ClauseNormalizationError('UNGROUNDED_OUTPUT', 'normalized clauses must correspond one-to-one with verified clauses');
  }
  for (const clause of output.clauses) {
    const source = sourceByReference.get(clause.clauseReference.normalize('NFKC').toLowerCase())!;
    const allowed = new Set(source.text.citations.map(citationKey));
    const citations = clause.status === 'NORMALIZED'
      ? [...clause.citations, ...clause.terms.flatMap((term) => term.citations)] : clause.citations;
    if (citations.some((citation) => !allowed.has(citationKey(citation)))) {
      throw new ClauseNormalizationError('UNGROUNDED_OUTPUT', `normalized clause ${clause.clauseReference} contains an unknown citation`);
    }
  }
}

function citationKey(citation: z.infer<typeof ExtractionCitationSchema>): string {
  return JSON.stringify([citation.pageNumber, citation.excerpt, citation.boundingBox ?? null,
    citation.span ? [citation.span.offset, citation.span.length] : null]);
}
