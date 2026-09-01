import { describe, expect, it, vi } from 'vitest';
import { handleWorkflowCommandScanJob } from '../../src/jobs/workflow-command-scan-handler.js';
import { JOB_NAMES, JobPayloadValidationError } from '../../src/jobs/contracts.js';

const payload = {
  schemaVersion: 1 as const,
  requestedAt: '2026-09-01T00:00:00.000Z',
};

describe('handleWorkflowCommandScanJob', () => {
  it('runs the scan inside an internal tenant-scoped transaction and returns the enqueued count', async () => {
    const scan = vi.fn().mockResolvedValue({ enqueued: 4 });
    const withTenantTx = vi.fn().mockImplementation(async (ctx, fn) => fn({} as never));
    const boss = { send: vi.fn() };

    const result = await handleWorkflowCommandScanJob(boss as never, payload, { withTenantTx, scan });

    expect(withTenantTx).toHaveBeenCalledWith({ internal: true }, expect.any(Function));
    expect(scan).toHaveBeenCalledWith({}, boss, new Date(payload.requestedAt));
    expect(result).toEqual({ enqueued: 4 });
  });

  it('rejects an invalid payload before opening a transaction', async () => {
    const withTenantTx = vi.fn();
    const scan = vi.fn();
    await expect(handleWorkflowCommandScanJob({} as never, { ...payload, requestedAt: 'nope' }, { withTenantTx, scan }))
      .rejects.toBeInstanceOf(JobPayloadValidationError);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('registers under SCAN_WORKFLOW_COMMANDS_V1', () => {
    expect(JOB_NAMES.SCAN_WORKFLOW_COMMANDS_V1).toBe('freight.workflow.scan-commands.v1');
  });
});
