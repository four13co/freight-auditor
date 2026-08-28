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
});
