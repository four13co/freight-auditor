import { describe, expect, it, vi } from 'vitest';
import { registerJobConsumers } from '../../src/jobs/boss.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';

describe('registerJobConsumers', () => {
  it('registers a work handler for every claim job and the aging scan tick', async () => {
    const work = vi.fn().mockResolvedValue('worker-id');
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };

    await registerJobConsumers(boss as never);

    const registeredNames = work.mock.calls.map(([name]) => name);
    expect(registeredNames).toContain(JOB_NAMES.FOLLOW_UP_CLAIM_V1);
    expect(registeredNames).toContain(JOB_NAMES.ESCALATE_CLAIM_V1);
    expect(registeredNames).toContain(JOB_NAMES.SCAN_CLAIM_AGING_V1);
  });

  it('schedules the aging scan tick on a recurring cron', async () => {
    const work = vi.fn().mockResolvedValue('worker-id');
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };

    await registerJobConsumers(boss as never);

    expect(schedule).toHaveBeenCalledWith(
      JOB_NAMES.SCAN_CLAIM_AGING_V1,
      expect.any(String),
      expect.objectContaining({ schemaVersion: 1 }),
    );
  });

  it('actually invokes handleFollowUp with the job payload inside a tenant-scoped transaction for the correct clientId', async () => {
    let followUpWorker: ((jobs: unknown[]) => Promise<void>) | undefined;
    const work = vi.fn().mockImplementation(async (name: string, handler: (jobs: unknown[]) => Promise<void>) => {
      if (name === JOB_NAMES.FOLLOW_UP_CLAIM_V1) followUpWorker = handler;
      return 'worker-id';
    });
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };
    const fakeClient = { marker: 'tenant-scoped-client' };
    const withTenantTx = vi.fn().mockImplementation(async (ctx, fn) => fn(fakeClient));
    const handleFollowUp = vi.fn().mockResolvedValue({ claimId: 'c1', auditEventId: 'a1', created: true });

    await registerJobConsumers(boss as never, {
      withTenantTx, handleFollowUp, handleEscalation: vi.fn(), handleScan: vi.fn(),
    });

    expect(followUpWorker).toBeDefined();
    const jobData = { clientId: 'client-1', claimId: 'claim-1' };
    await followUpWorker!([{ id: 'job-1', data: jobData, expireInSeconds: 900 }]);

    expect(withTenantTx).toHaveBeenCalledWith({ clientIds: ['client-1'] }, expect.any(Function));
    expect(handleFollowUp).toHaveBeenCalledWith(fakeClient, jobData);
  });

  it('actually invokes handleEscalation with the job payload inside a tenant-scoped transaction for the correct clientId', async () => {
    let escalationWorker: ((jobs: unknown[]) => Promise<void>) | undefined;
    const work = vi.fn().mockImplementation(async (name: string, handler: (jobs: unknown[]) => Promise<void>) => {
      if (name === JOB_NAMES.ESCALATE_CLAIM_V1) escalationWorker = handler;
      return 'worker-id';
    });
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };
    const fakeClient = { marker: 'tenant-scoped-client' };
    const withTenantTx = vi.fn().mockImplementation(async (ctx, fn) => fn(fakeClient));
    const handleEscalation = vi.fn().mockResolvedValue({ claimId: 'c1', auditEventId: 'a1', created: true });

    await registerJobConsumers(boss as never, {
      withTenantTx, handleFollowUp: vi.fn(), handleEscalation, handleScan: vi.fn(),
    });

    expect(escalationWorker).toBeDefined();
    const jobData = { clientId: 'client-2', claimId: 'claim-2' };
    await escalationWorker!([{ id: 'job-2', data: jobData, expireInSeconds: 900 }]);

    expect(withTenantTx).toHaveBeenCalledWith({ clientIds: ['client-2'] }, expect.any(Function));
    expect(handleEscalation).toHaveBeenCalledWith(fakeClient, jobData);
  });

  it('actually invokes handleScan with the boss instance and job payload for the scan tick', async () => {
    let scanWorker: ((jobs: unknown[]) => Promise<void>) | undefined;
    const work = vi.fn().mockImplementation(async (name: string, handler: (jobs: unknown[]) => Promise<void>) => {
      if (name === JOB_NAMES.SCAN_CLAIM_AGING_V1) scanWorker = handler;
      return 'worker-id';
    });
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };
    const handleScan = vi.fn().mockResolvedValue({ followUpEnqueued: 1, escalationEnqueued: 0 });

    await registerJobConsumers(boss as never, {
      withTenantTx: vi.fn(), handleFollowUp: vi.fn(), handleEscalation: vi.fn(), handleScan,
    });

    expect(scanWorker).toBeDefined();
    const jobData = { schemaVersion: 1, requestedAt: '2026-08-30T00:00:00.000Z' };
    await scanWorker!([{ id: 'job-3', data: jobData, expireInSeconds: 900 }]);

    expect(handleScan).toHaveBeenCalledWith(boss, jobData);
  });
});
