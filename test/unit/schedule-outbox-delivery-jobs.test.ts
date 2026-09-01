import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { scheduleOutboxDeliveryJobs } from '../../src/modules/workflow/schedule-outbox-delivery-jobs.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';

const CLIENT_A = '10000000-0000-4000-8000-000000000001';
const CLIENT_B = '10000000-0000-4000-8000-000000000002';
const OUTBOX_1 = '20000000-0000-4000-8000-000000000001';
const OUTBOX_2 = '20000000-0000-4000-8000-000000000002';
const INSTANCE_1 = '30000000-0000-4000-8000-000000000001';
const COMMAND_1 = '40000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-01T00:00:00.000Z');

interface ClaimedRow {
  id: string;
  workflow_instance_id: string;
  command_id: string;
  dedupe_key: string;
  message_type: string;
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
    if (sql.includes('UPDATE workflow_outbox_message')) {
      const clientId = (params as string[])[0]!;
      return { rows: rows.claimed?.[clientId] ?? [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query } as unknown as pg.PoolClient;
}

describe('scheduleOutboxDeliveryJobs', () => {
  it('enqueues a DELIVER_OUTBOX_MESSAGE_V1 job for each message claimed, per active client', async () => {
    const client = makeClient({
      clients: [{ id: CLIENT_A }, { id: CLIENT_B }],
      claimed: {
        [CLIENT_A]: [{ id: OUTBOX_1, workflow_instance_id: INSTANCE_1, command_id: COMMAND_1, dedupe_key: 'notify:1', message_type: 'carrier_notify', payload: { to: 'a@example.com' }, attempts: 1 }],
        [CLIENT_B]: [{ id: OUTBOX_2, workflow_instance_id: INSTANCE_1, command_id: COMMAND_1, dedupe_key: 'notify:2', message_type: 'carrier_notify', payload: {}, attempts: 1 }],
      },
    });
    const send = vi.fn().mockResolvedValue('job-id');
    const boss = { send };

    const result = await scheduleOutboxDeliveryJobs(client, boss as never, NOW);

    expect(result).toEqual({ enqueued: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toBe(JOB_NAMES.DELIVER_OUTBOX_MESSAGE_V1);
    expect(send.mock.calls[0]![1]).toMatchObject({
      clientId: CLIENT_A,
      idempotencyKey: 'notify:1',
      outboxMessageId: OUTBOX_1,
      workflowInstanceId: INSTANCE_1,
      commandId: COMMAND_1,
      messageType: 'carrier_notify',
      payload: { to: 'a@example.com' },
    });
    expect(send.mock.calls[0]![2]).toMatchObject({ db: { executeSql: expect.any(Function) } });
    expect(send.mock.calls[1]![1]).toMatchObject({ clientId: CLIENT_B, idempotencyKey: 'notify:2', outboxMessageId: OUTBOX_2 });
  });

  it('uses the message dedupeKey as the idempotency key so a re-run does not duplicate', async () => {
    const client = makeClient({
      clients: [{ id: CLIENT_A }],
      claimed: {
        [CLIENT_A]: [{ id: OUTBOX_1, workflow_instance_id: INSTANCE_1, command_id: COMMAND_1, dedupe_key: 'notify:1', message_type: 'carrier_notify', payload: {}, attempts: 1 }],
      },
    });
    const send = vi.fn().mockResolvedValue('job-id');
    const boss = { send };

    await scheduleOutboxDeliveryJobs(client, boss as never, NOW);
    await scheduleOutboxDeliveryJobs(client, boss as never, NOW);

    const firstId = send.mock.calls[0]![2].id;
    const secondId = send.mock.calls[1]![2].id;
    expect(firstId).toBe(secondId);
  });

  it('folds attempts into the job id (not the payload idempotencyKey) so a reclaimed message gets a fresh job id', async () => {
    const firstAttempt = makeClient({
      clients: [{ id: CLIENT_A }],
      claimed: {
        [CLIENT_A]: [{ id: OUTBOX_1, workflow_instance_id: INSTANCE_1, command_id: COMMAND_1, dedupe_key: 'notify:1', message_type: 'carrier_notify', payload: {}, attempts: 1 }],
      },
    });
    const secondAttempt = makeClient({
      clients: [{ id: CLIENT_A }],
      claimed: {
        // Same row reclaimed after a stranded first claim (P4.A.8): attempts
        // incremented by the second claimDueOutboxMessages call, dedupeKey unchanged.
        [CLIENT_A]: [{ id: OUTBOX_1, workflow_instance_id: INSTANCE_1, command_id: COMMAND_1, dedupe_key: 'notify:1', message_type: 'carrier_notify', payload: {}, attempts: 2 }],
      },
    });
    const send = vi.fn().mockResolvedValue('job-id');

    await scheduleOutboxDeliveryJobs(firstAttempt, { send } as never, NOW);
    const firstJobId = send.mock.calls[0]![2].id;
    const firstPayload = send.mock.calls[0]![1] as Record<string, unknown>;

    await scheduleOutboxDeliveryJobs(secondAttempt, { send } as never, NOW);
    const secondJobId = send.mock.calls[1]![2].id;
    const secondPayload = send.mock.calls[1]![1] as Record<string, unknown>;

    expect(secondJobId).not.toBe(firstJobId);
    // The sender-facing idempotencyKey stays the stable dedupeKey across attempts --
    // only the pg-boss job id varies, so a real external provider still dedupes correctly.
    expect(firstPayload.idempotencyKey).toBe('notify:1');
    expect(secondPayload.idempotencyKey).toBe('notify:1');
  });

  it('skips clients with nothing due without calling send', async () => {
    const client = makeClient({ clients: [{ id: CLIENT_A }] });
    const send = vi.fn();
    const boss = { send };

    const result = await scheduleOutboxDeliveryJobs(client, boss as never, NOW);

    expect(result).toEqual({ enqueued: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('only queries active clients', async () => {
    const client = makeClient({ clients: [] });
    await scheduleOutboxDeliveryJobs(client, { send: vi.fn() } as never, NOW);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('is_active = true'));
  });
});
