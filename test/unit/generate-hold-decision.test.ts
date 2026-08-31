import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import { generateHoldDecision, GenerateHoldDecisionError } from '../../src/modules/payments/generate-hold-decision.js';

const clientId = '10000000-0000-4000-8000-000000000001';
const auditRunId = '20000000-0000-4000-8000-000000000002';

describe('generateHoldDecision', () => {
  it('short-circuits with no query when holdThenApprove is false', async () => {
    const query = vi.fn();
    const result = await generateHoldDecision({ query } as unknown as PoolClient, {
      clientId, auditRunId, holdThenApprove: false,
    });
    expect(result).toEqual({ decisionId: null, created: false });
    expect(query).not.toHaveBeenCalled();
  });

  it('defaults holdThenApprove to true when omitted', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(generateHoldDecision({ query } as unknown as PoolClient, { clientId, auditRunId }))
      .rejects.toBeInstanceOf(GenerateHoldDecisionError);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("outcome = 'SCORED'"), [clientId, auditRunId]);
  });

  it('fails closed with GenerateHoldDecisionError when the audit run is not SCORED', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    try {
      await generateHoldDecision({ query } as unknown as PoolClient, { clientId, auditRunId, holdThenApprove: true });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GenerateHoldDecisionError);
      expect((err as GenerateHoldDecisionError).code).toBe('AUDIT_RUN_NOT_SCORED');
    }
  });

  it('returns the existing decision without inserting on a retry (idempotent short-circuit)', async () => {
    const decisionId = '40000000-0000-4000-8000-000000000004';
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ invoice_id: 'inv-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: decisionId }] });
    const result = await generateHoldDecision({ query } as unknown as PoolClient, { clientId, auditRunId });
    expect(result).toEqual({ decisionId, created: false });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('inserts a new hold decision and writes an audit event when none exists yet', async () => {
    const decisionId = '30000000-0000-4000-8000-000000000003';
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ invoice_id: 'inv-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: decisionId }] })
      .mockResolvedValueOnce({ rows: [{ id: decisionId, created: true }] });
    const result = await generateHoldDecision({ query } as unknown as PoolClient, { clientId, auditRunId });
    expect(result).toEqual({ decisionId, created: true });
    expect(query).toHaveBeenCalledTimes(4);
    const insertCall = query.mock.calls[2]!;
    expect(insertCall[0]).toContain("'hold','system'");
  });
});
