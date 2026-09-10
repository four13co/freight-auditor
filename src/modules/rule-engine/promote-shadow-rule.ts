import type pg from 'pg';
import { transitionRuleLifecycle } from './transition-rule-lifecycle.js';

export class DualControlRequiredError extends Error { readonly code = 'DUAL_CONTROL_REQUIRED'; }

export async function promoteShadowRule(client: pg.PoolClient, input: { ruleVersionId: string; rationale: string; actorUserId: string }) {
  // 86e367r9q: activation requires a DIFFERENT analyst than whoever ratified
  // this rule version -- the compensating control replacing the unreachable
  // rule_backtest gate (see transition-rule-lifecycle.ts's own note). The
  // ratifying analyst's id is already on record: /ratify's writeAuditEvent
  // call stamps it on the promoted_to_shadow audit_event for this exact
  // ruleVersionId, so that event is the source of truth for "who ratified" --
  // no new table or column. A rule version with no such event on record
  // (activation attempted without a logged ratification step) is rejected
  // the same way as a same-actor attempt, not treated as a smaller problem.
  const ratification = (await client.query<{ actor_user_id: string | null }>(
    `SELECT actor_user_id FROM audit_event
     WHERE entity='rule_version' AND rule_version_id=$1 AND event='promoted_to_shadow'
     ORDER BY recorded_at DESC, id DESC LIMIT 1`, [input.ruleVersionId])).rows[0];
  if (!ratification || ratification.actor_user_id === input.actorUserId) {
    throw new DualControlRequiredError('SHADOW to ACTIVE requires activation by a different analyst than the one who ratified it');
  }
  return transitionRuleLifecycle(client, {
    ruleVersionId: input.ruleVersionId, to: 'ACTIVE', rationale: input.rationale,
    dualControlAnalystId: input.actorUserId,
  });
}
