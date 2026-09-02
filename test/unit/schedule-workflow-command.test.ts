import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { ScheduleWorkflowCommandError, scheduleWorkflowCommand } from '../../src/modules/workflow/schedule-workflow-command.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const INSTANCE_ID = '10000000-0000-4000-8000-000000000002';
const COMMAND_ID = '10000000-0000-4000-8000-000000000003';
const RUN_AFTER = new Date('2026-09-01T00:00:00.000Z');

interface MockOpts {
  instanceFound?: boolean;
  existingId?: string | null;
}

function mockClient(opts: MockOpts = {}) {
  const { instanceFound = true, existingId = null } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM workflow_instance')) {
      return Promise.resolve({ rows: instanceFound ? [{}] : [], rowCount: instanceFound ? 1 : 0 });
    }
    if (sql.includes('INSERT INTO workflow_command')) {
      // ON CONFLICT DO NOTHING: simulate a pre-existing dedupe-key row by
      // returning no RETURNING rows, matching what a real unique-constraint
      // conflict produces (migration 0072, workflow_command_dedupe_key).
      if (existingId) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [{ id: COMMAND_ID }], rowCount: 1 });
    }
    if (sql.includes('SELECT id FROM workflow_command')) {
      return Promise.resolve({ rows: existingId ? [{ id: existingId }] : [], rowCount: existingId ? 1 : 0 });
    }
    if (sql.includes('INSERT INTO audit_event')) {
      return Promise.resolve({ rows: [{ id: 'audit-event-id', created: true }], rowCount: 1 });
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

function findCall(query: ReturnType<typeof vi.fn>, needle: string): [string, unknown[]] {
  const call = query.mock.calls.find((call: unknown[]) => (call[0] as string).includes(needle));
  if (!call) throw new Error(`no call matching ${needle}`);
  return call as [string, unknown[]];
}

describe('scheduleWorkflowCommand', () => {
  it('throws INSTANCE_NOT_FOUND when the workflow_instance does not exist', async () => {
    const { client } = mockClient({ instanceFound: false });
    await expect(
      scheduleWorkflowCommand(client, {
        clientId: CLIENT_ID,
        workflowInstanceId: INSTANCE_ID,
        commandType: 'send_reminder',
        runAfter: RUN_AFTER,
      }),
    ).rejects.toBeInstanceOf(ScheduleWorkflowCommandError);
  });

  it('inserts a new command and returns created: true', async () => {
    const { client, query } = mockClient();
    const result = await scheduleWorkflowCommand(client, {
      clientId: CLIENT_ID,
      workflowInstanceId: INSTANCE_ID,
      commandType: 'send_reminder',
      runAfter: RUN_AFTER,
    });
    expect(result).toEqual({ commandId: COMMAND_ID, created: true });

    const [, values] = findCall(query, 'INSERT INTO workflow_command');
    expect(values).toEqual([CLIENT_ID, INSTANCE_ID, 'send_reminder', '{}', RUN_AFTER.toISOString()]);
  });

  it('is idempotent: returns the existing command instead of a duplicate when the dedupe-key insert conflicts', async () => {
    const { client, query } = mockClient({ existingId: 'existing-command-id' });
    const result = await scheduleWorkflowCommand(client, {
      clientId: CLIENT_ID,
      workflowInstanceId: INSTANCE_ID,
      commandType: 'send_reminder',
      runAfter: RUN_AFTER,
    });
    expect(result).toEqual({ commandId: 'existing-command-id', created: false });

    const auditCall = query.mock.calls.find((call: unknown[]) => (call[0] as string).includes('INSERT INTO audit_event'));
    expect(auditCall).toBeUndefined();
  });

  it('rejects a commandType that fails the open-text CHECK-matching regex', async () => {
    const { client } = mockClient();
    await expect(
      scheduleWorkflowCommand(client, {
        clientId: CLIENT_ID,
        workflowInstanceId: INSTANCE_ID,
        commandType: 'Send-Reminder',
        runAfter: RUN_AFTER,
      }),
    ).rejects.toThrow();
  });

  it('writes an audit event with the scheduled command detail', async () => {
    const { client, query } = mockClient();
    await scheduleWorkflowCommand(client, {
      clientId: CLIENT_ID,
      workflowInstanceId: INSTANCE_ID,
      commandType: 'send_reminder',
      payload: { to: 'analyst@example.com' },
      runAfter: RUN_AFTER,
    });

    const [, values] = findCall(query, 'INSERT INTO audit_event');
    expect(values[4]).toBe('workflow.command_scheduled');
    expect(values[9]).toEqual({
      workflowInstanceId: INSTANCE_ID,
      commandType: 'send_reminder',
      runAfter: RUN_AFTER.toISOString(),
    });
  });
});
