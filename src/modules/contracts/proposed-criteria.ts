import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AstNode } from '../rule-engine/ast.js';
import { stableStringify } from '../evaluator/snapshot.js';
import type { AnthropicStructuredResult, VersionedAnthropicProvider, VersionedPrompt } from './anthropic-provider.js';
import { CLAUSE_NORMALIZATION_SCHEMA_VERSION, ClauseNormalizationSchema, ExtractionCitationSchema,
  type ClauseNormalization } from './clause-normalization.js';

export const PROPOSED_CRITERIA_SCHEMA_VERSION = 'proposed-criteria/1';
export const PROPOSED_CRITERIA_PROMPT_VERSION = 'contract-proposed-criteria/1';

export const PROPOSABLE_FACT_KEYS = [
  'all_amounts_stated', 'all_currencies_stated', 'billed_linehaul', 'charge_count',
  'consistent_310_charge_currencies', 'contract_linehaul_rate', 'duplicate_invoice', 'has_fuel_category',
  'line_sum', 'linehaul_currencies_match', 'quarantined_count', 'rate_basis_arithmetic_matches',
  'shipment_reference_match', 'suspicious_missing_data_count',
] as const;

const factKeySchema = z.enum(PROPOSABLE_FACT_KEYS);
const decimalLiteral = z.number().int().safe();
const literalSchema = z.object({ type: z.literal('lit'), value: z.union([decimalLiteral, z.string().max(1_000), z.boolean()]) }).strict();
const factSchema = z.object({ type: z.literal('fact'), key: factKeySchema }).strict();

type ProposalAst =
  | z.infer<typeof literalSchema>
  | z.infer<typeof factSchema>
  | { type: 'compare'; op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; left: ProposalAst; right: ProposalAst }
  | { type: 'logic'; op: 'and' | 'or' | 'not'; args: ProposalAst[] }
  | { type: 'require'; key: z.infer<typeof factKeySchema>; then: ProposalAst };

const proposalAstSchema: z.ZodType<ProposalAst> = z.lazy(() => z.discriminatedUnion('type', [
  literalSchema,
  factSchema,
  z.object({ type: z.literal('compare'), op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']),
    left: proposalAstSchema, right: proposalAstSchema }).strict(),
  z.object({ type: z.literal('logic'), op: z.enum(['and', 'or', 'not']), args: z.array(proposalAstSchema).min(1).max(20) }).strict()
    .superRefine((node, context) => {
      if (node.op === 'not' && node.args.length !== 1) context.addIssue({ code: 'custom', path: ['args'], message: 'not requires exactly one operand' });
      if (node.op !== 'not' && node.args.length < 2) context.addIssue({ code: 'custom', path: ['args'], message: `${node.op} requires at least two operands` });
    }),
  z.object({ type: z.literal('require'), key: factKeySchema, then: proposalAstSchema }).strict(),
]));

const proposedCriterionSchema = z.object({
  criterionKey: z.string().trim().min(1).max(255).regex(/^CONTRACT\.PROPOSED\.[A-Z][A-Z0-9_]*$/),
  kind: z.literal('SCORING'),
  ruleType: z.enum(['STRUCTURAL', 'INTRA_LINE', 'CROSS_REFERENCE', 'CONTRACT_CONFORMANCE',
    'EXTERNAL_REFERENCE', 'CROSS_DOCUMENT', 'POLICY_ELIGIBILITY']),
  description: z.string().trim().min(1).max(4_000),
  clauseReferences: z.array(z.string().trim().min(1).max(300)).min(1).max(100),
  citations: z.array(ExtractionCitationSchema).min(1).max(100),
  ast: proposalAstSchema,
}).strict();

export const ProposedCriteriaModelOutputSchema = z.object({
  schemaVersion: z.literal(PROPOSED_CRITERIA_SCHEMA_VERSION),
  criteria: z.array(proposedCriterionSchema).max(1_000),
}).strict().superRefine((output, context) => {
  const keys = new Set<string>();
  for (const [index, criterion] of output.criteria.entries()) {
    if (keys.has(criterion.criterionKey)) context.addIssue({ code: 'custom', path: ['criteria', index, 'criterionKey'], message: 'duplicate criterion key' });
    keys.add(criterion.criterionKey);
    if (!isBooleanAst(criterion.ast)) context.addIssue({ code: 'custom', path: ['criteria', index, 'ast'], message: 'criterion AST must produce a boolean verdict' });
    if (astDepth(criterion.ast) > 20) context.addIssue({ code: 'custom', path: ['criteria', index, 'ast'], message: 'criterion AST exceeds maximum depth' });
  }
});

export interface ProposedCriterion extends Omit<z.infer<typeof proposedCriterionSchema>, 'ast'> {
  ast: AstNode;
  astHash: string;
  expectedInputs: string[];
  lifecycleState: 'PROPOSED';
}

export interface ProposedCriteria {
  schemaVersion: typeof PROPOSED_CRITERIA_SCHEMA_VERSION;
  criteria: ProposedCriterion[];
}

