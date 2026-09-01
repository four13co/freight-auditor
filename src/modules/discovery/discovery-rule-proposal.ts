import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { AstNode } from '../rule-engine/ast.js';
import { stableStringify } from '../evaluator/snapshot.js';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import type { AnthropicStructuredResult, VersionedAnthropicProvider, VersionedPrompt } from '../contracts/anthropic-provider.js';
import { PROPOSABLE_FACT_KEYS } from '../contracts/proposed-criteria.js';
import { rejectModelMoneyAuthority } from '../contracts/model-money-authority-gate.js';

/**
 * P3.D.6: generate SCORING criterion proposals from P3.D discovery-trigger
 * evidence (unassessable results, unknown charge codes, suspicious passes)
 * without ever activating them. Deliberately parallel to
 * `proposed-criteria.ts` (P3.C's contract-extraction proposal pipeline) but
 * kept as a separate module -- the two pipelines are grounded in different
 * evidence shapes (document clauses vs. audit-run discovery triggers) and
 * this codebase's own convention (0054/0059's own comments) is an additive
 * new surface over widening an existing one to fit an unrelated source.
 *
 * Reuses PROPOSABLE_FACT_KEYS: discovery proposals are evaluated by the
 * same interpreter over the same fact bundle as contract proposals, so the
 * allowed-fact vocabulary is genuinely shared, not merely similar.
 */

export const DISCOVERY_RULE_PROPOSAL_SCHEMA_VERSION = 'discovery-rule-proposal/1';
export const DISCOVERY_RULE_PROPOSAL_PROMPT_VERSION = 'discovery-rule-proposal/1';

export const DISCOVERY_TRIGGER_KINDS = ['UNASSESSABLE_RESULT', 'UNKNOWN_CHARGE_CODE', 'SUSPICIOUS_PASS'] as const;
export type DiscoveryTriggerKind = (typeof DISCOVERY_TRIGGER_KINDS)[number];

export interface DiscoveryEvidenceItem {
  triggerKind: DiscoveryTriggerKind;
  triggerId: string;
  detail: unknown;
}

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

const RULE_TYPES = ['STRUCTURAL', 'INTRA_LINE', 'CROSS_REFERENCE', 'CONTRACT_CONFORMANCE',
  'EXTERNAL_REFERENCE', 'CROSS_DOCUMENT', 'POLICY_ELIGIBILITY'] as const;

const discoveryProposedCriterionSchema = z.object({
  criterionKey: z.string().trim().min(1).max(255).regex(/^DISCOVERY\.PROPOSED\.[A-Z][A-Z0-9_]*$/),
  kind: z.literal('SCORING'),
  ruleType: z.enum(RULE_TYPES),
  description: z.string().trim().min(1).max(4_000),
  citedTriggerId: z.uuid(),
  ast: proposalAstSchema,
}).strict();

export const DiscoveryProposedCriteriaModelOutputSchema = z.object({
  schemaVersion: z.literal(DISCOVERY_RULE_PROPOSAL_SCHEMA_VERSION),
  criteria: z.array(discoveryProposedCriterionSchema).max(1_000),
}).strict().superRefine((output, context) => {
  const keys = new Set<string>();
  for (const [index, criterion] of output.criteria.entries()) {
    if (keys.has(criterion.criterionKey)) context.addIssue({ code: 'custom', path: ['criteria', index, 'criterionKey'], message: 'duplicate criterion key' });
    keys.add(criterion.criterionKey);
    if (!isBooleanAst(criterion.ast)) context.addIssue({ code: 'custom', path: ['criteria', index, 'ast'], message: 'criterion AST must produce a boolean verdict' });
    if (astDepth(criterion.ast) > 20) context.addIssue({ code: 'custom', path: ['criteria', index, 'ast'], message: 'criterion AST exceeds maximum depth' });
  }
});

/** Retains suspicious model fields long enough for the money-authority gate to classify them before strict parsing. */
export const DiscoveryProposedCriteriaProviderEnvelopeSchema = z.object({
  schemaVersion: z.literal(DISCOVERY_RULE_PROPOSAL_SCHEMA_VERSION),
  criteria: z.array(z.object({
    criterionKey: z.string().trim().min(1).max(255),
    kind: z.string(),
    ruleType: z.string(),
    description: z.string(),
    citedTriggerId: z.string(),
    ast: z.unknown(),
  }).passthrough()).max(1_000),
}).passthrough();

export interface DiscoveryProposedCriterion extends Omit<z.infer<typeof discoveryProposedCriterionSchema>, 'ast'> {
  ast: AstNode;
  astHash: string;
  expectedInputs: string[];
  lifecycleState: 'PROPOSED';
}

export interface DiscoveryProposedCriteria {
  schemaVersion: typeof DISCOVERY_RULE_PROPOSAL_SCHEMA_VERSION;
  criteria: DiscoveryProposedCriterion[];
}

