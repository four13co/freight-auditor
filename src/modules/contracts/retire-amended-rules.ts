import type pg from 'pg';
import { analyzeAmendmentImpact } from './analyze-amendment-impact.js';
import { transitionRuleLifecycle } from '../rule-engine/transition-rule-lifecycle.js';

export interface AmendedRuleTransition { oldRuleVersionId: string; deprecatedRuleVersionId: string; replacementRuleVersionId: string | null }
export async function retireAmendedRules(client: pg.PoolClient, input: {
  clientId: string; amendmentId: string;
}): Promise<AmendedRuleTransition[]> {
  const impacts = await analyzeAmendmentImpact(client, input);
  const transitions: AmendedRuleTransition[] = [];
  for (const impact of impacts) for (const oldRuleVersionId of impact.affectedRuleVersionIds) {
    const deprecated = await transitionRuleLifecycle(client, { ruleVersionId: oldRuleVersionId, to: 'DEPRECATED',
      rationale: `Contract amendment ${input.amendmentId}: clause ${impact.clauseReference} ${impact.change.toLowerCase()}` });
    let replacementRuleVersionId: string | null = null;
    if (impact.change === 'CHANGED' && impact.newClauseId) {
      const inserted = await client.query<{ id: string }>(`INSERT INTO rule_version
          (rule_id, hardness, lifecycle_state, ast, ast_hash, expected_inputs, emits, provenance, clause_id,
           valid_from, valid_to, predecessor_rule_version_id)
        SELECT rule_id, hardness, 'PROPOSED', ast, ast_hash, expected_inputs, emits,
          provenance || jsonb_build_object('contractAmendmentId',$3::text,'replacementFor',$1::text), $2::uuid,
          valid_from, valid_to, id FROM rule_version WHERE id=$1::uuid
        ON CONFLICT (predecessor_rule_version_id, lifecycle_state) WHERE predecessor_rule_version_id IS NOT NULL
        DO NOTHING RETURNING id`, [deprecated.ruleVersionId, impact.newClauseId, input.amendmentId]);
      replacementRuleVersionId = inserted.rows[0]?.id ?? (await client.query<{ id: string }>(
        `SELECT id FROM rule_version WHERE predecessor_rule_version_id=$1 AND lifecycle_state='PROPOSED'`,
        [deprecated.ruleVersionId])).rows[0]?.id ?? null;
      if (!replacementRuleVersionId) throw new Error('amended rule replacement retry could not be resolved');
    }
    transitions.push({ oldRuleVersionId, deprecatedRuleVersionId: deprecated.ruleVersionId, replacementRuleVersionId });
  }
  return transitions;
}
