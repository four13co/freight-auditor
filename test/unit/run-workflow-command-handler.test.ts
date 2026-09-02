import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  handleRunWorkflowCommandJob,
  registerWorkflowCommandHandler,
  UnknownWorkflowCommandTypeError,
  type WorkflowCommandHandler,
} from '../../src/jobs/run-workflow-command-handler.js';
import { JOB_NAMES, JobPayloadValidationError } from '../../src/jobs/contracts.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const COMMAND_ID = '20000000-0000-4000-8000-000000000001';
const INSTANCE_ID = '30000000-0000-4000-8000-000000000001';

const basePayload = {
  schemaVersion: 1 as const,
  clientId: CLIENT_ID,
  idempotencyKey: `workflow-command:${COMMAND_ID}`,
  requestedAt: '2026-09-01T00:00:00.000Z',
  commandId: COMMAND_ID,
  workflowInstanceId: INSTANCE_ID,
  commandType: 'send_reminder',
  payload: { to: 'a@example.com' },
};

function fakeClient(): pg.PoolClient {
  // writeAuditEvent expects a row back (its insert-or-existing UNION ALL
  // always returns exactly one row for a valid insert) -- these tests never
  // exercise writeAuditEvent's own conflict/validation branches, so a fixed
  // success row is all any call site here needs.
  return { query: vi.fn().mockResolvedValue({ rows: [{ id: 'audit-event-id', created: true }], rowCount: 1 }) } as unknown as pg.PoolClient;
}

describe('handleRunWorkflowCommandJob', () => {
  it('dispatches to the handler registered for the payload commandType, then marks the command done', async () => {
    const client = fakeClient();
    const handler: WorkflowCommandHandler = vi.fn().mockResolvedValue(undefined);
    const handlers = new Map([['send_reminder', handler]]);
    const complete = vi.fn().mockResolvedValue({ found: true });

    await handleRunWorkflowCommandJob(client, basePayload, { handlers, complete });

    expect(handler).toHaveBeenCalledWith(client, {
      clientId: CLIENT_ID,
      workflowInstanceId: INSTANCE_ID,
      commandId: COMMAND_ID,
      commandType: 'send_reminder',
      payload: { to: 'a@example.com' },
    });
    expect(complete).toHaveBeenCalledWith(client, { clientId: CLIENT_ID, commandId: COMMAND_ID });
  });

  it('writes a workflow.command_run audit event only after the handler and completion both succeed', async () => {
    const client = fakeClient();
    const calls: string[] = [];
    const handler: WorkflowCommandHandler = vi.fn().mockImplementation(async () => { calls.push('handler'); });
    const complete = vi.fn().mockImplementation(async () => { calls.push('complete'); return { found: true }; });
    const handlers = new Map([['send_reminder', handler]]);

    await handleRunWorkflowCommandJob(client, basePayload, { handlers, complete });

    expect(calls).toEqual(['handler', 'complete']);
    const auditInsert = (client.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('audit_event'),
    );
    expect(auditInsert).toBeDefined();
    const [, params] = auditInsert as [string, unknown[]];
    expect(params[4]).toBe('workflow.command_run');
    expect(params[9]).toEqual({ workflowInstanceId: INSTANCE_ID, commandType: 'send_reminder' });
  });

  it('fails closed for an unregistered command type: no handler call, no completion, no audit event', async () => {
    const client = fakeClient();
    const complete = vi.fn();
    const handlers = new Map<string, WorkflowCommandHandler>();

    await expect(handleRunWorkflowCommandJob(client, basePayload, { handlers, complete }))
      .rejects.toBeInstanceOf(UnknownWorkflowCommandTypeError);

    expect(complete).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('propagates a handler failure without completing the command (claimed, not done, so pg-boss retries)', async () => {
    const client = fakeClient();
    const failure = new Error('downstream effect failed');
    const handler: WorkflowCommandHandler = vi.fn().mockRejectedValue(failure);
    const handlers = new Map([['send_reminder', handler]]);
    const complete = vi.fn();

    await expect(handleRunWorkflowCommandJob(client, basePayload, { handlers, complete }))
      .rejects.toThrow(failure);

    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload before any dispatch', async () => {
    const client = fakeClient();
    const handler: WorkflowCommandHandler = vi.fn();
    const handlers = new Map([['send_reminder', handler]]);
    const complete = vi.fn();

    await expect(handleRunWorkflowCommandJob(client, { ...basePayload, commandId: 'not-a-uuid' }, { handlers, complete }))
      .rejects.toBeInstanceOf(JobPayloadValidationError);

    expect(handler).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('registerWorkflowCommandHandler adds to the shared default registry used by the default export path', async () => {
    const client = fakeClient();
    const handler: WorkflowCommandHandler = vi.fn().mockResolvedValue(undefined);
    registerWorkflowCommandHandler('unit_test_only_type', handler);

    // Uses the module-level default deps (no deps override) to prove
    // registration actually reaches the registry the real worker dispatches
    // against, not just an injected test double.
    await handleRunWorkflowCommandJob(client, { ...basePayload, commandType: 'unit_test_only_type' });

    expect(handler).toHaveBeenCalledWith(client, expect.objectContaining({ commandType: 'unit_test_only_type' }));
  });

  it('passes commandId through to the handler (P4.C.7: needed for recordOutboxMessage\'s FK guard)', async () => {
    const client = fakeClient();
    const handler: WorkflowCommandHandler = vi.fn().mockResolvedValue(undefined);
    const handlers = new Map([['send_reminder', handler]]);
    const complete = vi.fn().mockResolvedValue({ found: true });

    await handleRunWorkflowCommandJob(client, basePayload, { handlers, complete });

    expect(handler).toHaveBeenCalledWith(client, expect.objectContaining({ commandId: COMMAND_ID }));
  });

  it('registers under RUN_WORKFLOW_COMMAND_V1', () => {
    expect(JOB_NAMES.RUN_WORKFLOW_COMMAND_V1).toBe('freight.workflow.run-command.v1');
  });
});
