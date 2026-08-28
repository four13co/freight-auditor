import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const schema=z.object({clientId:z.uuid(),acceptanceId:z.uuid(),actorUserId:z.uuid(),rationale:z.string().trim().min(1).max(4000)}).strict();
export class ProposalRatificationError extends Error { constructor(readonly code:'ACCEPTANCE_NOT_FOUND'|'PASSING_BACKTEST_REQUIRED'|'RATIFICATION_CONFLICT'){super(code.toLowerCase().replace(/_/g,' '));this.name='ProposalRatificationError';} }
interface Row { acceptance_id:string;proposal_id:string;backtest_id:string;shadow_id:string;rule_id:string;ast:unknown;ast_hash:string;expected_inputs:unknown;emits:string;provenance:unknown;clause_id:string|null;valid_from:string;valid_to:string|null }
export async function ratifyContractRuleProposal(client:pg.PoolClient,untrusted:z.input<typeof schema>):Promise<{ratificationId:string;activeRuleVersionId:string;created:boolean}>{
 const input=schema.parse(untrusted); const row=(await client.query<Row>(`SELECT a.id acceptance_id,a.proposal_id,a.backtest_id,a.shadow_rule_version_id shadow_id,
  rv.rule_id,rv.ast,rv.ast_hash,rv.expected_inputs,rv.emits,rv.provenance,rv.clause_id,rv.valid_from,rv.valid_to
  FROM contract_rule_proposal_acceptance a JOIN rule_version rv ON rv.id=a.shadow_rule_version_id
  JOIN contract_rule_proposal_backtest b ON b.id=a.backtest_id AND b.client_id=a.client_id AND b.proposal_id=a.proposal_id
  WHERE a.client_id=$1 AND a.id=$2 AND rv.lifecycle_state='SHADOW' AND rv.hardness='AI_DOCS' AND b.passed=true
  AND rv.source_contract_rule_proposal_id=a.proposal_id AND rv.source_contract_rule_proposal_backtest_id=a.backtest_id`,[input.clientId,input.acceptanceId])).rows[0];
 if(!row) throw new ProposalRatificationError('ACCEPTANCE_NOT_FOUND');
 const createdVersion=await client.query<{id:string}>(`INSERT INTO rule_version(rule_id,hardness,lifecycle_state,ast,ast_hash,expected_inputs,emits,provenance,clause_id,
  valid_from,valid_to,predecessor_rule_version_id,source_contract_rule_proposal_id,source_contract_rule_proposal_backtest_id,human_ratified_by,human_ratification_rationale)
  VALUES($1,'FIRM_RULE','ACTIVE',$2::jsonb,$3,$4::jsonb,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14)
  ON CONFLICT(predecessor_rule_version_id,lifecycle_state) WHERE predecessor_rule_version_id IS NOT NULL DO NOTHING RETURNING id`,
 [row.rule_id,JSON.stringify(row.ast),row.ast_hash,JSON.stringify(row.expected_inputs),row.emits,JSON.stringify(row.provenance),row.clause_id,row.valid_from,row.valid_to,row.shadow_id,row.proposal_id,row.backtest_id,input.actorUserId,input.rationale]);
 let activeId=createdVersion.rows[0]?.id;
 if(!activeId) activeId=(await client.query<{id:string}>(`SELECT id FROM rule_version WHERE predecessor_rule_version_id=$1 AND lifecycle_state='ACTIVE'
  AND hardness='FIRM_RULE' AND source_contract_rule_proposal_id=$2 AND source_contract_rule_proposal_backtest_id=$3
  AND human_ratified_by=$4 AND human_ratification_rationale=$5`,[row.shadow_id,row.proposal_id,row.backtest_id,input.actorUserId,input.rationale])).rows[0]?.id;
 if(!activeId) throw new ProposalRatificationError('RATIFICATION_CONFLICT');
 await client.query(`INSERT INTO promotion_event(rule_version_id,from_hardness,to_hardness,from_lifecycle,to_lifecycle,direction,contract_proposal_backtest_id,rationale)
  VALUES($1,'AI_DOCS','FIRM_RULE','SHADOW','ACTIVE','PROMOTE',$2,$3) ON CONFLICT(rule_version_id,from_lifecycle,to_lifecycle) DO NOTHING`,[activeId,row.backtest_id,input.rationale]);
 const inserted=await client.query<{id:string}>(`INSERT INTO contract_rule_proposal_ratification(client_id,acceptance_id,proposal_id,backtest_id,shadow_rule_version_id,active_rule_version_id,ratified_by,rationale)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(client_id,acceptance_id) DO NOTHING RETURNING id`,[input.clientId,row.acceptance_id,row.proposal_id,row.backtest_id,row.shadow_id,activeId,input.actorUserId,input.rationale]);
 let ratificationId=inserted.rows[0]?.id;
 if(!ratificationId) ratificationId=(await client.query<{id:string}>(`SELECT id FROM contract_rule_proposal_ratification WHERE client_id=$1 AND acceptance_id=$2 AND active_rule_version_id=$3 AND ratified_by=$4 AND rationale=$5`,[input.clientId,row.acceptance_id,activeId,input.actorUserId,input.rationale])).rows[0]?.id;
 if(!ratificationId) throw new ProposalRatificationError('RATIFICATION_CONFLICT');
 await writeAuditEvent(client,{id:deterministicAuditEventId(input.clientId,row.proposal_id,row.backtest_id,'contract_rule_proposal.ratified'),clientId:input.clientId,entity:'contract_rule_proposal',entityId:row.proposal_id,event:'ratified_active_firm',actorKind:'analyst',actorUserId:input.actorUserId,ruleVersionId:activeId,detail:{ratificationId,acceptanceId:row.acceptance_id,backtestId:row.backtest_id,shadowRuleVersionId:row.shadow_id,activeRuleVersionId:activeId,rationale:input.rationale}});
 return {ratificationId,activeRuleVersionId:activeId,created:Boolean(inserted.rows[0])};
}
