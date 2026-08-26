import { describe, expect, it, vi } from 'vitest';
import { resolveTransportEvidence } from '../../src/modules/evaluator/resolve-transport-evidence.js';

describe('resolveTransportEvidence', () => {
  it('is backward compatible when no shipment is linked', async () => {
    const query = vi.fn();
    await expect(resolveTransportEvidence({ query } as never, 'c', undefined)).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it('returns the tenant-scoped transport document', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ transport_document_id: 'td1' }] });
    await expect(resolveTransportEvidence({ query } as never, 'c', 's1')).resolves.toBe('td1');
    expect(query.mock.calls[0]?.[1]).toEqual(['s1', 'c']);
  });
  it('fails closed for cross-tenant/missing shipment or absent evidence', async () => {
    await expect(resolveTransportEvidence({ query: vi.fn().mockResolvedValue({ rows: [] }) } as never, 'c', 's1')).rejects.toThrow('shipment not found for tenant');
    await expect(resolveTransportEvidence({ query: vi.fn().mockResolvedValue({ rows: [{ transport_document_id: null }] }) } as never, 'c', 's1')).rejects.toThrow('transport evidence not found');
  });
});
