import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const inputSchema = z.object({ clientId: z.uuid(), proposalId: z.uuid(), backtestId: z.uuid(), actorUserId: z.uuid(),
  rationale: z.string().trim().min(1).max(4_000) }).strict();
export class ProposalAcceptanceError extends Error {
  constructor(readonly code: 'PROPOSAL_NOT_FOUND' | 'PASSING_BACKTEST_REQUIRED' | 'RULE_CONFLICT' | 'ACCEPTANCE_CONFLICT') {
    super(code.toLowerCase().replace(/_/g, ' ')); this.name = 'ProposalAcceptanceError';
  }
}
interface Proposal { id: string; rule_type: string; ast: unknown; ast_hash: string; expected_inputs: unknown;
  proposal_hash: string; verified_contract_version_id: string; contract_clause_id: string | null }

export async function acceptContractRuleProposal(client: pg.PoolClient, untrusted: z.input<typeof inputSchema>): Promise<{
  acceptanceId: string; shadowRuleVersionId: string; created: boolean;
}> {
  const input = inputSchema.parse(untrusted);
  const proposal = (await client.query<Proposal>(`SELECT p.id,p.rule_type,p.ast,p.ast_hash,p.expected_inputs,p.proposal_hash,
    p.verified_contract_version_id,(SELECT pc.contract_clause_id FROM contract_rule_proposal_clause pc
      JOIN contract_clause cc ON cc.id=pc.contract_clause_id AND cc.client_id=pc.client_id
      WHERE pc.client_id=p.client_id AND pc.proposal_id=p.id ORDER BY cc.clause_ref,cc.id LIMIT 1) contract_clause_id
    FROM contract_rule_proposal p WHERE p.client_id=$1 AND p.id=$2`, [input.clientId, input.proposalId])).rows[0];
  if (!proposal) throw new ProposalAcceptanceError('PROPOSAL_NOT_FOUND');
  const backtest = (await client.query<{ id: string }>(`SELECT id FROM contract_rule_proposal_backtest
    WHERE client_id=$1 AND id=$2 AND proposal_id=$3 AND proposal_hash=$4 AND ast_hash=$5 AND passed=true`,
  [input.clientId, input.backtestId, input.proposalId, proposal.proposal_hash, proposal.ast_hash])).rows[0];
  if (!backtest) throw new ProposalAcceptanceError('PASSING_BACKTEST_REQUIRED');
  const slug = `contract-proposal-${proposal.id}`;
  const rule = await client.query<{ id: string; rule_type: string }>(`INSERT INTO rule(slug,rule_type) VALUES($1,$2)
    ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id,rule_type`, [slug, proposal.rule_type]);
  if (rule.rows[0]?.rule_type !== proposal.rule_type) throw new ProposalAcceptanceError('RULE_CONFLICT');
  const provenance = { clientId: input.clientId, proposalId: proposal.id, proposalHash: proposal.proposal_hash,
    backtestId: backtest.id, verifiedContractVersionId: proposal.verified_contract_version_id, acceptedBy: input.actorUserId };
  const insertedVersion = await client.query<{ id: string }>(`INSERT INTO rule_version(rule_id,hardness,lifecycle_state,ast,ast_hash,
    expected_inputs,emits,provenance,clause_id,source_contract_rule_proposal_id,source_contract_rule_proposal_backtest_id)
    VALUES($1,'AI_DOCS','SHADOW',$2::jsonb,$3,$4::jsonb,'PASS_FAIL',$5::jsonb,$6,$7,$8)
    ON CONFLICT(source_contract_rule_proposal_id,lifecycle_state) WHERE source_contract_rule_proposal_id IS NOT NULL DO NOTHING RETURNING id`,
  [rule.rows[0]!.id, JSON.stringify(proposal.ast), proposal.ast_hash, JSON.stringify(proposal.expected_inputs),
    JSON.stringify(provenance), proposal.contract_clause_id, proposal.id, backtest.id]);
  let shadowId = insertedVersion.rows[0]?.id;
  if (!shadowId) shadowId = (await client.query<{ id: string }>(`SELECT id FROM rule_version WHERE source_contract_rule_proposal_id=$1
    AND rule_id=$2 AND lifecycle_state='SHADOW' AND ast_hash=$3 AND source_contract_rule_proposal_backtest_id=$4
    AND provenance IS NOT DISTINCT FROM $5::jsonb`, [proposal.id, rule.rows[0]!.id, proposal.ast_hash, backtest.id,
    JSON.stringify(provenance)])).rows[0]?.id;
  if (!shadowId) throw new ProposalAcceptanceError('ACCEPTANCE_CONFLICT');
  const insertedAcceptance = await client.query<{ id: string }>(`INSERT INTO contract_rule_proposal_acceptance
    (client_id,proposal_id,backtest_id,shadow_rule_version_id,accepted_by,rationale) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(client_id,proposal_id) DO NOTHING RETURNING id`, [input.clientId, proposal.id, backtest.id, shadowId,
    input.actorUserId, input.rationale]);
  let acceptanceId = insertedAcceptance.rows[0]?.id;
  if (!acceptanceId) acceptanceId = (await client.query<{ id: string }>(`SELECT id FROM contract_rule_proposal_acceptance
    WHERE client_id=$1 AND proposal_id=$2 AND backtest_id=$3 AND shadow_rule_version_id=$4 AND accepted_by=$5 AND rationale=$6`,
  [input.clientId, proposal.id, backtest.id, shadowId, input.actorUserId, input.rationale])).rows[0]?.id;
  if (!acceptanceId) throw new ProposalAcceptanceError('ACCEPTANCE_CONFLICT');
  await writeAuditEvent(client, { id: deterministicAuditEventId(input.clientId, proposal.id, backtest.id, 'contract_rule_proposal.accepted'),
    clientId: input.clientId, entity: 'contract_rule_proposal', entityId: proposal.id, event: 'accepted_to_shadow',
    actorKind: 'analyst', actorUserId: input.actorUserId, ruleVersionId: shadowId,
    detail: { acceptanceId, proposalHash: proposal.proposal_hash, astHash: proposal.ast_hash, backtestId: backtest.id,
      shadowRuleVersionId: shadowId, rationale: input.rationale } });
  return { acceptanceId, shadowRuleVersionId: shadowId, created: Boolean(insertedAcceptance.rows[0]) };
}
