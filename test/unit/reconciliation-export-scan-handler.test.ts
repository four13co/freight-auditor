import { describe, expect, it, vi } from 'vitest';
import { handleReconciliationExportScanJob } from '../../src/jobs/reconciliation-export-scan-handler.js';
import { JOB_NAMES, JobPayloadValidationError } from '../../src/jobs/contracts.js';

const payload = {
  schemaVersion: 1 as const,
  requestedAt: '2026-09-01T00:00:00.000Z',
};

describe('handleReconciliationExportScanJob', () => {
  it('runs the scan inside an internal tenant-scoped transaction and returns the enqueued count', async () => {
    const scan = vi.fn().mockResolvedValue({ enqueued: 2 });
    const withTenantTx = vi.fn().mockImplementation(async (ctx, fn) => fn({} as never));
    const boss = { send: vi.fn() };

    const result = await handleReconciliationExportScanJob(boss as never, payload, { withTenantTx, scan });

    expect(withTenantTx).toHaveBeenCalledWith({ internal: true }, expect.any(Function));
    expect(scan).toHaveBeenCalledWith({}, boss, new Date(payload.requestedAt));
    expect(result).toEqual({ enqueued: 2 });
  });

  it('rejects an invalid payload before opening a transaction', async () => {
    const withTenantTx = vi.fn();
    const scan = vi.fn();
    await expect(handleReconciliationExportScanJob({} as never, { ...payload, requestedAt: 'nope' }, { withTenantTx, scan }))
      .rejects.toBeInstanceOf(JobPayloadValidationError);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('registers under SCAN_RECONCILIATION_EXPORTS_V1', () => {
    expect(JOB_NAMES.SCAN_RECONCILIATION_EXPORTS_V1).toBe('freight.claims.scan-reconciliation-exports.v1');
  });
});
