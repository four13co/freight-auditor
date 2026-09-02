import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  handleDeliverOutboxMessageJob,
  registerOutboxMessageSender,
  UnregisteredOutboxMessageTypeError,
  type OutboxMessageSender,
} from '../../src/jobs/deliver-outbox-message-handler.js';
import { JOB_NAMES, JobPayloadValidationError } from '../../src/jobs/contracts.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const OUTBOX_ID = '20000000-0000-4000-8000-000000000001';
const INSTANCE_ID = '30000000-0000-4000-8000-000000000001';
const COMMAND_ID = '40000000-0000-4000-8000-000000000001';

const basePayload = {
  schemaVersion: 1 as const,
  clientId: CLIENT_ID,
  idempotencyKey: 'notify:abc',
  requestedAt: '2026-09-01T00:00:00.000Z',
  outboxMessageId: OUTBOX_ID,
  workflowInstanceId: INSTANCE_ID,
  commandId: COMMAND_ID,
  messageType: 'carrier_notify',
  payload: { to: 'carrier@example.com' },
};

function fakeClient(): pg.PoolClient {
  return { query: vi.fn().mockResolvedValue({ rows: [{ id: 'audit-event-id', created: true }], rowCount: 1 }) } as unknown as pg.PoolClient;
}

describe('handleDeliverOutboxMessageJob', () => {
  it('dispatches to the sender registered for the payload messageType, passing the dedupeKey as idempotencyKey, then marks the message delivered', async () => {
    const client = fakeClient();
    const sender: OutboxMessageSender = vi.fn().mockResolvedValue(undefined);
    const senders = new Map([['carrier_notify', sender]]);
    const complete = vi.fn().mockResolvedValue({ found: true });

    await handleDeliverOutboxMessageJob(client, basePayload, { senders, complete });

    expect(sender).toHaveBeenCalledWith(client, {
      clientId: CLIENT_ID,
      workflowInstanceId: INSTANCE_ID,
      commandId: COMMAND_ID,
      outboxMessageId: OUTBOX_ID,
      idempotencyKey: 'notify:abc',
      payload: { to: 'carrier@example.com' },
    });
    expect(complete).toHaveBeenCalledWith(client, { clientId: CLIENT_ID, outboxMessageId: OUTBOX_ID });
  });

  it('writes a workflow.outbox_message_sent audit event only after the sender and completion both succeed', async () => {
    const client = fakeClient();
    const calls: string[] = [];
    const sender: OutboxMessageSender = vi.fn().mockImplementation(async () => { calls.push('sender'); });
    const complete = vi.fn().mockImplementation(async () => { calls.push('complete'); return { found: true }; });
    const senders = new Map([['carrier_notify', sender]]);

    await handleDeliverOutboxMessageJob(client, basePayload, { senders, complete });

    expect(calls).toEqual(['sender', 'complete']);
    const auditInsert = (client.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('audit_event'),
    );
    expect(auditInsert).toBeDefined();
    const [, params] = auditInsert as [string, unknown[]];
    expect(params[4]).toBe('workflow.outbox_message_sent');
    expect(params[9]).toEqual({ workflowInstanceId: INSTANCE_ID, commandId: COMMAND_ID, messageType: 'carrier_notify' });
  });

  it('fails closed for an unregistered message type: no sender call, no completion, no audit event', async () => {
    const client = fakeClient();
    const complete = vi.fn();
    const senders = new Map<string, OutboxMessageSender>();

    await expect(handleDeliverOutboxMessageJob(client, basePayload, { senders, complete }))
      .rejects.toBeInstanceOf(UnregisteredOutboxMessageTypeError);

    expect(complete).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('propagates a sender failure without completing the message (claimed, not delivered, so pg-boss retries)', async () => {
    const client = fakeClient();
    const failure = new Error('downstream send failed');
    const sender: OutboxMessageSender = vi.fn().mockRejectedValue(failure);
    const senders = new Map([['carrier_notify', sender]]);
    const complete = vi.fn();

    await expect(handleDeliverOutboxMessageJob(client, basePayload, { senders, complete }))
      .rejects.toThrow(failure);

    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload before any dispatch', async () => {
    const client = fakeClient();
    const sender: OutboxMessageSender = vi.fn();
    const senders = new Map([['carrier_notify', sender]]);
    const complete = vi.fn();

    await expect(handleDeliverOutboxMessageJob(client, { ...basePayload, outboxMessageId: 'not-a-uuid' }, { senders, complete }))
      .rejects.toBeInstanceOf(JobPayloadValidationError);

    expect(sender).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('registerOutboxMessageSender adds to the shared default registry used by the default export path', async () => {
    const client = fakeClient();
    const sender: OutboxMessageSender = vi.fn().mockResolvedValue(undefined);
    registerOutboxMessageSender('unit_test_only_type', sender);

    await handleDeliverOutboxMessageJob(client, { ...basePayload, messageType: 'unit_test_only_type' });

    expect(sender).toHaveBeenCalledWith(client, expect.objectContaining({ outboxMessageId: OUTBOX_ID }));
  });

  it('registers under DELIVER_OUTBOX_MESSAGE_V1', () => {
    expect(JOB_NAMES.DELIVER_OUTBOX_MESSAGE_V1).toBe('freight.workflow.deliver-outbox-message.v1');
  });
});
