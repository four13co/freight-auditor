import { describe, expect, it, vi } from 'vitest';
import { handleOutboxMessageScanJob } from '../../src/jobs/outbox-message-scan-handler.js';
import { JOB_NAMES, JobPayloadValidationError } from '../../src/jobs/contracts.js';

const payload = {
  schemaVersion: 1 as const,
  requestedAt: '2026-09-01T00:00:00.000Z',
};

describe('handleOutboxMessageScanJob', () => {
  it('reclaims stale claims, then runs the scan, inside one internal tenant-scoped transaction, and merges both results', async () => {
    const reclaim = vi.fn().mockResolvedValue({ reclaimed: 2, failed: 1 });
    const scan = vi.fn().mockResolvedValue({ enqueued: 3 });
    const withTenantTx = vi.fn().mockImplementation(async (ctx, fn) => fn({} as never));
    const boss = { send: vi.fn() };

    const result = await handleOutboxMessageScanJob(boss as never, payload, { withTenantTx, reclaim, scan });

    expect(withTenantTx).toHaveBeenCalledWith({ internal: true }, expect.any(Function));
    expect(reclaim).toHaveBeenCalledWith({}, new Date(payload.requestedAt));
    expect(scan).toHaveBeenCalledWith({}, boss, new Date(payload.requestedAt));
    expect(result).toEqual({ enqueued: 3, reclaimed: 2, failed: 1 });
  });

  it('rejects an invalid payload before opening a transaction', async () => {
    const withTenantTx = vi.fn();
    const reclaim = vi.fn();
    const scan = vi.fn();
    await expect(handleOutboxMessageScanJob({} as never, { ...payload, requestedAt: 'nope' }, { withTenantTx, reclaim, scan }))
      .rejects.toBeInstanceOf(JobPayloadValidationError);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('registers under SCAN_OUTBOX_MESSAGES_V1', () => {
    expect(JOB_NAMES.SCAN_OUTBOX_MESSAGES_V1).toBe('freight.workflow.scan-outbox.v1');
  });
});
