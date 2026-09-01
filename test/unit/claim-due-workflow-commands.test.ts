import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { claimDueWorkflowCommands, completeWorkflowCommand } from '../../src/modules/workflow/claim-due-workflow-commands.js';

const CLIENT_ID = '20000000-0000-4000-8000-000000000001';
const COMMAND_ID = '20000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-01T00:00:00.000Z');

function mockClient(resolved: unknown) {
  const query = vi.fn().mockResolvedValue(resolved);
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('claimDueWorkflowCommands', () => {
  it('claims due pending commands and returns them mapped to camelCase', async () => {
    const { client, query } = mockClient({
      rows: [
        {
          id: COMMAND_ID,
          workflow_instance_id: 'instance-1',
          command_type: 'send_reminder',
          payload: { to: 'a@example.com' },
          attempts: 1,
        },
      ],
      rowCount: 1,
    });

    const result = await claimDueWorkflowCommands(client, { clientId: CLIENT_ID, now: NOW });

    expect(result).toEqual([
      {
        commandId: COMMAND_ID,
        workflowInstanceId: 'instance-1',
        commandType: 'send_reminder',
        payload: { to: 'a@example.com' },
        attempts: 1,
      },
    ]);
    const call = query.mock.calls[0] as [string, unknown[]];
    const [sql, values] = call;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status = 'claimed'");
    expect(values).toEqual([CLIENT_ID, NOW.toISOString(), 20]);
  });

  it('returns an empty array when nothing is due', async () => {
    const { client } = mockClient({ rows: [], rowCount: 0 });
    const result = await claimDueWorkflowCommands(client, { clientId: CLIENT_ID, now: NOW });
    expect(result).toEqual([]);
  });

  it('respects a caller-supplied limit', async () => {
    const { client, query } = mockClient({ rows: [], rowCount: 0 });
    await claimDueWorkflowCommands(client, { clientId: CLIENT_ID, now: NOW, limit: 5 });
    const call = query.mock.calls[0] as [string, unknown[]];
    expect(call[1]).toEqual([CLIENT_ID, NOW.toISOString(), 5]);
  });
});

describe('completeWorkflowCommand', () => {
  it('marks a claimed command done', async () => {
    const { client } = mockClient({ rowCount: 1 });
    const result = await completeWorkflowCommand(client, { clientId: CLIENT_ID, commandId: COMMAND_ID });
    expect(result).toEqual({ found: true });
  });

  it('is idempotent: completing an already-done command still reports found: true', async () => {
    const { client, query } = mockClient({ rowCount: 1 });
    const result = await completeWorkflowCommand(client, { clientId: CLIENT_ID, commandId: COMMAND_ID });
    expect(result).toEqual({ found: true });
    const call = query.mock.calls[0] as [string, unknown[]];
    expect(call[0]).toContain("status IN ('claimed', 'done')");
  });

  it('reports found: false for an unknown command id', async () => {
    const { client } = mockClient({ rowCount: 0 });
    const result = await completeWorkflowCommand(client, {
      clientId: CLIENT_ID,
      commandId: '20000000-0000-4000-8000-000000000099',
    });
    expect(result).toEqual({ found: false });
  });
});
