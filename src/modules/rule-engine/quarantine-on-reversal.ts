import type pg from 'pg';
import { resolvePromotionPolicy } from './promotion-policy.js';
import { transitionRuleLifecycle } from './transition-rule-lifecycle.js';

export async function quarantineOnReversal(client: pg.PoolClient, input: {
  clientId: string; criterionId: string; ruleVersionId: string;
}): Promise<{ quarantined: boolean; ruleVersionId: string }> {
  const rule = (await client.query<{ rule_type: Parameters<typeof resolvePromotionPolicy>[2]; lifecycle_state: string }>(
    `SELECT r.rule_type, rv.lifecycle_state FROM rule_version rv JOIN rule r ON r.id=rv.rule_id WHERE rv.id=$1`,
    [input.ruleVersionId])).rows[0];
  if (!rule) throw new Error(`rule version not found: ${input.ruleVersionId}`);
  if (rule.lifecycle_state !== 'ACTIVE') throw new Error(`reversal quarantine requires ACTIVE rule: ${input.ruleVersionId}`);
  const policy = await resolvePromotionPolicy(client, input.clientId, rule.rule_type);
  const reversals = Number((await client.query<{ count: string }>(`SELECT coalesce(sum(reversal_count),0)::text count
    FROM human_override WHERE criterion_id=$1 AND (client_id=$2 OR client_id IS NULL)`, [input.criterionId, input.clientId])).rows[0]?.count ?? '0');
  if (reversals <= policy.maxReversals) return { quarantined: false, ruleVersionId: input.ruleVersionId };
  const result = await transitionRuleLifecycle(client, { ruleVersionId: input.ruleVersionId, to: 'QUARANTINED',
    rationale: `Reversal threshold exceeded: ${reversals} > ${policy.maxReversals}` });
  return { quarantined: true, ruleVersionId: result.ruleVersionId };
}
