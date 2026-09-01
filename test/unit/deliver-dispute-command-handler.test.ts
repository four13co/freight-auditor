import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  DELIVER_DISPUTE_COMMAND_TYPE,
  DISPUTE_DELIVERY_MESSAGE_TYPE,
  disputeDeliveryDedupeKey,
  handleDeliverDisputeCommand,
} from '../../src/modules/disputes/deliver-dispute-command-handler.js';

const CLIENT_ID = '80000000-0000-4000-8000-000000000001';
const WORKFLOW_INSTANCE_ID = '80000000-0000-4000-8000-000000000002';
const COMMAND_ID = '80000000-0000-4000-8000-000000000003';
const DISPUTE_ID = '80000000-0000-4000-8000-000000000004';

const OUTBOX_MESSAGE_ID = '80000000-0000-4000-8000-000000000005';

function mockClient(opts: { outboxInsertRows?: unknown[] } = {}) {
  const { outboxInsertRows = [{ id: OUTBOX_MESSAGE_ID }] } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM workflow_command')) return Promise.resolve({ rowCount: 1, rows: [{}] });
    if (sql.startsWith('INSERT INTO workflow_outbox_message')) return Promise.resolve({ rows: outboxInsertRows });
    if (sql.includes('INSERT INTO audit_event')) return Promise.resolve({ rows: [{ id: 'audit-event-id', created: true }] });
    if (sql.startsWith('SELECT id FROM workflow_outbox_message')) return Promise.resolve({ rows: [{ id: OUTBOX_MESSAGE_ID }] });
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('handleDeliverDisputeCommand', () => {
  it('records an outbox delivery intent scoped to the command, dedupe-keyed on the disputeId', async () => {
    const { client, query } = mockClient();

    await handleDeliverDisputeCommand(client, {
      clientId: CLIENT_ID,
      workflowInstanceId: WORKFLOW_INSTANCE_ID,
      commandId: COMMAND_ID,
      commandType: DELIVER_DISPUTE_COMMAND_TYPE,
      payload: { disputeId: DISPUTE_ID },
    });

    const insertCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).startsWith('INSERT INTO workflow_outbox_message')) as [string, unknown[]];
    expect(insertCall).toBeDefined();
    const [clientId, workflowInstanceId, commandId, dedupeKey, , messageType] = insertCall[1] as [string, string, string, string, string, string];
    expect(clientId).toBe(CLIENT_ID);
    expect(workflowInstanceId).toBe(WORKFLOW_INSTANCE_ID);
    expect(commandId).toBe(COMMAND_ID);
    expect(dedupeKey).toBe(disputeDeliveryDedupeKey(DISPUTE_ID));
    expect(messageType).toBe(DISPUTE_DELIVERY_MESSAGE_TYPE);
  });

  it('derives the same dedupeKey across repeated calls for the same disputeId (crash-retry idempotency)', async () => {
    expect(disputeDeliveryDedupeKey(DISPUTE_ID)).toBe(disputeDeliveryDedupeKey(DISPUTE_ID));
    expect(disputeDeliveryDedupeKey(DISPUTE_ID)).not.toBe(disputeDeliveryDedupeKey(WORKFLOW_INSTANCE_ID));
  });

  it('rejects a payload missing disputeId before any query runs', async () => {
    const { client, query } = mockClient();

    await expect(handleDeliverDisputeCommand(client, {
      clientId: CLIENT_ID,
      workflowInstanceId: WORKFLOW_INSTANCE_ID,
      commandId: COMMAND_ID,
      commandType: DELIVER_DISPUTE_COMMAND_TYPE,
      payload: {},
    })).rejects.toThrow(/missing disputeId/);

    expect(query).not.toHaveBeenCalled();
  });
});
