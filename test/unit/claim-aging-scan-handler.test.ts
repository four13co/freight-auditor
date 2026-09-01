import { describe, expect, it, vi } from 'vitest';
import { handleClaimAgingScanJob } from '../../src/jobs/claim-aging-scan-handler.js';
import { JOB_NAMES, JobPayloadValidationError } from '../../src/jobs/contracts.js';

const payload = {
  schemaVersion: 1 as const,
  requestedAt: '2026-08-30T00:00:00.000Z',
};

describe('handleClaimAgingScanJob', () => {
  it('runs the scan inside an internal tenant-scoped transaction and returns counts', async () => {
    const scan = vi.fn().mockResolvedValue({ followUpEnqueued: 2, escalationEnqueued: 1 });
    const withTenantTx = vi.fn().mockImplementation(async (ctx, fn) => fn({} as never));
    const boss = { send: vi.fn() };

    const result = await handleClaimAgingScanJob(boss as never, payload, { withTenantTx, scan });

    expect(withTenantTx).toHaveBeenCalledWith({ internal: true }, expect.any(Function));
    expect(scan).toHaveBeenCalledWith({}, boss, new Date(payload.requestedAt));
    expect(result).toEqual({ followUpEnqueued: 2, escalationEnqueued: 1 });
  });

  it('rejects an invalid payload before opening a transaction', async () => {
    const withTenantTx = vi.fn();
    const scan = vi.fn();
    await expect(handleClaimAgingScanJob({} as never, { ...payload, requestedAt: 'nope' }, { withTenantTx, scan }))
      .rejects.toBeInstanceOf(JobPayloadValidationError);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('registers under SCAN_CLAIM_AGING_V1', () => {
    expect(JOB_NAMES.SCAN_CLAIM_AGING_V1).toBe('freight.claims.scan-aging.v1');
  });
});
