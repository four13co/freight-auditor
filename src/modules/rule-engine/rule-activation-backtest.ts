import type pg from 'pg';
import { z } from 'zod';
import type { AstNode, FactBundle } from './ast.js';
import { evaluate, verdict } from './interpreter.js';
import { runGoldenCorpus, type GoldenCorpusResult } from './golden-corpus-runner.js';
import { persistBacktest } from './persist-backtest.js';

// 86e36zket: caller-supplied corpus evidence for activating a GLOBAL
// (client-less) rule -- cases are curated/maintained by the analyst per
// activation call, never queried live from historical data (Bridge
// explicitly rejected an all-historical-data corpus: non-deterministic
// hash, implicit live scan of every tenant's financial data).
const factValueSchema = z.union([
  z.number().finite(), z.string().max(4_000), z.boolean(),
  z.object({ amount: z.string().max(100), currency: z.string().trim().min(1).max(10) }).strict(),
  z.object({ decimal: z.string().max(100) }).strict(),
]);
export const activationCasesSchema = z.array(z.object({
  id: z.string().trim().min(1).max(300),
  facts: z.record(z.string(), factValueSchema),
  expectedVerdict: z.enum(['PASS', 'FAIL', 'UNASSESSABLE']),
}).strict()).min(1).max(10_000);
export type ActivationCorpusCase = z.infer<typeof activationCasesSchema>[number];

export class RuleActivationBacktestRegressionError extends Error {
  readonly code = 'RULE_ACTIVATION_BACKTEST_REGRESSION';
  constructor(readonly result: GoldenCorpusResult) {
    super('rule activation corpus backtest has regressions');
    this.name = 'RuleActivationBacktestRegressionError';
  }
}

/**
 * Runs the supplied corpus against the rule version's own AST (same
 * evaluate/verdict wiring backtest-contract-rule-proposals.ts uses for the
 * sibling proposal-backtest pipeline) and, only on a fully-passing corpus,
 * persists the evidence via persistBacktest with clientId: null -- there is
 * no single client to attribute a global rule's evidence to. A regressing
 * corpus throws before anything is persisted, so no partial evidence row
 * is ever left behind for a rule that didn't actually pass.
 */
export async function runAndPersistRuleActivationBacktest(client: pg.PoolClient, input: {
  ruleVersionId: string; cases: readonly ActivationCorpusCase[];
}): Promise<{ backtestId: string; result: GoldenCorpusResult }> {
  const ruleVersion = (await client.query<{ ast: AstNode }>(
    `SELECT ast FROM rule_version WHERE id=$1`, [input.ruleVersionId])).rows[0];
  if (!ruleVersion) throw new Error(`rule version not found: ${input.ruleVersionId}`);

  const result = await runGoldenCorpus(
    input.cases.map((item) => ({ id: item.id, input: item.facts, expected: item.expectedVerdict })),
    (facts: FactBundle) => verdict(evaluate(ruleVersion.ast, facts)),
  );
  if (!result.passed) throw new RuleActivationBacktestRegressionError(result);

  const persisted = await persistBacktest(client, { clientId: null, ruleVersionId: input.ruleVersionId, result });
  return { backtestId: persisted.id, result };
}
