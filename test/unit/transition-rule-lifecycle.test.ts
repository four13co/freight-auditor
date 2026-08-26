import { describe, expect, it, vi } from 'vitest';
import { assertLifecycleTransition, transitionRuleLifecycle } from '../../src/modules/rule-engine/transition-rule-lifecycle.js';

describe('rule lifecycle transitions', () => {
  it.each([['PROPOSED', 'SHADOW'], ['SHADOW', 'ACTIVE'], ['ACTIVE', 'DEPRECATED'], ['ACTIVE', 'QUARANTINED'], ['QUARANTINED', 'SHADOW']] as const)(
    'allows governed edge %s -> %s', (from, to) => expect(() => assertLifecycleTransition(from, to)).not.toThrow());
  it.each([['PROPOSED', 'ACTIVE'], ['ACTIVE', 'SHADOW'], ['DEPRECATED', 'ACTIVE']] as const)(
    'rejects shortcut/reversal %s -> %s', (from, to) => expect(() => assertLifecycleTransition(from, to)).toThrow('invalid rule lifecycle transition'));
  it('creates an append-only successor and promotion event', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ lifecycle_state: 'SHADOW' }] }).mockResolvedValueOnce({ rows: [{ passed: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 'next' }] }).mockResolvedValueOnce({ rows: [] });
    await expect(transitionRuleLifecycle({ query } as never, { ruleVersionId: 'old', to: 'ACTIVE', rationale: 'ratified', ruleBacktestId: 'bt' }))
      .resolves.toEqual({ ruleVersionId: 'next', created: true });
    expect(query).toHaveBeenCalledTimes(4);
  });
  it('blocks ACTIVE promotion on missing or failed evidence before writing', async () => {
    const missing = vi.fn().mockResolvedValueOnce({ rows: [{ lifecycle_state: 'SHADOW' }] });
    await expect(transitionRuleLifecycle({ query: missing } as never, { ruleVersionId: 'old', to: 'ACTIVE', rationale: 'x' })).rejects.toThrow('requires a passing backtest');
    expect(missing).toHaveBeenCalledTimes(1);
    const failed = vi.fn().mockResolvedValueOnce({ rows: [{ lifecycle_state: 'SHADOW' }] }).mockResolvedValueOnce({ rows: [{ passed: false }] });
    await expect(transitionRuleLifecycle({ query: failed } as never, { ruleVersionId: 'old', to: 'ACTIVE', rationale: 'x', ruleBacktestId: 'bt' })).rejects.toThrow('requires a passing backtest');
    expect(failed).toHaveBeenCalledTimes(2);
  });
});
