import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { approveDispute } from '../../src/modules/disputes/approve-dispute.js';

const DISPUTE_ID = '70000000-0000-4000-8000-000000000001';
const CLIENT_ID = '70000000-0000-4000-8000-000000000004';
const ACTOR_USER_ID = '70000000-0000-4000-8000-000000000005';

function mockClient(opts: { updateRows?: unknown[] }) {
  const { updateRows = [] } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.startsWith('UPDATE dispute')) return Promise.resolve({ rows: updateRows });
    if (sql.includes('INSERT INTO audit_event')) return Promise.resolve({ rows: [{ id: 'audit-event-id', created: true }] });
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('approveDispute', () => {
  it('transitions a draft dispute to sent and writes an audit event', async () => {
    const { client, query } = mockClient({ updateRows: [{ id: DISPUTE_ID, client_id: CLIENT_ID }] });
    const result = await approveDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result).toEqual({ found: true });

    const updateCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).startsWith('UPDATE dispute')) as [string, unknown[]];
    expect(updateCall[0]).toContain("status = 'draft'");
    expect(updateCall[1]).toEqual([DISPUTE_ID]);

    const auditCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).includes('INSERT INTO audit_event')) as [string, unknown[]];
    expect(auditCall[1][4]).toBe('dispute.approved');
  });

  it('reports found: false for a dispute that is not currently draft (already approved or unknown)', async () => {
    const { client } = mockClient({ updateRows: [] });
    const result = await approveDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result).toEqual({ found: false });
  });

  it('is idempotent: approving an already-sent dispute a second time reports found: false rather than re-sending', async () => {
    // Simulates the second call in a real sequence -- the first UPDATE already
    // flipped status to 'sent', so a second WHERE status='draft' UPDATE matches nothing.
    const { client } = mockClient({ updateRows: [] });
    const result = await approveDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result.found).toBe(false);
  });
});
