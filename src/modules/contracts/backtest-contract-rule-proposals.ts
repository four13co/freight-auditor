import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import { stableStringify } from '../evaluator/snapshot.js';
import type { AstNode, FactBundle } from '../rule-engine/ast.js';
import { evaluate, verdict } from '../rule-engine/interpreter.js';
import { PROPOSABLE_FACT_KEYS } from './proposed-criteria.js';

export const PROPOSAL_BACKTEST_CORPUS_SCHEMA_VERSION = 'contract-proposal-backtest/1';
const factValue = z.union([z.number().finite(), z.string().max(4_000), z.boolean(),
  z.object({ amount: z.string().max(100), currency: z.string().trim().min(1).max(10) }).strict(),
  z.object({ decimal: z.string().max(100) }).strict()]);
const caseSchema = z.object({
  caseKey: z.string().trim().min(1).max(300),
  facts: z.partialRecord(z.enum(PROPOSABLE_FACT_KEYS), factValue),
  expectedVerdict: z.enum(['PASS', 'FAIL', 'UNASSESSABLE']),
}).strict();
const inputSchema = z.object({
  clientId: z.uuid(), verifiedContractVersionId: z.uuid(), actorUserId: z.uuid(),
  corpusSchemaVersion: z.literal(PROPOSAL_BACKTEST_CORPUS_SCHEMA_VERSION),
  proposals: z.array(z.object({ proposalId: z.uuid(), cases: z.array(caseSchema).min(1).max(10_000) }).strict()).min(1).max(1_000),
}).strict();

export class ProposalBacktestError extends Error {
  constructor(readonly code: 'PROPOSAL_SET_MISMATCH' | 'DUPLICATE_PROPOSAL' | 'DUPLICATE_CASE' |
    'UNEXPECTED_FACT' | 'PROPOSAL_CHANGED' | 'PARTIAL_CONFLICT') {
    super(code.toLowerCase().replace(/_/g, ' ')); this.name = 'ProposalBacktestError';
  }
}

interface ProposalRow { id: string; proposal_hash: string; ast_hash: string; ast: AstNode; expected_inputs: string[] }
export interface ProposalBacktestCase { caseKey: string; facts: FactBundle; expectedVerdict: 'PASS' | 'FAIL' | 'UNASSESSABLE' }
export interface CaseEvidence { caseKey: string; facts: FactBundle; expectedVerdict: 'PASS' | 'FAIL' | 'UNASSESSABLE';
  actualVerdict: 'PASS' | 'FAIL' | 'UNASSESSABLE'; passed: boolean; inputHash: string; expectedHash: string;
  actualHash: string; evaluatedAst: unknown }