export const PROPOSED_CRITERIA_PROMPT: VersionedPrompt = {
  version: PROPOSED_CRITERIA_PROMPT_VERSION,
  system: [
    'Generate human-reviewable SCORING criterion proposals from normalized, cited freight-contract clauses.',
    'Use only the supplied allowlisted resolved fact keys and the provided declarative predicate schema.',
    'Never emit arithmetic nodes, money literals, executable code, database queries, lifecycle transitions, or activation instructions.',
    'Do not calculate expected charges, totals, rates, or variances. The deterministic owned interpreter alone evaluates proposed ASTs.',
    'Every proposal must cite its source clauses. Omit a criterion when the available facts cannot represent it safely.',
  ].join(' '),
};

export async function generateProposedCriteria(
  provider: VersionedAnthropicProvider,
  sourceDocumentSha256: string,
  normalization: ClauseNormalization,
): Promise<AnthropicStructuredResult<ProposedCriteria>> {
  const verified = ClauseNormalizationSchema.parse(normalization);
  if (!verified.clauses.some((clause) => clause.status === 'NORMALIZED')) {
    throw new ProposedCriteriaError('NO_NORMALIZED_CLAUSES', 'no normalized clauses are available for proposals');
  }
  const providerResult = await provider.generateStructured({ prompt: PROPOSED_CRITERIA_PROMPT,
    outputSchema: ProposedCriteriaModelOutputSchema, sourceDocumentSha256,
    untrustedEvidence: JSON.stringify({ schemaVersion: CLAUSE_NORMALIZATION_SCHEMA_VERSION,
      availableFacts: PROPOSABLE_FACT_KEYS, clauses: verified.clauses }) });
  assertProposalGrounding(providerResult.output, verified);
  const criteria = providerResult.output.criteria.map((criterion): ProposedCriterion => {
    const ast = canonicalizeAst(criterion.ast);
    return { ...criterion, ast, astHash: createHash('sha256').update(stableStringify(ast)).digest('hex'),
      expectedInputs: [...collectFactKeys(ast)].sort(), lifecycleState: 'PROPOSED' };
  }).sort((left, right) => left.criterionKey.localeCompare(right.criterionKey));
  return { ...providerResult, output: { schemaVersion: PROPOSED_CRITERIA_SCHEMA_VERSION, criteria } };
}

export class ProposedCriteriaError extends Error {
  constructor(readonly code: 'NO_NORMALIZED_CLAUSES' | 'UNGROUNDED_PROPOSAL', message: string) {
    super(message); this.name = 'ProposedCriteriaError';
  }
}

function assertProposalGrounding(output: z.infer<typeof ProposedCriteriaModelOutputSchema>, normalization: ClauseNormalization): void {
  const normalized = normalization.clauses.filter((clause) => clause.status === 'NORMALIZED');
  const byReference = new Map(normalized.map((clause) => [canonicalReference(clause.clauseReference), clause]));
  for (const criterion of output.criteria) {
    const sourceClauses = criterion.clauseReferences.map((reference) => byReference.get(canonicalReference(reference)));
    if (sourceClauses.some((clause) => clause === undefined)) {
      throw new ProposedCriteriaError('UNGROUNDED_PROPOSAL', `${criterion.criterionKey} references an unknown or abstained clause`);
    }
    const allowedCitations = new Set(sourceClauses.flatMap((clause) => clause!.citations).map(citationKey));
    if (criterion.citations.some((citation) => !allowedCitations.has(citationKey(citation)))) {
      throw new ProposedCriteriaError('UNGROUNDED_PROPOSAL', `${criterion.criterionKey} contains an unknown citation`);
    }
  }
}

function canonicalReference(value: string): string { return value.normalize('NFKC').toLowerCase(); }
function citationKey(citation: z.infer<typeof ExtractionCitationSchema>): string {
  return JSON.stringify([citation.pageNumber, citation.excerpt, citation.boundingBox ?? null,
    citation.span ? [citation.span.offset, citation.span.length] : null]);
}

function isBooleanAst(ast: ProposalAst): boolean {
  if (ast.type === 'compare' || ast.type === 'logic') return true;
  if (ast.type === 'require') return isBooleanAst(ast.then);
  return false;
}

function astDepth(ast: ProposalAst): number {
  if (ast.type === 'compare') return 1 + Math.max(astDepth(ast.left), astDepth(ast.right));
  if (ast.type === 'logic') return 1 + Math.max(...ast.args.map(astDepth));
  if (ast.type === 'require') return 1 + astDepth(ast.then);
  return 1;
}

function canonicalizeAst(ast: ProposalAst): AstNode {
  if (ast.type === 'compare') return { ...ast, left: canonicalizeAst(ast.left), right: canonicalizeAst(ast.right) };
  if (ast.type === 'require') return { ...ast, then: canonicalizeAst(ast.then) };
  if (ast.type === 'logic') {
    const args = ast.args.map(canonicalizeAst);
    if (ast.op !== 'not') args.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
    return { ...ast, args };
  }
  return ast;
}

function collectFactKeys(ast: AstNode, keys = new Set<string>()): Set<string> {
  if (ast.type === 'fact') keys.add(ast.key);
  else if (ast.type === 'require') { keys.add(ast.key); collectFactKeys(ast.then, keys); }
  else if (ast.type === 'compare') { collectFactKeys(ast.left, keys); collectFactKeys(ast.right, keys); }
  else if (ast.type === 'logic' || ast.type === 'arith') ast.args.forEach((arg) => collectFactKeys(arg, keys));
  return keys;
}
