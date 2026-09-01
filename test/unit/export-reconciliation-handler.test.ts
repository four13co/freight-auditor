import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { handleExportReconciliationJob } from '../../src/jobs/export-reconciliation-handler.js';
import { JOB_NAMES, JobPayloadValidationError } from '../../src/jobs/contracts.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const EXPORT_ID = '20000000-0000-4000-8000-000000000001';

const basePayload = {
  schemaVersion: 1 as const,
  clientId: CLIENT_ID,
  idempotencyKey: `reconciliation-export:${EXPORT_ID}`,
  requestedAt: '2026-09-01T00:00:00.000Z',
  exportId: EXPORT_ID,
};

describe('handleExportReconciliationJob', () => {
  it('computes the portfolio reconciliation and marks the export completed with the result', async () => {
    const result = [{ currency: 'USD', claimed: '100.0000', recovered: '100.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '0.0000', reconciles: true }];
    const compute = vi.fn().mockResolvedValue(result);
    const complete = vi.fn().mockResolvedValue({ found: true });
    const fail = vi.fn();
    const client = {} as unknown as pg.PoolClient;

    await handleExportReconciliationJob(client, basePayload, { compute, complete, fail });

    expect(compute).toHaveBeenCalledWith(client, { clientId: CLIENT_ID });
    expect(complete).toHaveBeenCalledWith(client, { clientId: CLIENT_ID, exportId: EXPORT_ID, result });
    expect(fail).not.toHaveBeenCalled();
  });

  it('marks the export failed with a generic reason (never the raw error) and does not rethrow', async () => {
    const compute = vi.fn().mockRejectedValue(new Error('SELECT failed: connection string leaked here'));
    const complete = vi.fn();
    const fail = vi.fn().mockResolvedValue({ found: true });
    const client = {} as unknown as pg.PoolClient;

    await expect(handleExportReconciliationJob(client, basePayload, { compute, complete, fail })).resolves.toBeUndefined();

    expect(fail).toHaveBeenCalledTimes(1);
    const failCall = fail.mock.calls[0]![1] as { clientId: string; exportId: string; error: string };
    expect(failCall.clientId).toBe(CLIENT_ID);
    expect(failCall.exportId).toBe(EXPORT_ID);
    expect(failCall.error).not.toContain('connection string');
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload before computing anything', async () => {
    const compute = vi.fn();
    const complete = vi.fn();
    const fail = vi.fn();
    const client = {} as unknown as pg.PoolClient;

    await expect(handleExportReconciliationJob(client, { ...basePayload, exportId: undefined }, { compute, complete, fail }))
      .rejects.toBeInstanceOf(JobPayloadValidationError);
    expect(compute).not.toHaveBeenCalled();
  });

  it('registers under EXPORT_RECONCILIATION_V1', () => {
    expect(JOB_NAMES.EXPORT_RECONCILIATION_V1).toBe('freight.claims.export-reconciliation.v1');
  });
});
