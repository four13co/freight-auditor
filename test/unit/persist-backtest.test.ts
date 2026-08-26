import { describe, expect, it, vi } from 'vitest';
import { persistBacktest } from '../../src/modules/rule-engine/persist-backtest.js';

const result = { corpusHash: 'a'.repeat(64), passed: false, passCount: 0, regressionCount: 1,
  cases: [{ id: 'case', passed: false, inputHash: 'b'.repeat(64), expectedHash: 'c'.repeat(64), actualHash: 'd'.repeat(64), actual: { result: false } }] };
describe('persistBacktest', () => {
  it('persists the summary and every immutable case', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'bt' }] }).mockResolvedValueOnce({ rows: [] });
    await expect(persistBacktest({ query } as never, { clientId: 'c', ruleVersionId: 'rv', result })).resolves.toEqual({ id: 'bt', created: true });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('fails closed on a retry whose summary differs', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'bt', passed: true, pass_count: 1, regression_count: 0 }] });
    await expect(persistBacktest({ query } as never, { clientId: 'c', ruleVersionId: 'rv', result })).rejects.toThrow('backtest evidence conflict');
  });
});