export const DiscoveryProposedCriteriaSchema = z.object({
  schemaVersion: z.literal(DISCOVERY_RULE_PROPOSAL_SCHEMA_VERSION),
  criteria: z.array(discoveryProposedCriterionSchema.extend({
    astHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedInputs: z.array(factKeySchema).max(PROPOSABLE_FACT_KEYS.length),
    lifecycleState: z.literal('PROPOSED'),
  }).strict()).max(1_000),
}).strict();

export const DISCOVERY_RULE_PROPOSAL_PROMPT: VersionedPrompt = {
  version: DISCOVERY_RULE_PROPOSAL_PROMPT_VERSION,
  system: [
    'Generate human-reviewable SCORING criterion proposals from audit-run discovery-trigger evidence',
    '(unassessable results, unknown charge codes, and suspicious structural passes).',
    'Use only the supplied allowlisted resolved fact keys and the provided declarative predicate schema.',
    'Never emit arithmetic nodes, money literals, executable code, database queries, lifecycle transitions, or activation instructions.',
    'Do not calculate expected charges, totals, rates, or variances. The deterministic owned interpreter alone evaluates proposed ASTs.',
    'Every proposal must cite exactly the discovery trigger id it is grounded in. Omit a criterion when the available facts cannot represent it safely.',
  ].join(' '),
};

export class DiscoveryRuleProposalError extends Error {
  constructor(readonly code: 'NO_EVIDENCE' | 'AUDIT_RUN_NOT_FOUND' | 'AST_HASH_MISMATCH' |
    'EXPECTED_INPUTS_MISMATCH' | 'TRIGGER_NOT_FOUND' | 'PARTIAL_CONFLICT') {
    super(code.toLowerCase().replace(/_/g, ' ')); this.name = 'DiscoveryRuleProposalError';
  }
}

export type DiscoveryProposalCitationRejectionCode = 'MISSING_CITATION' | 'UNKNOWN_TRIGGER';

export interface DiscoveryProposalCitationRejection {
  criterionKey: string;
  code: DiscoveryProposalCitationRejectionCode;
  triggerId: string | null;
}

export interface DiscoveryProposalCitationGateResult {
  accepted: boolean;
  rejections: DiscoveryProposalCitationRejection[];
}

/** Pure fail-closed gate: every proposed criterion must cite a real, supplied discovery trigger. */
export function validateDiscoveryProposalCitations(
  candidate: { criteria: Array<{ criterionKey: string; citedTriggerId: string }> },
  evidence: readonly DiscoveryEvidenceItem[],
): DiscoveryProposalCitationGateResult {
  const known = new Set(evidence.map((item) => item.triggerId));
  const rejections: DiscoveryProposalCitationRejection[] = [];
  for (const criterion of [...candidate.criteria].sort((left, right) => left.criterionKey.localeCompare(right.criterionKey))) {
    if (!criterion.citedTriggerId) { rejections.push({ criterionKey: criterion.criterionKey, code: 'MISSING_CITATION', triggerId: null }); continue; }
    if (!known.has(criterion.citedTriggerId)) rejections.push({ criterionKey: criterion.criterionKey, code: 'UNKNOWN_TRIGGER', triggerId: criterion.citedTriggerId });
  }
  return { accepted: rejections.length === 0, rejections };
}

export class DiscoveryProposalCitationError extends Error {
  readonly code = 'UNCITED_DISCOVERY_PROPOSAL';
  constructor(readonly rejections: DiscoveryProposalCitationRejection[]) {
    super('one or more proposed criteria lack a grounding discovery-trigger citation'); this.name = 'DiscoveryProposalCitationError';
  }
}

export function requireDiscoveryProposalCitations(
  candidate: { criteria: Array<{ criterionKey: string; citedTriggerId: string }> },
  evidence: readonly DiscoveryEvidenceItem[],
): void {
  const result = validateDiscoveryProposalCitations(candidate, evidence);
  if (!result.accepted) throw new DiscoveryProposalCitationError(result.rejections);
}

