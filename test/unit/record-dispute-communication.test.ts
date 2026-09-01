import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { recordDisputeCommunication, RecordDisputeCommunicationError } from '../../src/modules/disputes/record-dispute-communication.js';

const CLIENT_ID = '40000000-0000-4000-8000-000000000001';
const DISPUTE_ID = '40000000-0000-4000-8000-000000000002';
const COMM_ID = '40000000-0000-4000-8000-000000000003';

interface MockOpts {
  disputeFound?: boolean;
  insertedId?: string | null;
  existingId?: string | null;
}

function mockClient(opts: MockOpts = {}) {
  const { disputeFound = true, insertedId = COMM_ID, existingId = null } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('SELECT client_id FROM dispute')) {
      return Promise.resolve({ rows: disputeFound ? [{ client_id: CLIENT_ID }] : [], rowCount: disputeFound ? 1 : 0 });
    }
    if (sql.includes('INSERT INTO dispute_comm')) {
      return Promise.resolve({ rows: insertedId ? [{ id: insertedId }] : [], rowCount: insertedId ? 1 : 0 });
    }
    if (sql.includes('SELECT id FROM dispute_comm')) {
      return Promise.resolve({ rows: existingId ? [{ id: existingId }] : [], rowCount: existingId ? 1 : 0 });
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

describe('recordDisputeCommunication', () => {
  it('throws DISPUTE_NOT_FOUND when the dispute does not exist (or is not visible under RLS)', async () => {
    const { client } = mockClient({ disputeFound: false });
    await expect(
      recordDisputeCommunication(client, {
        disputeId: DISPUTE_ID,
        direction: 'inbound',
        body: 'Carrier called.',
        dedupeKey: 'dispute-comm-inbound:abc',
      }),
    ).rejects.toBeInstanceOf(RecordDisputeCommunicationError);
  });

  it('inserts a new communication and returns created: true, deriving client_id from the dispute row', async () => {
    const { client, query } = mockClient();
    const result = await recordDisputeCommunication(client, {
      disputeId: DISPUTE_ID,
      direction: 'outbound',
      body: 'Delivery to carrier initiated.',
      dedupeKey: 'dispute-comm-outbound:xyz',
    });
    expect(result).toEqual({ disputeCommId: COMM_ID, created: true });

    const [, values] = findCall(query, 'INSERT INTO dispute_comm');
    expect(values).toEqual([CLIENT_ID, DISPUTE_ID, 'outbound', 'Delivery to carrier initiated.', 'dispute-comm-outbound:xyz']);
  });

  it('is idempotent: a conflicting dedupeKey returns the existing row instead of a duplicate', async () => {
    const { client } = mockClient({ insertedId: null, existingId: 'existing-comm-id' });
    const result = await recordDisputeCommunication(client, {
      disputeId: DISPUTE_ID,
      direction: 'inbound',
      body: 'Carrier called.',
      dedupeKey: 'dispute-comm-inbound:abc',
    });
    expect(result).toEqual({ disputeCommId: 'existing-comm-id', created: false });
  });

  it('rejects a direction other than inbound/outbound', async () => {
    const { client } = mockClient();
    await expect(
      recordDisputeCommunication(client, {
        disputeId: DISPUTE_ID,
        // @ts-expect-error deliberately invalid
        direction: 'sideways',
        body: 'Carrier called.',
        dedupeKey: 'dispute-comm-inbound:abc',
      }),
    ).rejects.toThrow();
  });

  it('rejects an empty body', async () => {
    const { client } = mockClient();
    await expect(
      recordDisputeCommunication(client, {
        disputeId: DISPUTE_ID,
        direction: 'inbound',
        body: '   ',
        dedupeKey: 'dispute-comm-inbound:abc',
      }),
    ).rejects.toThrow();
  });

  it('rejects an empty dedupeKey', async () => {
    const { client } = mockClient();
    await expect(
      recordDisputeCommunication(client, {
        disputeId: DISPUTE_ID,
        direction: 'inbound',
        body: 'Carrier called.',
        dedupeKey: '',
      }),
    ).rejects.toThrow();
  });
});
