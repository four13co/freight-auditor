import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  recordOutboxMessage,
  claimDueOutboxMessages,
  completeOutboxMessage,
  RecordOutboxMessageError,
} from '../../src/modules/workflow/workflow-outbox.js';

const CLIENT_ID = '30000000-0000-4000-8000-000000000001';
const INSTANCE_ID = '30000000-0000-4000-8000-000000000002';
const COMMAND_ID = '30000000-0000-4000-8000-000000000003';
const OUTBOX_ID = '30000000-0000-4000-8000-000000000004';
const NOW = new Date('2026-09-01T00:00:00.000Z');

interface MockOpts {
  commandFound?: boolean;
  insertedId?: string | null;
  existingId?: string | null;
}

function mockClient(opts: MockOpts = {}) {
  const { commandFound = true, insertedId = OUTBOX_ID, existingId = null } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM workflow_command')) {
      return Promise.resolve({ rows: commandFound ? [{}] : [], rowCount: commandFound ? 1 : 0 });
    }
    if (sql.includes('INSERT INTO workflow_outbox_message')) {
      return Promise.resolve({ rows: insertedId ? [{ id: insertedId }] : [], rowCount: insertedId ? 1 : 0 });
    }
    if (sql.includes('SELECT id FROM workflow_outbox_message')) {
      return Promise.resolve({ rows: existingId ? [{ id: existingId }] : [], rowCount: existingId ? 1 : 0 });
    }
    if (sql.includes('UPDATE workflow_outbox_message')) {
      return Promise.resolve({ rowCount: 1 });
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

describe('recordOutboxMessage', () => {
  it('throws COMMAND_NOT_FOUND when the workflow_command does not exist', async () => {
    const { client } = mockClient({ commandFound: false });
    await expect(
      recordOutboxMessage(client, {
        clientId: CLIENT_ID,
        workflowInstanceId: INSTANCE_ID,
        commandId: COMMAND_ID,
        dedupeKey: 'carrier-notify:abc',
      }),
    ).rejects.toBeInstanceOf(RecordOutboxMessageError);
  });

  it('inserts a new outbox message and returns created: true', async () => {
    const { client, query } = mockClient();
    const result = await recordOutboxMessage(client, {
      clientId: CLIENT_ID,
      workflowInstanceId: INSTANCE_ID,
      commandId: COMMAND_ID,
      dedupeKey: 'carrier-notify:abc',
      payload: { to: 'carrier@example.com' },
      messageType: 'carrier_notify',
    });
    expect(result).toEqual({ outboxMessageId: OUTBOX_ID, created: true });

    const [, values] = findCall(query, 'INSERT INTO workflow_outbox_message');
    expect(values).toEqual([CLIENT_ID, INSTANCE_ID, COMMAND_ID, 'carrier-notify:abc', '{"to":"carrier@example.com"}', 'carrier_notify']);
  });

  it('defaults messageType to unspecified when the caller does not pass one', async () => {
    const { client, query } = mockClient();
    await recordOutboxMessage(client, {
      clientId: CLIENT_ID,
      workflowInstanceId: INSTANCE_ID,
      commandId: COMMAND_ID,
      dedupeKey: 'carrier-notify:abc',
    });

    const [, values] = findCall(query, 'INSERT INTO workflow_outbox_message');
    expect(values).toEqual([CLIENT_ID, INSTANCE_ID, COMMAND_ID, 'carrier-notify:abc', '{}', 'unspecified']);
  });

  it('rejects a messageType that does not match the command_type-style pattern', async () => {
    const { client } = mockClient();
    await expect(
      recordOutboxMessage(client, {
        clientId: CLIENT_ID,
        workflowInstanceId: INSTANCE_ID,
        commandId: COMMAND_ID,
        dedupeKey: 'carrier-notify:abc',
        messageType: 'Not Valid!',
      }),
    ).rejects.toThrow();
  });

  it('is idempotent: a conflicting dedupeKey returns the existing row instead of a duplicate', async () => {
    const { client, query } = mockClient({ insertedId: null, existingId: 'existing-outbox-id' });
    const result = await recordOutboxMessage(client, {
      clientId: CLIENT_ID,
      workflowInstanceId: INSTANCE_ID,
      commandId: COMMAND_ID,
      dedupeKey: 'carrier-notify:abc',
    });
    expect(result).toEqual({ outboxMessageId: 'existing-outbox-id', created: false });

    const auditCall = query.mock.calls.find((call: unknown[]) => (call[0] as string).includes('INSERT INTO audit_event'));
    expect(auditCall).toBeUndefined();
  });

  it('rejects an empty dedupeKey', async () => {
    const { client } = mockClient();
    await expect(
      recordOutboxMessage(client, {
        clientId: CLIENT_ID,
        workflowInstanceId: INSTANCE_ID,
        commandId: COMMAND_ID,
        dedupeKey: '',
      }),
    ).rejects.toThrow();
  });

  it('writes an audit event only when the row was newly created', async () => {
    const { client, query } = mockClient();
    await recordOutboxMessage(client, {
      clientId: CLIENT_ID,
      workflowInstanceId: INSTANCE_ID,
      commandId: COMMAND_ID,
      dedupeKey: 'carrier-notify:abc',
    });

    const [, values] = findCall(query, 'INSERT INTO audit_event');
    expect(values[4]).toBe('workflow.outbox_message_recorded');
    expect(values[9]).toEqual({
      workflowInstanceId: INSTANCE_ID,
      commandId: COMMAND_ID,
      dedupeKey: 'carrier-notify:abc',
    });
  });
});

describe('claimDueOutboxMessages', () => {
  it('claims due pending messages and returns them mapped to camelCase', async () => {
    const { client, query } = mockClient();
    query.mockResolvedValueOnce({
      rows: [
        {
          id: OUTBOX_ID,
          workflow_instance_id: INSTANCE_ID,
          command_id: COMMAND_ID,
          dedupe_key: 'carrier-notify:abc',
          message_type: 'carrier_notify',
          payload: { to: 'carrier@example.com' },
          attempts: 1,
        },
      ],
      rowCount: 1,
    });

    const result = await claimDueOutboxMessages(client, { clientId: CLIENT_ID, now: NOW });

    expect(result).toEqual([
      {
        outboxMessageId: OUTBOX_ID,
        workflowInstanceId: INSTANCE_ID,
        commandId: COMMAND_ID,
        dedupeKey: 'carrier-notify:abc',
        messageType: 'carrier_notify',
        payload: { to: 'carrier@example.com' },
        attempts: 1,
      },
    ]);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status = 'claimed'");
    expect(sql).toContain('message_type');
    expect(values).toEqual([CLIENT_ID, NOW.toISOString(), 20]);
  });

  it('returns an empty array when nothing is due', async () => {
    const { client, query } = mockClient();
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await claimDueOutboxMessages(client, { clientId: CLIENT_ID, now: NOW });
    expect(result).toEqual([]);
  });

  it('respects a caller-supplied limit', async () => {
    const { client, query } = mockClient();
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await claimDueOutboxMessages(client, { clientId: CLIENT_ID, now: NOW, limit: 5 });
    const [, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([CLIENT_ID, NOW.toISOString(), 5]);
  });
});

describe('completeOutboxMessage', () => {
  it('marks a claimed message delivered', async () => {
    const { client } = mockClient();
    const result = await completeOutboxMessage(client, { clientId: CLIENT_ID, outboxMessageId: OUTBOX_ID });
    expect(result).toEqual({ found: true });
  });

  it('is idempotent: completing an already-delivered message still reports found: true', async () => {
    const { client, query } = mockClient();
    const result = await completeOutboxMessage(client, { clientId: CLIENT_ID, outboxMessageId: OUTBOX_ID });
    expect(result).toEqual({ found: true });
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status IN ('claimed', 'delivered')");
  });

  it('reports found: false for an unknown outbox message id', async () => {
    const { client, query } = mockClient();
    query.mockImplementationOnce((sql: string) => {
      if (sql.includes('UPDATE workflow_outbox_message')) return Promise.resolve({ rowCount: 0 });
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await completeOutboxMessage(client, {
      clientId: CLIENT_ID,
      outboxMessageId: '30000000-0000-4000-8000-000000000099',
    });
    expect(result).toEqual({ found: false });
  });
});
