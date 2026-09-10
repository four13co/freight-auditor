import { describe, expect, it, vi } from 'vitest';
import { assertLifecycleTransition, transitionRuleLifecycle } from '../../src/modules/rule-engine/transition-rule-lifecycle.js';

describe('rule lifecycle transitions', () => {
  it.each([['PROPOSED', 'SHADOW'], ['SHADOW', 'ACTIVE'], ['ACTIVE', 'DEPRECATED'], ['ACTIVE', 'QUARANTINED'], ['QUARANTINED', 'SHADOW']] as const)(
    'allows governed edge %s -> %s', (from, to) => expect(() => assertLifecycleTransition(from, to)).not.toThrow());
  it.each([['PROPOSED', 'ACTIVE'], ['ACTIVE', 'SHADOW'], ['DEPRECATED', 'ACTIVE']] as const)(
    'rejects shortcut/reversal %s -> %s', (from, to) => expect(() => assertLifecycleTransition(from, to)).toThrow('invalid rule lifecycle transition'));
  it('creates an append-only successor and promotion event', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ lifecycle_state: 'SHADOW' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'next' }] }).mockResolvedValueOnce({ rows: [] });
    await expect(transitionRuleLifecycle({ query } as never, { ruleVersionId: 'old', to: 'ACTIVE', rationale: 'ratified' }))
      .resolves.toEqual({ ruleVersionId: 'next', created: true });
    expect(query).toHaveBeenCalledTimes(3);
  });
  // 86e367r9q: this function no longer opines on evidence for a SHADOW->ACTIVE
  // transition -- promoteShadowRule (the only to:'ACTIVE' caller) now gates
  // that itself via dual-control (see promote-shadow-rule.test.ts). rule_backtest
  // is a GLOBAL-table-incompatible dependency this function used to hard-require
  // and could never actually be satisfied in production; the old "blocks ACTIVE
  // promotion on missing or failed evidence" test encoded exactly that broken
  // gate and has no successor here -- it's asserting the removed bug, not a
  // guarantee this fix preserves.
});
