import { describe, expect, it, vi } from 'vitest';
import { quarantineOnReversal } from '../../src/modules/rule-engine/quarantine-on-reversal.js';

describe('quarantineOnReversal', () => {
  it('keeps an ACTIVE rule when reversals are within policy', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ rule_type: 'STRUCTURAL', lifecycle_state: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [{ client_id: 'c', rule_type: 'STRUCTURAL', n1_confirm: 3, n2_confirm: 5, max_reversals: 1 }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });
    await expect(quarantineOnReversal({ query } as never, { clientId: 'c', criterionId: 'crit', ruleVersionId: 'rv' }))
      .resolves.toEqual({ quarantined: false, ruleVersionId: 'rv' });
    expect(query).toHaveBeenCalledTimes(3);
  });
  it('fails closed when the target is not ACTIVE', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ rule_type: 'STRUCTURAL', lifecycle_state: 'SHADOW' }] });
    await expect(quarantineOnReversal({ query } as never, { clientId: 'c', criterionId: 'crit', ruleVersionId: 'rv' })).rejects.toThrow('requires ACTIVE');
  });
  it('creates a quarantined successor after the policy cap is exceeded', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ rule_type: 'STRUCTURAL', lifecycle_state: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [{ client_id: 'c', rule_type: 'STRUCTURAL', n1_confirm: 3, n2_confirm: 5, max_reversals: 1 }] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [{ lifecycle_state: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'quarantined-rv' }] }).mockResolvedValueOnce({ rows: [] });
    await expect(quarantineOnReversal({ query } as never, { clientId: 'c', criterionId: 'crit', ruleVersionId: 'rv' }))
      .resolves.toEqual({ quarantined: true, ruleVersionId: 'quarantined-rv' });
    expect(query.mock.calls[5]?.[1]).toContain('Reversal threshold exceeded: 2 > 1');
  });
});