export async function backtestContractRuleProposals(client: pg.PoolClient, untrusted: z.input<typeof inputSchema>): Promise<{
  backtestIds: string[]; proposalCount: number; passed: boolean; createdCount: number;
}> {
  const input = inputSchema.parse(untrusted);
  const suppliedIds = input.proposals.map((item) => item.proposalId);
  if (new Set(suppliedIds).size !== suppliedIds.length) throw new ProposalBacktestError('DUPLICATE_PROPOSAL');
  const rows = (await client.query<ProposalRow>(`SELECT id,proposal_hash,ast_hash,ast,expected_inputs
    FROM contract_rule_proposal WHERE client_id=$1 AND verified_contract_version_id=$2 ORDER BY id`,
  [input.clientId, input.verifiedContractVersionId])).rows;
  if (rows.length !== suppliedIds.length || rows.some((row) => !suppliedIds.includes(row.id)))
    throw new ProposalBacktestError('PROPOSAL_SET_MISMATCH');
  const supplied = new Map(input.proposals.map((item) => [item.proposalId, item.cases]));
  const backtestIds: string[] = []; let createdCount = 0; let allPassed = true;
  const batchEvidence: Array<{ proposalId: string; corpusHash: string; backtestId: string; passed: boolean }> = [];

  for (const proposal of rows) {
    const astHash = hash(proposal.ast);
    if (astHash !== proposal.ast_hash) throw new ProposalBacktestError('PROPOSAL_CHANGED');
    const evidence = evaluateProposalCorpus(proposal.ast, proposal.expected_inputs, supplied.get(proposal.id)!);
    const regressionCount = evidence.filter((item) => !item.passed).length;
    const passed = regressionCount === 0; allPassed &&= passed;
    const corpusHash = hash({ schemaVersion: input.corpusSchemaVersion, proposalHash: proposal.proposal_hash,
      astHash: proposal.ast_hash, cases: evidence.map(({ caseKey, inputHash, expectedHash }) => ({ caseKey, inputHash, expectedHash })) });
    const inserted = await client.query<{ id: string }>(`INSERT INTO contract_rule_proposal_backtest
      (client_id,proposal_id,corpus_schema_version,corpus_hash,proposal_hash,ast_hash,passed,pass_count,regression_count,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(client_id,proposal_id,corpus_hash) DO NOTHING RETURNING id`,
    [input.clientId, proposal.id, input.corpusSchemaVersion, corpusHash, proposal.proposal_hash, proposal.ast_hash,
      passed, evidence.length - regressionCount, regressionCount, input.actorUserId]);
    let backtestId = inserted.rows[0]?.id; if (backtestId) createdCount += 1;
    if (!backtestId) backtestId = (await client.query<{ id: string }>(`SELECT id FROM contract_rule_proposal_backtest
      WHERE client_id=$1 AND proposal_id=$2 AND corpus_hash=$3 AND proposal_hash=$4 AND ast_hash=$5 AND passed=$6
      AND pass_count=$7 AND regression_count=$8 AND actor_user_id=$9`, [input.clientId, proposal.id, corpusHash,
      proposal.proposal_hash, proposal.ast_hash, passed, evidence.length - regressionCount, regressionCount, input.actorUserId])).rows[0]?.id;
    if (!backtestId) throw new ProposalBacktestError('PARTIAL_CONFLICT');
    for (const item of evidence) {
      const params = [input.clientId, backtestId, item.caseKey, JSON.stringify(item.facts), item.expectedVerdict,
        item.actualVerdict, item.passed, item.inputHash, item.expectedHash, item.actualHash, JSON.stringify(item.evaluatedAst)];
      const result = await client.query(`INSERT INTO contract_rule_proposal_backtest_case
        (client_id,backtest_id,case_key,facts,expected_verdict,actual_verdict,passed,input_hash,expected_hash,actual_hash,evaluated_ast)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(client_id,backtest_id,case_key) DO NOTHING`, params);
      if (result.rowCount !== 1 && !(await client.query(`SELECT 1 FROM contract_rule_proposal_backtest_case WHERE client_id=$1
        AND backtest_id=$2 AND case_key=$3 AND facts IS NOT DISTINCT FROM $4::jsonb AND expected_verdict=$5 AND actual_verdict=$6
        AND passed=$7 AND input_hash=$8 AND expected_hash=$9 AND actual_hash=$10 AND evaluated_ast IS NOT DISTINCT FROM $11::jsonb`, params)).rowCount)
        throw new ProposalBacktestError('PARTIAL_CONFLICT');
    }
    backtestIds.push(backtestId); batchEvidence.push({ proposalId: proposal.id, corpusHash, backtestId, passed });
  }
  const batchHash = hash(batchEvidence.map(({ proposalId, corpusHash }) => ({ proposalId, corpusHash })));
  await writeAuditEvent(client, { id: deterministicAuditEventId(input.clientId, input.verifiedContractVersionId,
    batchHash, 'contract_rule_proposals.backtested'), clientId: input.clientId, entity: 'contract_rule_proposals',
  entityId: input.verifiedContractVersionId, event: 'backtested', actorKind: 'analyst', actorUserId: input.actorUserId,
  detail: { corpusSchemaVersion: input.corpusSchemaVersion, batchHash, proposalCount: rows.length, passed: allPassed, backtests: batchEvidence } });
  return { backtestIds, proposalCount: rows.length, passed: allPassed, createdCount };
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function evaluateProposalCorpus(ast: AstNode, expectedInputs: readonly string[], cases: readonly ProposalBacktestCase[]): CaseEvidence[] {
  const caseKeys = cases.map((item) => item.caseKey);
  if (new Set(caseKeys).size !== caseKeys.length) throw new ProposalBacktestError('DUPLICATE_CASE');
  const allowed = new Set(expectedInputs);
  if (cases.some((item) => Object.keys(item.facts).some((key) => !allowed.has(key))))
    throw new ProposalBacktestError('UNEXPECTED_FACT');
  return [...cases].sort((a, b) => a.caseKey.localeCompare(b.caseKey)).map((item): CaseEvidence => {
    const evaluatedAst = evaluate(ast, item.facts);
    const actualVerdict = verdict(evaluatedAst);
    return { ...item, actualVerdict, passed: actualVerdict === item.expectedVerdict,
      inputHash: hash(item.facts), expectedHash: hash(item.expectedVerdict), actualHash: hash(evaluatedAst), evaluatedAst };
  });
}
