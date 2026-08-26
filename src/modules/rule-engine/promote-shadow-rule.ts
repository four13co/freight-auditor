import type pg from 'pg';
import { BacktestRequiredError, transitionRuleLifecycle } from './transition-rule-lifecycle.js';

export async function promoteShadowRule(client: pg.PoolClient, input: { ruleVersionId: string; rationale: string }) {
  const backtest = (await client.query<{ id: string }>(`SELECT id FROM rule_backtest
    WHERE rule_version_id=$1 AND passed=true ORDER BY recorded_at DESC, id DESC LIMIT 1`, [input.ruleVersionId])).rows[0];
  if (!backtest) throw new BacktestRequiredError('SHADOW to ACTIVE requires a passing backtest');
  return transitionRuleLifecycle(client, { ruleVersionId: input.ruleVersionId, to: 'ACTIVE',
    rationale: input.rationale, ruleBacktestId: backtest.id });
}
