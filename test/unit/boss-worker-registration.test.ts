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
      handleWorkflowCommandScan: vi.fn(), handleRunWorkflowCommand: vi.fn(),
      handleOutboxMessageScan: vi.fn(), handleDeliverOutboxMessage: vi.fn(),
      handleReconciliationExportScan: vi.fn(), handleExportReconciliation: vi.fn(),
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
      handleWorkflowCommandScan: vi.fn(), handleRunWorkflowCommand: vi.fn(),
      handleOutboxMessageScan: vi.fn(), handleDeliverOutboxMessage: vi.fn(),
      handleReconciliationExportScan: vi.fn(), handleExportReconciliation: vi.fn(),
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
      handleWorkflowCommandScan: vi.fn(), handleRunWorkflowCommand: vi.fn(),
      handleOutboxMessageScan: vi.fn(), handleDeliverOutboxMessage: vi.fn(),
      handleReconciliationExportScan: vi.fn(), handleExportReconciliation: vi.fn(),
    });

    expect(scanWorker).toBeDefined();
    const jobData = { schemaVersion: 1, requestedAt: '2026-08-30T00:00:00.000Z' };
    await scanWorker!([{ id: 'job-3', data: jobData, expireInSeconds: 900 }]);

    expect(handleScan).toHaveBeenCalledWith(boss, jobData);
  });

  it('registers a work handler for the workflow-command scan tick and the per-command runner', async () => {
    const work = vi.fn().mockResolvedValue('worker-id');
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };

    await registerJobConsumers(boss as never);

    const registeredNames = work.mock.calls.map(([name]) => name);
    expect(registeredNames).toContain(JOB_NAMES.SCAN_WORKFLOW_COMMANDS_V1);
    expect(registeredNames).toContain(JOB_NAMES.RUN_WORKFLOW_COMMAND_V1);
  });

  it('schedules the workflow-command scan tick on a recurring cron', async () => {
    const work = vi.fn().mockResolvedValue('worker-id');
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };

    await registerJobConsumers(boss as never);

    expect(schedule).toHaveBeenCalledWith(
      JOB_NAMES.SCAN_WORKFLOW_COMMANDS_V1,
      expect.any(String),
      expect.objectContaining({ schemaVersion: 1 }),
    );
  });

  it('actually invokes handleWorkflowCommandScan with the boss instance and job payload for the scan tick', async () => {
    let scanWorker: ((jobs: unknown[]) => Promise<void>) | undefined;
    const work = vi.fn().mockImplementation(async (name: string, handler: (jobs: unknown[]) => Promise<void>) => {
      if (name === JOB_NAMES.SCAN_WORKFLOW_COMMANDS_V1) scanWorker = handler;
      return 'worker-id';
    });
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };
    const handleWorkflowCommandScan = vi.fn().mockResolvedValue({ enqueued: 3 });

    await registerJobConsumers(boss as never, {
      withTenantTx: vi.fn(), handleFollowUp: vi.fn(), handleEscalation: vi.fn(), handleScan: vi.fn(),
      handleWorkflowCommandScan, handleRunWorkflowCommand: vi.fn(),
      handleOutboxMessageScan: vi.fn(), handleDeliverOutboxMessage: vi.fn(),
      handleReconciliationExportScan: vi.fn(), handleExportReconciliation: vi.fn(),
    });

    expect(scanWorker).toBeDefined();
    const jobData = { schemaVersion: 1, requestedAt: '2026-09-01T00:00:00.000Z' };
    await scanWorker!([{ id: 'job-4', data: jobData, expireInSeconds: 900 }]);

    expect(handleWorkflowCommandScan).toHaveBeenCalledWith(boss, jobData);
  });

  it('actually invokes handleRunWorkflowCommand with the job payload inside a tenant-scoped transaction for the correct clientId', async () => {
    let runWorker: ((jobs: unknown[]) => Promise<void>) | undefined;
    const work = vi.fn().mockImplementation(async (name: string, handler: (jobs: unknown[]) => Promise<void>) => {
      if (name === JOB_NAMES.RUN_WORKFLOW_COMMAND_V1) runWorker = handler;
      return 'worker-id';
    });
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };
    const fakeClient = { marker: 'tenant-scoped-client' };
    const withTenantTx = vi.fn().mockImplementation(async (ctx, fn) => fn(fakeClient));
    const handleRunWorkflowCommand = vi.fn().mockResolvedValue(undefined);

    await registerJobConsumers(boss as never, {
      withTenantTx, handleFollowUp: vi.fn(), handleEscalation: vi.fn(), handleScan: vi.fn(),
      handleWorkflowCommandScan: vi.fn(), handleRunWorkflowCommand,
      handleOutboxMessageScan: vi.fn(), handleDeliverOutboxMessage: vi.fn(),
      handleReconciliationExportScan: vi.fn(), handleExportReconciliation: vi.fn(),
    });

    expect(runWorker).toBeDefined();
    const jobData = { clientId: 'client-3', commandId: 'command-1' };
    await runWorker!([{ id: 'job-5', data: jobData, expireInSeconds: 900 }]);

    expect(withTenantTx).toHaveBeenCalledWith({ clientIds: ['client-3'] }, expect.any(Function));
    expect(handleRunWorkflowCommand).toHaveBeenCalledWith(fakeClient, jobData);
  });

  it('registers a work handler for the outbox-message scan tick and the per-message deliverer', async () => {
    const work = vi.fn().mockResolvedValue('worker-id');
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };

    await registerJobConsumers(boss as never);

    const registeredNames = work.mock.calls.map(([name]) => name);
    expect(registeredNames).toContain(JOB_NAMES.SCAN_OUTBOX_MESSAGES_V1);
    expect(registeredNames).toContain(JOB_NAMES.DELIVER_OUTBOX_MESSAGE_V1);
  });

  it('schedules the outbox-message scan tick on a recurring cron', async () => {
    const work = vi.fn().mockResolvedValue('worker-id');
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };

    await registerJobConsumers(boss as never);

    expect(schedule).toHaveBeenCalledWith(
      JOB_NAMES.SCAN_OUTBOX_MESSAGES_V1,
      expect.any(String),
      expect.objectContaining({ schemaVersion: 1 }),
    );
  });

  it('actually invokes handleOutboxMessageScan with the boss instance and job payload for the scan tick', async () => {
    let scanWorker: ((jobs: unknown[]) => Promise<void>) | undefined;
    const work = vi.fn().mockImplementation(async (name: string, handler: (jobs: unknown[]) => Promise<void>) => {
      if (name === JOB_NAMES.SCAN_OUTBOX_MESSAGES_V1) scanWorker = handler;
      return 'worker-id';
    });
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };
    const handleOutboxMessageScan = vi.fn().mockResolvedValue({ enqueued: 2 });

    await registerJobConsumers(boss as never, {
      withTenantTx: vi.fn(), handleFollowUp: vi.fn(), handleEscalation: vi.fn(), handleScan: vi.fn(),
      handleWorkflowCommandScan: vi.fn(), handleRunWorkflowCommand: vi.fn(),
      handleOutboxMessageScan, handleDeliverOutboxMessage: vi.fn(),
      handleReconciliationExportScan: vi.fn(), handleExportReconciliation: vi.fn(),
    });

    expect(scanWorker).toBeDefined();
    const jobData = { schemaVersion: 1, requestedAt: '2026-09-01T00:00:00.000Z' };
    await scanWorker!([{ id: 'job-6', data: jobData, expireInSeconds: 900 }]);

    expect(handleOutboxMessageScan).toHaveBeenCalledWith(boss, jobData);
  });

  it('actually invokes handleDeliverOutboxMessage with the job payload inside a tenant-scoped transaction for the correct clientId', async () => {
    let deliverWorker: ((jobs: unknown[]) => Promise<void>) | undefined;
    const work = vi.fn().mockImplementation(async (name: string, handler: (jobs: unknown[]) => Promise<void>) => {
      if (name === JOB_NAMES.DELIVER_OUTBOX_MESSAGE_V1) deliverWorker = handler;
      return 'worker-id';
    });
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };
    const fakeClient = { marker: 'tenant-scoped-client' };
    const withTenantTx = vi.fn().mockImplementation(async (ctx, fn) => fn(fakeClient));
    const handleDeliverOutboxMessage = vi.fn().mockResolvedValue(undefined);

    await registerJobConsumers(boss as never, {
      withTenantTx, handleFollowUp: vi.fn(), handleEscalation: vi.fn(), handleScan: vi.fn(),
      handleWorkflowCommandScan: vi.fn(), handleRunWorkflowCommand: vi.fn(),
      handleOutboxMessageScan: vi.fn(), handleDeliverOutboxMessage,
      handleReconciliationExportScan: vi.fn(), handleExportReconciliation: vi.fn(),
    });

    expect(deliverWorker).toBeDefined();
    const jobData = { clientId: 'client-4', outboxMessageId: 'outbox-1' };
    await deliverWorker!([{ id: 'job-7', data: jobData, expireInSeconds: 900 }]);

    expect(withTenantTx).toHaveBeenCalledWith({ clientIds: ['client-4'] }, expect.any(Function));
    expect(handleDeliverOutboxMessage).toHaveBeenCalledWith(fakeClient, jobData);
  });

  it('registers a work handler for the reconciliation-export scan tick and the per-export job', async () => {
    const work = vi.fn().mockResolvedValue('worker-id');
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };

    await registerJobConsumers(boss as never);

    const registeredNames = work.mock.calls.map(([name]) => name);
    expect(registeredNames).toContain(JOB_NAMES.SCAN_RECONCILIATION_EXPORTS_V1);
    expect(registeredNames).toContain(JOB_NAMES.EXPORT_RECONCILIATION_V1);
  });

  it('schedules the reconciliation-export scan tick on a recurring cron', async () => {
    const work = vi.fn().mockResolvedValue('worker-id');
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };

    await registerJobConsumers(boss as never);

    expect(schedule).toHaveBeenCalledWith(
      JOB_NAMES.SCAN_RECONCILIATION_EXPORTS_V1,
      expect.any(String),
      expect.objectContaining({ schemaVersion: 1 }),
    );
  });

  it('actually invokes handleReconciliationExportScan with the boss instance and job payload for the scan tick', async () => {
    let scanWorker: ((jobs: unknown[]) => Promise<void>) | undefined;
    const work = vi.fn().mockImplementation(async (name: string, handler: (jobs: unknown[]) => Promise<void>) => {
      if (name === JOB_NAMES.SCAN_RECONCILIATION_EXPORTS_V1) scanWorker = handler;
      return 'worker-id';
    });
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };
    const handleReconciliationExportScan = vi.fn().mockResolvedValue({ enqueued: 2 });

    await registerJobConsumers(boss as never, {
      withTenantTx: vi.fn(), handleFollowUp: vi.fn(), handleEscalation: vi.fn(), handleScan: vi.fn(),
      handleWorkflowCommandScan: vi.fn(), handleRunWorkflowCommand: vi.fn(),
      handleOutboxMessageScan: vi.fn(), handleDeliverOutboxMessage: vi.fn(),
      handleReconciliationExportScan, handleExportReconciliation: vi.fn(),
    });

    expect(scanWorker).toBeDefined();
    const jobData = { schemaVersion: 1, requestedAt: '2026-09-01T00:00:00.000Z' };
    await scanWorker!([{ id: 'job-8', data: jobData, expireInSeconds: 900 }]);

    expect(handleReconciliationExportScan).toHaveBeenCalledWith(boss, jobData);
  });

  it('actually invokes handleExportReconciliation with the job payload inside a tenant-scoped transaction for the correct clientId', async () => {
    let exportWorker: ((jobs: unknown[]) => Promise<void>) | undefined;
    const work = vi.fn().mockImplementation(async (name: string, handler: (jobs: unknown[]) => Promise<void>) => {
      if (name === JOB_NAMES.EXPORT_RECONCILIATION_V1) exportWorker = handler;
      return 'worker-id';
    });
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { work, schedule, send: vi.fn() };
    const fakeClient = { marker: 'tenant-scoped-client' };
    const withTenantTx = vi.fn().mockImplementation(async (ctx, fn) => fn(fakeClient));
    const handleExportReconciliation = vi.fn().mockResolvedValue(undefined);

    await registerJobConsumers(boss as never, {
      withTenantTx, handleFollowUp: vi.fn(), handleEscalation: vi.fn(), handleScan: vi.fn(),
      handleWorkflowCommandScan: vi.fn(), handleRunWorkflowCommand: vi.fn(),
      handleOutboxMessageScan: vi.fn(), handleDeliverOutboxMessage: vi.fn(),
      handleReconciliationExportScan: vi.fn(), handleExportReconciliation,
    });

    expect(exportWorker).toBeDefined();
    const jobData = { clientId: 'client-5', exportId: 'export-1' };
    await exportWorker!([{ id: 'job-9', data: jobData, expireInSeconds: 900 }]);

    expect(withTenantTx).toHaveBeenCalledWith({ clientIds: ['client-5'] }, expect.any(Function));
    expect(handleExportReconciliation).toHaveBeenCalledWith(fakeClient, jobData);
  });
});