export async function generateDiscoveryRuleProposals(
  provider: VersionedAnthropicProvider,
  auditRunId: string,
  evidence: readonly DiscoveryEvidenceItem[],
): Promise<AnthropicStructuredResult<DiscoveryProposedCriteria>> {
  if (!evidence.length) throw new DiscoveryRuleProposalError('NO_EVIDENCE');
  const sorted = [...evidence].sort((left, right) => left.triggerId.localeCompare(right.triggerId));
  const evidenceHash = createHash('sha256').update(stableStringify({ auditRunId, evidence: sorted })).digest('hex');
  const providerResult = await provider.generateStructured({ prompt: DISCOVERY_RULE_PROPOSAL_PROMPT,
    outputSchema: DiscoveryProposedCriteriaProviderEnvelopeSchema, sourceDocumentSha256: evidenceHash,
    untrustedEvidence: JSON.stringify({ schemaVersion: DISCOVERY_RULE_PROPOSAL_SCHEMA_VERSION,
      availableFacts: PROPOSABLE_FACT_KEYS, auditRunId, evidence: sorted }) });
  rejectModelMoneyAuthority(providerResult.output);
  const safeOutput = DiscoveryProposedCriteriaModelOutputSchema.parse(providerResult.output);
  requireDiscoveryProposalCitations(safeOutput, sorted);
  const criteria = safeOutput.criteria.map((criterion): DiscoveryProposedCriterion => {
    const ast = canonicalizeAst(criterion.ast);
    return { ...criterion, ast, astHash: createHash('sha256').update(stableStringify(ast)).digest('hex'),
      expectedInputs: [...collectFactKeys(ast)].sort(), lifecycleState: 'PROPOSED' };
  }).sort((left, right) => left.criterionKey.localeCompare(right.criterionKey));
  return { ...providerResult, output: { schemaVersion: DISCOVERY_RULE_PROPOSAL_SCHEMA_VERSION, criteria } };
}

const listInputSchema = z.object({ clientId: z.uuid(), auditRunId: z.uuid() }).strict();

/** Evidence not yet cited by any persisted proposal -- makes a re-run after a partial failure resumable without re-proposing settled triggers. */
export async function listDiscoveryEvidence(client: pg.PoolClient, untrusted: z.input<typeof listInputSchema>): Promise<DiscoveryEvidenceItem[]> {
  const input = listInputSchema.parse(untrusted);
  const rows = (await client.query<{ trigger_kind: DiscoveryTriggerKind; trigger_id: string; detail: unknown }>(`
    SELECT 'UNASSESSABLE_RESULT' AS trigger_kind, dt.id AS trigger_id, dt.detail FROM discovery_trigger dt
      WHERE dt.client_id=$1 AND dt.audit_run_id=$2
        AND NOT EXISTS (SELECT 1 FROM discovery_rule_proposal p WHERE p.client_id=dt.client_id AND p.discovery_trigger_id=dt.id)
    UNION ALL
    SELECT 'UNKNOWN_CHARGE_CODE', ct.id, ct.detail FROM unknown_charge_code_trigger ct
      WHERE ct.client_id=$1 AND ct.audit_run_id=$2
        AND NOT EXISTS (SELECT 1 FROM discovery_rule_proposal p WHERE p.client_id=ct.client_id AND p.unknown_charge_code_trigger_id=ct.id)
    UNION ALL
    SELECT 'SUSPICIOUS_PASS', sp.id, sp.detail FROM suspicious_pass_trigger sp
      WHERE sp.client_id=$1 AND sp.audit_run_id=$2
        AND NOT EXISTS (SELECT 1 FROM discovery_rule_proposal p WHERE p.client_id=sp.client_id AND p.suspicious_pass_trigger_id=sp.id)
    ORDER BY trigger_kind, trigger_id`, [input.clientId, input.auditRunId])).rows;
  return rows.map((row) => ({ triggerKind: row.trigger_kind, triggerId: row.trigger_id, detail: row.detail }));
}

const persistInputSchema = z.object({
  clientId: z.uuid(), auditRunId: z.uuid(), actorUserId: z.uuid().nullable().default(null),
  result: z.object({
    output: DiscoveryProposedCriteriaSchema,
    provider: z.literal('anthropic'), modelId: z.string().trim().min(1).max(200),
    promptVersion: z.literal(DISCOVERY_RULE_PROPOSAL_PROMPT_VERSION),
    requestKey: z.string().regex(/^[a-f0-9]{64}$/), providerMessageId: z.string().trim().min(1).max(500),
    usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict(),
  }).strict(),
}).strict();

interface ResolvedTrigger { column: 'discovery_trigger_id' | 'unknown_charge_code_trigger_id' | 'suspicious_pass_trigger_id'; }

async function resolveTrigger(client: pg.PoolClient, clientId: string, auditRunId: string, triggerId: string): Promise<ResolvedTrigger | null> {
  const discovery = await client.query(`SELECT 1 FROM discovery_trigger WHERE client_id=$1 AND audit_run_id=$2 AND id=$3`, [clientId, auditRunId, triggerId]);
  if (discovery.rowCount) return { column: 'discovery_trigger_id' };
  const unknownCode = await client.query(`SELECT 1 FROM unknown_charge_code_trigger WHERE client_id=$1 AND audit_run_id=$2 AND id=$3`, [clientId, auditRunId, triggerId]);
  if (unknownCode.rowCount) return { column: 'unknown_charge_code_trigger_id' };
  const suspiciousPass = await client.query(`SELECT 1 FROM suspicious_pass_trigger WHERE client_id=$1 AND audit_run_id=$2 AND id=$3`, [clientId, auditRunId, triggerId]);
  if (suspiciousPass.rowCount) return { column: 'suspicious_pass_trigger_id' };
  return null;
}

