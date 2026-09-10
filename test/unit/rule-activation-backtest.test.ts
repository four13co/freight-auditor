import { describe, expect, it, vi } from 'vitest';
import {
  runAndPersistRuleActivationBacktest, RuleActivationBacktestRegressionError, activationCasesSchema,
} from '../../src/modules/rule-engine/rule-activation-backtest.js';
import type { AstNode } from '../../src/modules/rule-engine/ast.js';

const AST: AstNode = { type: 'compare', op: 'gte', left: { type: 'fact', key: 'amount' }, right: { type: 'lit', value: 100 } };

describe('runAndPersistRuleActivationBacktest', () => {
  it('persists a global (client_id NULL) rule_backtest row when every supplied case passes', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ ast: AST }] }) // SELECT ast
      .mockResolvedValueOnce({ rows: [{ id: 'bt-1' }] }) // persistBacktest INSERT rule_backtest
      .mockResolvedValueOnce({ rows: [] }); // persistBacktest INSERT rule_backtest_case
    const cases = [{ id: 'case-1', facts: { amount: 150 }, expectedVerdict: 'PASS' as const }];

    const result = await runAndPersistRuleActivationBacktest({ query } as never, { ruleVersionId: 'rv-1', cases });

    expect(result.backtestId).toBe('bt-1');
    expect(result.result).toMatchObject({ passed: true, passCount: 1, regressionCount: 0 });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('INSERT INTO rule_backtest'),
      [null, 'rv-1', result.result.corpusHash, true, 1, 0]);
  });

  it('rejects with regression detail and never persists when a case regresses', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ ast: AST }] });
    const cases = [{ id: 'case-1', facts: { amount: 50 }, expectedVerdict: 'PASS' as const }];

    const error = await runAndPersistRuleActivationBacktest({ query } as never, { ruleVersionId: 'rv-1', cases })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RuleActivationBacktestRegressionError);
    expect((error as RuleActivationBacktestRegressionError).result).toMatchObject({ passed: false, regressionCount: 1 });
    expect(query).toHaveBeenCalledTimes(1); // only the ast lookup -- nothing was persisted
  });

  it('rejects when the rule version does not exist', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const cases = [{ id: 'case-1', facts: { amount: 150 }, expectedVerdict: 'PASS' as const }];

    await expect(runAndPersistRuleActivationBacktest({ query } as never, { ruleVersionId: 'missing', cases }))
      .rejects.toThrow('rule version not found: missing');
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('activationCasesSchema', () => {
  it('accepts a well-formed corpus', () => {
    const parsed = activationCasesSchema.safeParse([{ id: 'c1', facts: { amount: 10 }, expectedVerdict: 'PASS' }]);
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty corpus', () => {
    expect(activationCasesSchema.safeParse([]).success).toBe(false);
  });

  it('rejects an unknown field on a case (strict shape)', () => {
    const parsed = activationCasesSchema.safeParse([{ id: 'c1', facts: {}, expectedVerdict: 'PASS', extra: true }]);
    expect(parsed.success).toBe(false);
  });
});
