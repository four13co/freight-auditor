import type pg from 'pg';

interface BacktestCaseResult { id: string; passed: boolean; inputHash: string; expectedHash: string; actualHash: string; actual: unknown }
interface BacktestResult { corpusHash: string; passed: boolean; passCount: number; regressionCount: number; cases: BacktestCaseResult[] }

export async function persistBacktest(client: pg.PoolClient, input: {
  clientId: string; ruleVersionId: string; result: BacktestResult;
}): Promise<{ id: string; created: boolean }> {
  const inserted = await client.query<{ id: string }>(`INSERT INTO rule_backtest
    (client_id, rule_version_id, corpus_hash, passed, pass_count, regression_count) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (client_id, rule_version_id, corpus_hash) DO NOTHING RETURNING id`,
  [input.clientId, input.ruleVersionId, input.result.corpusHash, input.result.passed, input.result.passCount, input.result.regressionCount]);
  let id = inserted.rows[0]?.id;
  if (!id) {
    const row = (await client.query<{ id: string; passed: boolean; pass_count: number; regression_count: number }>(
      `SELECT id, passed, pass_count, regression_count FROM rule_backtest WHERE client_id=$1 AND rule_version_id=$2 AND corpus_hash=$3`,
      [input.clientId, input.ruleVersionId, input.result.corpusHash])).rows[0];
    if (!row || row.passed !== input.result.passed || row.pass_count !== input.result.passCount || row.regression_count !== input.result.regressionCount)
      throw new Error('backtest evidence conflict');
    id = row.id;
  }
  for (const item of input.result.cases) await client.query(`INSERT INTO rule_backtest_case
    (client_id, backtest_id, case_key, passed, input_hash, expected_hash, actual_hash, actual)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (backtest_id, case_key) DO NOTHING`,
  [input.clientId, id, item.id, item.passed, item.inputHash, item.expectedHash, item.actualHash, JSON.stringify(item.actual)]);
  return { id, created: Boolean(inserted.rows[0]) };
}
