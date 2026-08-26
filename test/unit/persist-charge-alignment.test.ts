import { describe, expect, it, vi } from 'vitest';
import { persistChargeAlignment } from '../../src/modules/rate-engine/persist-charge-alignment.js';

const attribution = { level: 'GROUP' as const, key: 'fuel', currency: 'USD', billedIds: ['b1', 'b2'], expectedIds: ['e1'],
  billedTotal: '12.0000', expectedTotal: '10.0000', varianceAmount: '2.0000', direction: 'OVERCHARGE' as const };

describe('persistChargeAlignment', () => {
  it('persists the alignment and every contributing member', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'a1' }] }).mockResolvedValue({ rows: [] });
    await expect(persistChargeAlignment({ query } as never, { clientId: 'c', auditRunId: 'r', attribution })).resolves.toBe('a1');
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.slice(1).map((call) => call[1]?.[2])).toEqual(['b1', 'b2', 'e1']);
  });

  it('returns the immutable row on an exact retry', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'a1',
      billed_total: '12.0000', expected_total: '10.0000', variance_amount: '2.0000' }] }).mockResolvedValue({ rows: [] });
    await expect(persistChargeAlignment({ query } as never, { clientId: 'c', auditRunId: 'r', attribution })).resolves.toBe('a1');
  });

  it('fails closed when a retry changes the financial result', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'a1',
      billed_total: '99.0000', expected_total: '10.0000', variance_amount: '89.0000' }] });
    await expect(persistChargeAlignment({ query } as never, { clientId: 'c', auditRunId: 'r', attribution }))
      .rejects.toThrow('charge-alignment source conflict');
  });
});
