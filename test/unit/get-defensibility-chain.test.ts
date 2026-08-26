import { describe, expect, it, vi } from 'vitest';
import { getDefensibilityChain } from '../../src/modules/findings/get-defensibility-chain.js';

describe('getDefensibilityChain', () => {
  it('returns null without leaking a cross-tenant finding', async () => {
    await expect(getDefensibilityChain({ query: vi.fn().mockResolvedValue({ rows: [] }) } as never, 'c', 'f')).resolves.toBeNull();
  });
  it('returns the full citation chain and every aligned member', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'f', audit_run_id: 'r', classification: 'variance', variance_amount: '2.0000', currency: 'USD',
      criterion_id: 'c1', criterion_key: 'CONTRACT.RATE_VARIANCE', rule_version_id: 'rv', ast_hash: 'hash', alignment_id: 'a',
      clause_id: 'cl', clause_ref: '4.2', page_ref: '7', rate_cell_id: 'rc', cell_ref: 'B12', source_document_id: 'sd', sha256: 'sha', storage_uri: 'r2://doc',
      transport_document_id: 'td', document_number: 'BL1', document_type: 'BOL', transport_source_document_id: 'tsd' }] })
      .mockResolvedValueOnce({ rows: [{ charge_fact_id: 'b1', expected_charge_id: null }, { charge_fact_id: null, expected_charge_id: 'e1' }] });
    const chain = await getDefensibilityChain({ query } as never, 'tenant', 'f');
    expect(chain?.criterion.key).toBe('CONTRACT.RATE_VARIANCE');
    expect(chain?.clause?.reference).toBe('4.2');
    expect(chain?.rateCell?.reference).toBe('B12');
    expect(chain?.transportDocument?.number).toBe('BL1');
    expect(chain?.contributors).toEqual({ billedChargeFactIds: ['b1'], expectedChargeIds: ['e1'] });
    expect(query.mock.calls[0]?.[1]).toEqual(['f', 'tenant']);
  });
});
