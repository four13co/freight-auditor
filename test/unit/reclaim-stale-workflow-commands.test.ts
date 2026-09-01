import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  reclaimStaleWorkflowCommands,
  reclaimStaleWorkflowCommandsForActiveClients,
} from '../../src/modules/workflow/reclaim-stale-workflow-commands.js';

const CLIENT_ID = '20000000-0000-4000-8000-000000000001';
const CLIENT_A = '10000000-0000-4000-8000-000000000001';
const CLIENT_B = '10000000-0000-4000-8000-000000000002';
const COMMAND_ID = '20000000-0000-4000-8000-000000000002';
const COMMAND_1 = '20000000-0000-4000-8000-000000000003';
const COMMAND_2 = '20000000-0000-4000-8000-000000000004';
const INSTANCE_1 = '30000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-01T00:00:00.000Z');

function mockClient(resolved: unknown) {
  const query = vi.fn().mockResolvedValue(resolved);
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('reclaimStaleWorkflowCommands', () => {
  it('reclaims a stale claim back to pending when attempts is under the budget', async () => {
    const { client, query } = mockClient({
      rows: [{ id: COMMAND_ID, workflow_instance_id: INSTANCE_1, attempts: 2, status: 'pending' }],
      rowCount: 1,
    });

    const result = await reclaimStaleWorkflowCommands(client, { clientId: CLIENT_ID, now: NOW });

    expect(result).toEqual([
      { commandId: COMMAND_ID, workflowInstanceId: INSTANCE_1, attempts: 2, outcome: 'reclaimed' },
    ]);
    const call = query.mock.calls[0] as [string, unknown[]];
    const [sql, values] = call;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status = 'claimed'");
    expect(values[0]).toBe(CLIENT_ID);
    // cutoff = now - staleAfterMinutes (default 30)
    expect(values[1]).toBe(new Date(NOW.getTime() - 30 * 60_000).toISOString());
    expect(values[2]).toBe(20);
    expect(values[3]).toBe(5);
  });

  it('marks a claim failed instead of reclaiming it once attempts reaches maxAttempts', async () => {
    const { client } = mockClient({
      rows: [{ id: COMMAND_ID, workflow_instance_id: INSTANCE_1, attempts: 5, status: 'failed' }],
      rowCount: 1,
    });

    const result = await reclaimStaleWorkflowCommands(client, { clientId: CLIENT_ID, now: NOW });

    expect(result).toEqual([
      { commandId: COMMAND_ID, workflowInstanceId: INSTANCE_1, attempts: 5, outcome: 'failed' },
    ]);
  });

  it('returns an empty array when nothing is stale', async () => {
    const { client } = mockClient({ rows: [], rowCount: 0 });
    const result = await reclaimStaleWorkflowCommands(client, { clientId: CLIENT_ID, now: NOW });
    expect(result).toEqual([]);
  });

  it('respects caller-supplied staleAfterMinutes, maxAttempts, and limit', async () => {
    const { client, query } = mockClient({ rows: [], rowCount: 0 });
    await reclaimStaleWorkflowCommands(client, {
      clientId: CLIENT_ID, now: NOW, staleAfterMinutes: 60, maxAttempts: 3, limit: 5,
    });
    const call = query.mock.calls[0] as [string, unknown[]];
    expect(call[1]).toEqual([CLIENT_ID, new Date(NOW.getTime() - 60 * 60_000).toISOString(), 5, 3]);
  });
});

describe('reclaimStaleWorkflowCommandsForActiveClients', () => {
  function makeClient(rows: {
    clients?: { id: string }[];
    reclaimed?: Record<string, { id: string; workflow_instance_id: string; attempts: number; status: string }[]>;
  }): { client: pg.PoolClient; query: ReturnType<typeof vi.fn> } {
    const query = vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM client')) {
        return { rows: rows.clients ?? [] };
      }
      if (sql.includes('UPDATE workflow_command')) {
        const clientId = (params as string[])[0]!;
        return { rows: rows.reclaimed?.[clientId] ?? [] };
      }
      if (sql.includes('INSERT INTO audit_event') || sql.includes('WITH inserted AS')) {
        return { rows: [{ id: (params as string[])[0], created: true }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    return { client: { query } as unknown as pg.PoolClient, query };
  }

  it('reclaims stale claims for every active client and tallies reclaimed vs failed', async () => {
    const { client } = makeClient({
      clients: [{ id: CLIENT_A }, { id: CLIENT_B }],
      reclaimed: {
        [CLIENT_A]: [{ id: COMMAND_1, workflow_instance_id: INSTANCE_1, attempts: 1, status: 'pending' }],
        [CLIENT_B]: [{ id: COMMAND_2, workflow_instance_id: INSTANCE_1, attempts: 5, status: 'failed' }],
      },
    });

    const result = await reclaimStaleWorkflowCommandsForActiveClients(client, NOW);

    expect(result).toEqual({ reclaimed: 1, failed: 1 });
  });

  it('writes an audit event per recovered command, naming the outcome', async () => {
    const { client, query } = makeClient({
      clients: [{ id: CLIENT_A }],
      reclaimed: {
        [CLIENT_A]: [{ id: COMMAND_1, workflow_instance_id: INSTANCE_1, attempts: 2, status: 'pending' }],
      },
    });

    await reclaimStaleWorkflowCommandsForActiveClients(client, NOW);

    const auditCall = query.mock.calls.find((call) => (call[0] as string).includes('INSERT INTO audit_event'));
    expect(auditCall).toBeDefined();
    const [, params] = auditCall as [string, unknown[]];
    expect(params).toEqual(expect.arrayContaining([CLIENT_A, 'workflow_command', COMMAND_1, 'workflow.command_reclaimed']));
  });

  it('returns zero counts and writes no audit events when nothing is stale', async () => {
    const { client, query } = makeClient({ clients: [{ id: CLIENT_A }], reclaimed: {} });
    const result = await reclaimStaleWorkflowCommandsForActiveClients(client, NOW);
    expect(result).toEqual({ reclaimed: 0, failed: 0 });
    expect(query.mock.calls.some((call) => (call[0] as string).includes('INSERT INTO audit_event'))).toBe(false);
  });

  it('only queries active clients', async () => {
    const { client, query } = makeClient({ clients: [] });
    await reclaimStaleWorkflowCommandsForActiveClients(client, NOW);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('is_active = true'));
  });
});
