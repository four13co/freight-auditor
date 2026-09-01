import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { scheduleWorkflowCommandJobs } from '../../src/modules/workflow/schedule-workflow-command-jobs.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';

const CLIENT_A = '10000000-0000-4000-8000-000000000001';
const CLIENT_B = '10000000-0000-4000-8000-000000000002';
const COMMAND_1 = '20000000-0000-4000-8000-000000000001';
const COMMAND_2 = '20000000-0000-4000-8000-000000000002';
const INSTANCE_1 = '30000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-01T00:00:00.000Z');

interface ClaimedRow {
  id: string;
  workflow_instance_id: string;
  command_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

function makeClient(rows: {
  clients?: { id: string }[];
  claimed?: Record<string, ClaimedRow[]>;
}): pg.PoolClient {
  const query = vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM client')) {
      return { rows: rows.clients ?? [] };
    }
    if (sql.includes('UPDATE workflow_command')) {
      const clientId = (params as string[])[0]!;
      return { rows: rows.claimed?.[clientId] ?? [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query } as unknown as pg.PoolClient;
}

describe('scheduleWorkflowCommandJobs', () => {
  it('enqueues a RUN_WORKFLOW_COMMAND_V1 job for each command claimed, per active client', async () => {
    const client = makeClient({
      clients: [{ id: CLIENT_A }, { id: CLIENT_B }],
      claimed: {
        [CLIENT_A]: [{ id: COMMAND_1, workflow_instance_id: INSTANCE_1, command_type: 'send_reminder', payload: { to: 'a@example.com' }, attempts: 1 }],
        [CLIENT_B]: [{ id: COMMAND_2, workflow_instance_id: INSTANCE_1, command_type: 'send_reminder', payload: {}, attempts: 1 }],
      },
    });
    const send = vi.fn().mockResolvedValue('job-id');
    const boss = { send };

    const result = await scheduleWorkflowCommandJobs(client, boss as never, NOW);

    expect(result).toEqual({ enqueued: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toBe(JOB_NAMES.RUN_WORKFLOW_COMMAND_V1);
    expect(send.mock.calls[0]![1]).toMatchObject({
      clientId: CLIENT_A,
      commandId: COMMAND_1,
      workflowInstanceId: INSTANCE_1,
      commandType: 'send_reminder',
      payload: { to: 'a@example.com' },
    });
    // enqueueInTransaction's `db` override routes pg-boss's own insert
    // through the caller's PoolClient, so the enqueue commits/rolls back
    // with the same transaction that claimed the command.
    expect(send.mock.calls[0]![2]).toMatchObject({ db: { executeSql: expect.any(Function) } });
    expect(send.mock.calls[1]![1]).toMatchObject({ clientId: CLIENT_B, commandId: COMMAND_2 });
  });

  it('uses a deterministic job id per command so a re-run does not duplicate', async () => {
    const client = makeClient({
      clients: [{ id: CLIENT_A }],
      claimed: {
        [CLIENT_A]: [{ id: COMMAND_1, workflow_instance_id: INSTANCE_1, command_type: 'send_reminder', payload: {}, attempts: 1 }],
      },
    });
    const send = vi.fn().mockResolvedValue('job-id');
    const boss = { send };

    await scheduleWorkflowCommandJobs(client, boss as never, NOW);
    await scheduleWorkflowCommandJobs(client, boss as never, NOW);

    const firstId = send.mock.calls[0]![2].id;
    const secondId = send.mock.calls[1]![2].id;
    expect(firstId).toBe(secondId);
  });

  it('skips clients with nothing due without calling send', async () => {
    const client = makeClient({ clients: [{ id: CLIENT_A }] });
    const send = vi.fn();
    const boss = { send };

    const result = await scheduleWorkflowCommandJobs(client, boss as never, NOW);

    expect(result).toEqual({ enqueued: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('only queries active clients', async () => {
    const client = makeClient({ clients: [] });
    await scheduleWorkflowCommandJobs(client, { send: vi.fn() } as never, NOW);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('is_active = true'));
  });
});
