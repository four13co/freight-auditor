import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { scheduleReconciliationExportJobs } from '../../src/modules/claims/schedule-reconciliation-export-jobs.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';

const CLIENT_A = '10000000-0000-4000-8000-000000000001';
const CLIENT_B = '10000000-0000-4000-8000-000000000002';
const EXPORT_1 = '20000000-0000-4000-8000-000000000001';
const EXPORT_2 = '20000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-01T00:00:00.000Z');

interface ClaimedRow {
  id: string;
  idempotency_key: string;
}

function makeClient(rows: {
  clients?: { id: string }[];
  claimed?: Record<string, ClaimedRow[]>;
}): pg.PoolClient {
  const query = vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM client')) {
      return { rows: rows.clients ?? [] };
    }
    if (sql.includes('UPDATE reconciliation_export')) {
      const clientId = (params as string[])[0]!;
      return { rows: rows.claimed?.[clientId] ?? [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query } as unknown as pg.PoolClient;
}

describe('scheduleReconciliationExportJobs', () => {
  it('enqueues an EXPORT_RECONCILIATION_V1 job for each export claimed, per active client', async () => {
    const client = makeClient({
      clients: [{ id: CLIENT_A }, { id: CLIENT_B }],
      claimed: {
        [CLIENT_A]: [{ id: EXPORT_1, idempotency_key: 'export-1' }],
        [CLIENT_B]: [{ id: EXPORT_2, idempotency_key: 'export-2' }],
      },
    });
    const send = vi.fn().mockResolvedValue('job-id');
    const boss = { send };

    const result = await scheduleReconciliationExportJobs(client, boss as never, NOW);

    expect(result).toEqual({ enqueued: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toBe(JOB_NAMES.EXPORT_RECONCILIATION_V1);
    expect(send.mock.calls[0]![1]).toMatchObject({
      clientId: CLIENT_A,
      idempotencyKey: 'export-1',
      exportId: EXPORT_1,
    });
    expect(send.mock.calls[1]![1]).toMatchObject({ clientId: CLIENT_B, idempotencyKey: 'export-2', exportId: EXPORT_2 });
  });

  it('uses the export row own idempotency_key as the job idempotency key so a re-run does not duplicate', async () => {
    const client = makeClient({
      clients: [{ id: CLIENT_A }],
      claimed: { [CLIENT_A]: [{ id: EXPORT_1, idempotency_key: 'export-1' }] },
    });
    const send = vi.fn().mockResolvedValue('job-id');
    const boss = { send };

    await scheduleReconciliationExportJobs(client, boss as never, NOW);
    await scheduleReconciliationExportJobs(client, boss as never, NOW);

    const firstId = send.mock.calls[0]![2].id;
    const secondId = send.mock.calls[1]![2].id;
    expect(firstId).toBe(secondId);
  });

  it('skips clients with nothing due without calling send', async () => {
    const client = makeClient({ clients: [{ id: CLIENT_A }] });
    const send = vi.fn();
    const boss = { send };

    const result = await scheduleReconciliationExportJobs(client, boss as never, NOW);

    expect(result).toEqual({ enqueued: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('only queries active clients', async () => {
    const client = makeClient({ clients: [] });
    await scheduleReconciliationExportJobs(client, { send: vi.fn() } as never, NOW);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('is_active = true'));
  });
});
