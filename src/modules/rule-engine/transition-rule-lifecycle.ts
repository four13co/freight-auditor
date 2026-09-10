import type pg from 'pg';

export type RuleLifecycle = 'PROPOSED' | 'SHADOW' | 'ACTIVE' | 'DEPRECATED' | 'QUARANTINED';
const ALLOWED: Record<RuleLifecycle, readonly RuleLifecycle[]> = {
  PROPOSED: ['SHADOW', 'QUARANTINED'], SHADOW: ['ACTIVE', 'QUARANTINED'],
  ACTIVE: ['DEPRECATED', 'QUARANTINED'], QUARANTINED: ['SHADOW'], DEPRECATED: [],
};
export class InvalidLifecycleTransitionError extends Error { readonly code = 'INVALID_RULE_LIFECYCLE_TRANSITION'; }
export function assertLifecycleTransition(from: RuleLifecycle, to: RuleLifecycle): void {
  if (!ALLOWED[from].includes(to)) throw new InvalidLifecycleTransitionError(`invalid rule lifecycle transition: ${from} -> ${to}`);
}

// 86e367r9q: this function used to hard-require a passing rule_backtest row
// for any SHADOW->ACTIVE transition, but rule/rule_version are GLOBAL tables
// (no client_id) and rule_backtest.client_id is NOT NULL -- nothing in the
// real generic rule lifecycle could ever produce one, so every real call
// threw. promoteShadowRule (the only to:'ACTIVE' caller) now gates ACTIVE
// promotion itself via dual-control instead; this function stays a pure
// lifecycle-FSM writer, only persisting whatever evidence its caller already
// validated (dualControlAnalystId, ruleBacktestId) rather than opining on it
// itself. promotion_event's own active_promotion_requires_backtest CHECK
// constraint (migration 0078) accepts either as alternative evidence.
// 86e36zket: ruleBacktestId is the additive corpus-backtest evidence path --
// rule_backtest.client_id is nullable as of migration 0079, so a global rule
// can now produce a real rule_backtest row via the /activate cases path.
export async function transitionRuleLifecycle(client: pg.PoolClient, input: {
  ruleVersionId: string; to: RuleLifecycle; rationale: string;
  dualControlAnalystId?: string | null; ruleBacktestId?: string | null;
}): Promise<{ ruleVersionId: string; created: boolean }> {
  const current = (await client.query<{ lifecycle_state: RuleLifecycle }>(
    `SELECT lifecycle_state FROM rule_version WHERE id=$1`, [input.ruleVersionId])).rows[0];
  if (!current) throw new Error(`rule version not found: ${input.ruleVersionId}`);
  assertLifecycleTransition(current.lifecycle_state, input.to);
  const created = await client.query<{ id: string }>(`INSERT INTO rule_version
      (rule_id, hardness, lifecycle_state, ast, ast_hash, expected_inputs, emits, provenance, clause_id,
       valid_from, valid_to, predecessor_rule_version_id)
    SELECT rule_id, hardness, $2::rule_lifecycle, ast, ast_hash, expected_inputs, emits, provenance, clause_id,
       valid_from, valid_to, id FROM rule_version WHERE id=$1
    ON CONFLICT (predecessor_rule_version_id, lifecycle_state) WHERE predecessor_rule_version_id IS NOT NULL
    DO NOTHING RETURNING id`, [input.ruleVersionId, input.to]);
  let nextId = created.rows[0]?.id;
  if (!nextId) nextId = (await client.query<{ id: string }>(
    `SELECT id FROM rule_version WHERE predecessor_rule_version_id=$1 AND lifecycle_state=$2`,
    [input.ruleVersionId, input.to])).rows[0]?.id;
  if (!nextId) throw new Error('rule lifecycle retry could not be resolved');
  await client.query(`INSERT INTO promotion_event
      (rule_version_id, from_hardness, to_hardness, from_lifecycle, to_lifecycle, direction, rationale, dual_control_analyst_id, rule_backtest_id)
    SELECT $1, hardness, hardness, $2::rule_lifecycle, $3::rule_lifecycle,
      $4::promotion_direction, $5, $6, $7 FROM rule_version WHERE id=$1
    ON CONFLICT (rule_version_id, from_lifecycle, to_lifecycle) DO NOTHING`,
  [nextId, current.lifecycle_state, input.to,
    input.to === 'DEPRECATED' || input.to === 'QUARANTINED' ? 'DEMOTE' : 'PROMOTE',
    input.rationale, input.dualControlAnalystId ?? null, input.ruleBacktestId ?? null]);
  return { ruleVersionId: nextId, created: Boolean(created.rows[0]) };
}
