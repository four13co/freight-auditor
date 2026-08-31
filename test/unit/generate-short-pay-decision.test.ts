import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import { generateShortPayDecision, GenerateShortPayError } from '../../src/modules/payments/generate-short-pay-decision.js';

const clientId = '10000000-0000-4000-8000-000000000001';
const auditRunId = '20000000-0000-4000-8000-000000000002';

describe('generateShortPayDecision', () => {
  it('short-circuits with no query when shortPayEnabled is omitted (defaults false)', async () => {
    const query = vi.fn();
    const result = await generateShortPayDecision({ query } as unknown as PoolClient, { clientId, auditRunId });
    expect(result).toEqual({ decisionId: null, amountToPay: null, currency: null, findingIds: [], created: false });
    expect(query).not.toHaveBeenCalled();
  });

  it('short-circuits with no query when shortPayEnabled is explicitly false', async () => {
    const query = vi.fn();
    const result = await generateShortPayDecision({ query } as unknown as PoolClient, {
      clientId, auditRunId, shortPayEnabled: false,
    });
    expect(result.created).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed with GenerateShortPayError when the audit run is not SCORED', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    try {
      await generateShortPayDecision({ query } as unknown as PoolClient, { clientId, auditRunId, shortPayEnabled: true });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GenerateShortPayError);
      expect((err as GenerateShortPayError).code).toBe('AUDIT_RUN_NOT_SCORED');
    }
    expect(query).toHaveBeenCalledWith(expect.stringContaining("outcome = 'SCORED'"), [clientId, auditRunId]);
  });

  it('returns the existing decision without recomputing on a retry (idempotent short-circuit)', async () => {
    const decisionId = '30000000-0000-4000-8000-000000000003';
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ invoice_id: 'inv-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: decisionId, amount: '850.0000', currency: 'USD' }] });
    const result = await generateShortPayDecision({ query } as unknown as PoolClient, { clientId, auditRunId, shortPayEnabled: true });
    expect(result).toEqual({ decisionId, amountToPay: '850.0000', currency: 'USD', findingIds: [], created: false });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('computes and inserts a new short-pay decision and writes an audit event when none exists yet', async () => {
    const decisionId = '40000000-0000-4000-8000-000000000004';
    const findingId = '50000000-0000-4000-8000-000000000005';
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ invoice_id: 'inv-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ amount: '1000.0000', currency: 'USD' }] })
      .mockResolvedValueOnce({ rows: [{ id: findingId, currency: 'USD', varianceAmount: '150.0000' }] })
      .mockResolvedValueOnce({ rows: [{ id: decisionId }] })
      .mockResolvedValueOnce({ rows: [{ id: decisionId, created: true }] });
    const result = await generateShortPayDecision({ query } as unknown as PoolClient, { clientId, auditRunId, shortPayEnabled: true });
    expect(result).toEqual({
      decisionId, amountToPay: '850.0000', currency: 'USD', findingIds: [findingId], created: true,
    });
    expect(query).toHaveBeenCalledTimes(6);
    const insertCall = query.mock.calls[4]!;
    expect(insertCall[0]).toContain("'short_pay',$4,$5,'system'");
  });
});