export async function persistDiscoveryRuleProposals(client: pg.PoolClient, untrusted: z.input<typeof persistInputSchema>): Promise<{
  proposalIds: string[]; proposalCount: number; createdCount: number;
}> {
  const input = persistInputSchema.parse(untrusted);
  const run = (await client.query(`SELECT 1 FROM audit_run WHERE client_id=$1 AND id=$2`, [input.clientId, input.auditRunId])).rowCount;
  if (!run) throw new DiscoveryRuleProposalError('AUDIT_RUN_NOT_FOUND');

  const proposalIds: string[] = []; let createdCount = 0;
  for (const criterion of input.result.output.criteria) {
    const astHash = createHash('sha256').update(stableStringify(criterion.ast)).digest('hex');
    if (astHash !== criterion.astHash) throw new DiscoveryRuleProposalError('AST_HASH_MISMATCH');
    const expectedInputs = [...collectFacts(criterion.ast)].sort();
    if (stableStringify(expectedInputs) !== stableStringify(criterion.expectedInputs)) throw new DiscoveryRuleProposalError('EXPECTED_INPUTS_MISMATCH');

    const resolved = await resolveTrigger(client, input.clientId, input.auditRunId, criterion.citedTriggerId);
    if (!resolved) throw new DiscoveryRuleProposalError('TRIGGER_NOT_FOUND');

    const proposalHash = createHash('sha256').update(stableStringify({ auditRunId: input.auditRunId, criterion,
      provider: input.result.provider, modelId: input.result.modelId, promptVersion: input.result.promptVersion,
      providerMessageId: input.result.providerMessageId, requestKey: input.result.requestKey })).digest('hex');

    const triggerColumns = { discovery_trigger_id: null as string | null, unknown_charge_code_trigger_id: null as string | null, suspicious_pass_trigger_id: null as string | null };
    triggerColumns[resolved.column] = criterion.citedTriggerId;

    const params = [input.clientId, input.auditRunId, triggerColumns.discovery_trigger_id, triggerColumns.unknown_charge_code_trigger_id,
      triggerColumns.suspicious_pass_trigger_id, criterion.criterionKey, criterion.kind, criterion.ruleType, criterion.description,
      JSON.stringify(criterion.ast), criterion.astHash, JSON.stringify(criterion.expectedInputs), input.result.output.schemaVersion,
      input.result.provider, input.result.modelId, input.result.promptVersion, input.result.providerMessageId, input.result.requestKey,
      proposalHash, input.actorUserId];
    const inserted = await client.query<{ id: string }>(`INSERT INTO discovery_rule_proposal
      (client_id,audit_run_id,discovery_trigger_id,unknown_charge_code_trigger_id,suspicious_pass_trigger_id,criterion_key,kind,rule_type,
       description,ast,ast_hash,expected_inputs,proposal_schema_version,provider,model_id,prompt_version,provider_message_id,request_key,
       proposal_hash,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (client_id,proposal_hash) DO NOTHING RETURNING id`, params);
    let id = inserted.rows[0]?.id; if (id) createdCount += 1;
    if (!id) id = (await client.query<{ id: string }>(`SELECT id FROM discovery_rule_proposal WHERE client_id=$1 AND proposal_hash=$2`,
      [input.clientId, proposalHash])).rows[0]?.id;
    if (!id) throw new DiscoveryRuleProposalError('PARTIAL_CONFLICT');
    proposalIds.push(id);
  }
  await writeAuditEvent(client, { id: deterministicAuditEventId(input.clientId, input.auditRunId, input.result.requestKey, 'discovery_rule_proposals.persisted'),
    clientId: input.clientId, entity: 'discovery_rule_proposals', entityId: input.auditRunId, event: 'persisted', actorKind: 'ai',
    actorUserId: input.actorUserId, detail: { proposalIds, proposalCount: proposalIds.length, requestKey: input.result.requestKey,
      modelId: input.result.modelId, promptVersion: input.result.promptVersion, providerMessageId: input.result.providerMessageId } });
  return { proposalIds, proposalCount: proposalIds.length, createdCount };
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

function collectFacts(node: unknown, keys = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return keys;
  const value = node as { type?: string; key?: string; then?: unknown; left?: unknown; right?: unknown; args?: unknown[] };
  if ((value.type === 'fact' || value.type === 'require') && value.key) keys.add(value.key);
  if (value.then) collectFacts(value.then, keys); if (value.left) collectFacts(value.left, keys); if (value.right) collectFacts(value.right, keys);
  value.args?.forEach((item) => collectFacts(item, keys)); return keys;
}
