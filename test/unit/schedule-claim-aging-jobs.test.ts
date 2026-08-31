import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { scheduleClaimAgingJobs } from '../../src/modules/claims/schedule-claim-aging-jobs.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';

const CLIENT_A = '10000000-0000-4000-8000-000000000001';
const CLIENT_B = '10000000-0000-4000-8000-000000000002';
const CLAIM_1 = '20000000-0000-4000-8000-000000000001';
const CLAIM_2 = '20000000-0000-4000-8000-000000000002';
const CLAIM_3 = '20000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-08-30T00:00:00.000Z');

function makeClient(rows: {
  clients?: { id: string }[];
  dueForFollowUp?: Record<string, { id: string; aging_deadline_at: Date }[]>;
  dueForEscalation?: Record<string, { id: string; follow_up_sent_at: Date }[]>;
}): pg.PoolClient {
  const query = vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM client')) {
      return { rows: rows.clients ?? [] };
    }
    if (sql.includes('aging_deadline_at IS NOT NULL')) {
      const clientId = (params as string[])[0]!;
      return { rows: rows.dueForFollowUp?.[clientId] ?? [] };
    }
    if (sql.includes('follow_up_sent_at')) {
      const clientId = (params as string[])[0]!;
      return { rows: rows.dueForEscalation?.[clientId] ?? [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query } as unknown as pg.PoolClient;
}

describe('scheduleClaimAgingJobs', () => {
  it('enqueues a follow-up job for each claim due, per active client, via the caller transaction', async () => {
    const client = makeClient({
      clients: [{ id: CLIENT_A }, { id: CLIENT_B }],
      dueForFollowUp: {
        [CLIENT_A]: [{ id: CLAIM_1, aging_deadline_at: new Date('2026-08-01T00:00:00Z') }],
        [CLIENT_B]: [{ id: CLAIM_2, aging_deadline_at: new Date('2026-08-15T00:00:00Z') }],
      },
    });
    const send = vi.fn().mockResolvedValue('job-id');
    const boss = { send };

    const result = await scheduleClaimAgingJobs(client, boss as never, NOW);

    expect(result.followUpEnqueued).toBe(2);
    expect(result.escalationEnqueued).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toBe(JOB_NAMES.FOLLOW_UP_CLAIM_V1);
    expect(send.mock.calls[0]![1]).toMatchObject({ clientId: CLIENT_A, claimId: CLAIM_1 });
    // enqueueInTransaction's `db` override routes pg-boss's own insert through
    // the caller's PoolClient -- this is what makes the enqueue commit/roll
    // back with the scan transaction, the gap Review flagged on the prior
    // attempt (boss.send() called directly bypassed the caller's client).
    expect(send.mock.calls[0]![2]).toMatchObject({ db: { executeSql: expect.any(Function) } });
    expect(send.mock.calls[1]![1]).toMatchObject({ clientId: CLIENT_B, claimId: CLAIM_2 });
  });

  it('enqueues an escalation job for each claim due', async () => {
    const client = makeClient({
      clients: [{ id: CLIENT_A }],
      dueForEscalation: {
        [CLIENT_A]: [{ id: CLAIM_3, follow_up_sent_at: new Date('2026-08-01T00:00:00Z') }],
      },
    });
    const send = vi.fn().mockResolvedValue('job-id');
    const boss = { send };

    const result = await scheduleClaimAgingJobs(client, boss as never, NOW);

    expect(result.escalationEnqueued).toBe(1);
    expect(send).toHaveBeenCalledWith(
      JOB_NAMES.ESCALATE_CLAIM_V1,
      expect.objectContaining({ clientId: CLIENT_A, claimId: CLAIM_3 }),
      expect.objectContaining({ id: expect.any(String), db: expect.objectContaining({ executeSql: expect.any(Function) }) }),
    );
  });

  it('uses a deterministic job id per claim so a re-run does not duplicate', async () => {
    const client = makeClient({
      clients: [{ id: CLIENT_A }],
      dueForFollowUp: {
        [CLIENT_A]: [{ id: CLAIM_1, aging_deadline_at: new Date('2026-08-01T00:00:00Z') }],
      },
    });
    const send = vi.fn().mockResolvedValue('job-id');
    const boss = { send };

    await scheduleClaimAgingJobs(client, boss as never, NOW);
    await scheduleClaimAgingJobs(client, boss as never, NOW);

    const firstId = send.mock.calls[0]![2].id;
    const secondId = send.mock.calls[1]![2].id;
    expect(firstId).toBe(secondId);
  });

  it('skips clients with nothing due without calling send', async () => {
    const client = makeClient({ clients: [{ id: CLIENT_A }] });
    const send = vi.fn();
    const boss = { send };

    const result = await scheduleClaimAgingJobs(client, boss as never, NOW);

    expect(result).toEqual({ followUpEnqueued: 0, escalationEnqueued: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('only queries active clients', async () => {
    const client = makeClient({ clients: [] });
    const send = vi.fn();
    await scheduleClaimAgingJobs(client, { send } as never, NOW);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('is_active = true'));
  });
});
