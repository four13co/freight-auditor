import { describe, expect, it, vi } from 'vitest';
import { resolvePromotionPolicy, upsertPromotionPolicy } from '../../src/modules/rule-engine/promotion-policy.js';

describe('promotion policy', () => {
  it('rejects invalid thresholds before querying', async () => {
    const query = vi.fn();
    await expect(upsertPromotionPolicy({ query } as never, { clientId: crypto.randomUUID(), ruleType: 'STRUCTURAL', n1Confirm: 5, n2Confirm: 3, maxReversals: 1 }))
      .rejects.toThrow('n2Confirm must be greater');
    expect(query).not.toHaveBeenCalled();
  });
  it('resolves client/type-specific policy ahead of fallbacks', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ client_id: 'c', rule_type: 'STRUCTURAL', n1_confirm: 3, n2_confirm: 5, max_reversals: 1 }] });
    await expect(resolvePromotionPolicy({ query } as never, 'c', 'STRUCTURAL')).resolves.toMatchObject({ clientId: 'c', n2Confirm: 5 });
    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY (client_id IS NOT NULL) DESC');
  });
  it('upserts a valid tenant policy', async () => {
    const id = crypto.randomUUID();
    const query = vi.fn().mockResolvedValue({ rows: [{ client_id: id, rule_type: 'STRUCTURAL', n1_confirm: 2, n2_confirm: 4, max_reversals: 0 }] });
    await expect(upsertPromotionPolicy({ query } as never, { clientId: id, ruleType: 'STRUCTURAL', n1Confirm: 2, n2Confirm: 4, maxReversals: 0 }))
      .resolves.toMatchObject({ clientId: id, n1Confirm: 2, maxReversals: 0 });
  });
});
