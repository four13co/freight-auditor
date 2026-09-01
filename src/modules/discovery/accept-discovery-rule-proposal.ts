import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

/**
 * P3.D.7: a human (analyst) may accept a discovery proposal with a pinned
 * passing backtest into a SHADOW rule_version -- never ACTIVE. Mirrors
 * accept-contract-rule-proposal.ts; ratification to ACTIVE/FIRM_RULE has no
 * discovery analogue in this task and is out of scope.
 */

const inputSchema = z.object({ clientId: z.uuid(), proposalId: z.uuid(), backtestId: z.uuid(), actorUserId: z.uuid(),
  rationale: z.string().trim().min(1).max(4_000) }).strict();
export class DiscoveryProposalAcceptanceError extends Error {
  constructor(readonly code: 'PROPOSAL_NOT_FOUND' | 'PASSING_BACKTEST_REQUIRED' | 'RULE_CONFLICT' | 'ACCEPTANCE_CONFLICT') {
    super(code.toLowerCase().replace(/_/g, ' ')); this.name = 'DiscoveryProposalAcceptanceError';
  }
}
interface Proposal { id: string; rule_type: string; ast: unknown; ast_hash: string; expected_inputs: unknown; proposal_hash: string }

export async function acceptDiscoveryRuleProposal(client: pg.PoolClient, untrusted: z.input<typeof inputSchema>): Promise<{
  acceptanceId: string; shadowRuleVersionId: string; created: boolean;
}> {
  const input = inputSchema.parse(untrusted);
  const proposal = (await client.query<Proposal>(`SELECT id,rule_type,ast,ast_hash,expected_inputs,proposal_hash
    FROM discovery_rule_proposal WHERE client_id=$1 AND id=$2`, [input.clientId, input.proposalId])).rows[0];
  if (!proposal) throw new DiscoveryProposalAcceptanceError('PROPOSAL_NOT_FOUND');
  const backtest = (await client.query<{ id: string }>(`SELECT id FROM discovery_rule_proposal_backtest
    WHERE client_id=$1 AND id=$2 AND proposal_id=$3 AND proposal_hash=$4 AND ast_hash=$5 AND passed=true`,
  [input.clientId, input.backtestId, input.proposalId, proposal.proposal_hash, proposal.ast_hash])).rows[0];
  if (!backtest) throw new DiscoveryProposalAcceptanceError('PASSING_BACKTEST_REQUIRED');
  const slug = `discovery-proposal-${proposal.id}`;
  const rule = await client.query<{ id: string; rule_type: string }>(`INSERT INTO rule(slug,rule_type) VALUES($1,$2)
    ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id,rule_type`, [slug, proposal.rule_type]);
  if (rule.rows[0]?.rule_type !== proposal.rule_type) throw new DiscoveryProposalAcceptanceError('RULE_CONFLICT');
  const provenance = { clientId: input.clientId, proposalId: proposal.id, proposalHash: proposal.proposal_hash,
    backtestId: backtest.id, acceptedBy: input.actorUserId };
  const insertedVersion = await client.query<{ id: string }>(`INSERT INTO rule_version(rule_id,hardness,lifecycle_state,ast,ast_hash,
    expected_inputs,emits,provenance,source_discovery_rule_proposal_id,source_discovery_rule_proposal_backtest_id)
    VALUES($1,'AI_DOCS','SHADOW',$2::jsonb,$3,$4::jsonb,'PASS_FAIL',$5::jsonb,$6,$7)
    ON CONFLICT(source_discovery_rule_proposal_id) WHERE source_discovery_rule_proposal_id IS NOT NULL DO NOTHING RETURNING id`,
  [rule.rows[0]!.id, JSON.stringify(proposal.ast), proposal.ast_hash, JSON.stringify(proposal.expected_inputs),
    JSON.stringify(provenance), proposal.id, backtest.id]);
  let shadowId = insertedVersion.rows[0]?.id;
  if (!shadowId) shadowId = (await client.query<{ id: string }>(`SELECT id FROM rule_version WHERE source_discovery_rule_proposal_id=$1
    AND rule_id=$2 AND lifecycle_state='SHADOW' AND ast_hash=$3 AND source_discovery_rule_proposal_backtest_id=$4
    AND provenance IS NOT DISTINCT FROM $5::jsonb`, [proposal.id, rule.rows[0]!.id, proposal.ast_hash, backtest.id,
    JSON.stringify(provenance)])).rows[0]?.id;
  if (!shadowId) throw new DiscoveryProposalAcceptanceError('ACCEPTANCE_CONFLICT');
  const insertedAcceptance = await client.query<{ id: string }>(`INSERT INTO discovery_rule_proposal_acceptance
    (client_id,proposal_id,backtest_id,shadow_rule_version_id,accepted_by,rationale) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(client_id,proposal_id) DO NOTHING RETURNING id`, [input.clientId, proposal.id, backtest.id, shadowId,
    input.actorUserId, input.rationale]);
  let acceptanceId = insertedAcceptance.rows[0]?.id;
  if (!acceptanceId) acceptanceId = (await client.query<{ id: string }>(`SELECT id FROM discovery_rule_proposal_acceptance
    WHERE client_id=$1 AND proposal_id=$2 AND backtest_id=$3 AND shadow_rule_version_id=$4 AND accepted_by=$5 AND rationale=$6`,
  [input.clientId, proposal.id, backtest.id, shadowId, input.actorUserId, input.rationale])).rows[0]?.id;
  if (!acceptanceId) throw new DiscoveryProposalAcceptanceError('ACCEPTANCE_CONFLICT');
  await writeAuditEvent(client, { id: deterministicAuditEventId(input.clientId, proposal.id, backtest.id, 'discovery_rule_proposal.accepted'),
    clientId: input.clientId, entity: 'discovery_rule_proposal', entityId: proposal.id, event: 'accepted_to_shadow',
    actorKind: 'analyst', actorUserId: input.actorUserId, ruleVersionId: shadowId,
    detail: { acceptanceId, proposalHash: proposal.proposal_hash, astHash: proposal.ast_hash, backtestId: backtest.id,
      shadowRuleVersionId: shadowId, rationale: input.rationale } });
  return { acceptanceId, shadowRuleVersionId: shadowId, created: Boolean(insertedAcceptance.rows[0]) };
}
