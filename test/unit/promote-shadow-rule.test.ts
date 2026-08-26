import { describe, expect, it, vi } from 'vitest';
import { promoteShadowRule } from '../../src/modules/rule-engine/promote-shadow-rule.js';

describe('promoteShadowRule', () => {
  it('fails before lifecycle writes when no passing backtest exists', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(promoteShadowRule({ query } as never, { ruleVersionId: 'rv', rationale: 'x' })).rejects.toThrow('requires a passing backtest');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
