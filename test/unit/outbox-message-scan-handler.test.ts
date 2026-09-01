import { describe, expect, it, vi } from 'vitest';
import { handleOutboxMessageScanJob } from '../../src/jobs/outbox-message-scan-handler.js';
import { JOB_NAMES, JobPayloadValidationError } from '../../src/jobs/contracts.js';

const payload = {
  schemaVersion: 1 as const,
  requestedAt: '2026-09-01T00:00:00.000Z',
};

describe('handleOutboxMessageScanJob', () => {
  it('runs the scan inside an internal tenant-scoped transaction and returns the enqueued count', async () => {
    const scan = vi.fn().mockResolvedValue({ enqueued: 3 });
    const withTenantTx = vi.fn().mockImplementation(async (ctx, fn) => fn({} as never));
    const boss = { send: vi.fn() };

    const result = await handleOutboxMessageScanJob(boss as never, payload, { withTenantTx, scan });

    expect(withTenantTx).toHaveBeenCalledWith({ internal: true }, expect.any(Function));
    expect(scan).toHaveBeenCalledWith({}, boss, new Date(payload.requestedAt));
    expect(result).toEqual({ enqueued: 3 });
  });

  it('rejects an invalid payload before opening a transaction', async () => {
    const withTenantTx = vi.fn();
    const scan = vi.fn();
    await expect(handleOutboxMessageScanJob({} as never, { ...payload, requestedAt: 'nope' }, { withTenantTx, scan }))
      .rejects.toBeInstanceOf(JobPayloadValidationError);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('registers under SCAN_OUTBOX_MESSAGES_V1', () => {
    expect(JOB_NAMES.SCAN_OUTBOX_MESSAGES_V1).toBe('freight.workflow.scan-outbox.v1');
  });
});
