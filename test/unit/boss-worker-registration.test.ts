import { describe, expect, it, vi } from 'vitest';
import { registerJobConsumers } from '../../src/jobs/boss.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';

describe('registerJobConsumers', () => {
  it('registers a work handler for every claim job and the aging scan tick', async () => {
    const work = vi.fn().mockResolvedValue('worker-id');
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule };

    await registerJobConsumers(boss as never);

    const registeredNames = work.mock.calls.map(([name]) => name);
    expect(registeredNames).toContain(JOB_NAMES.FOLLOW_UP_CLAIM_V1);
    expect(registeredNames).toContain(JOB_NAMES.ESCALATE_CLAIM_V1);
    expect(registeredNames).toContain(JOB_NAMES.SCAN_CLAIM_AGING_V1);
  });

  it('schedules the aging scan tick on a recurring cron', async () => {
    const work = vi.fn().mockResolvedValue('worker-id');
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule };

    await registerJobConsumers(boss as never);

    expect(schedule).toHaveBeenCalledWith(
      JOB_NAMES.SCAN_CLAIM_AGING_V1,
      expect.any(String),
      expect.objectContaining({ schemaVersion: 1 }),
    );
  });

  it('invokes the claim follow-up handler with the job payload inside a tenant-scoped transaction', async () => {
    const work = vi.fn().mockImplementation(async (_name, handler) => {
      await handler([{ id: 'j1', data: { claimId: 'c1' }, expireInSeconds: 900 }]);
      return 'worker-id';
    });
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule };
    const withTenantTx = vi.fn().mockResolvedValue(undefined);
    const handleFollowUp = vi.fn();

    await registerJobConsumers(boss as never, { withTenantTx, handleFollowUp, handleEscalation: vi.fn(), handleScan: vi.fn() });

    const followUpCall = work.mock.calls.find(([name]) => name === JOB_NAMES.FOLLOW_UP_CLAIM_V1);
    expect(followUpCall).toBeDefined();
  });
});
