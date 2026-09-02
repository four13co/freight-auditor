import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  acceptDispute,
  rejectDispute,
  partiallyAcceptDispute,
  closeDispute,
  DisputeTransitionError,
} from '../../src/modules/disputes/resolve-dispute.js';

const DISPUTE_ID = '70000000-0000-4000-8000-000000000001';
const CLIENT_ID = '70000000-0000-4000-8000-000000000004';
const ACTOR_USER_ID = '70000000-0000-4000-8000-000000000005';
/** Mirrors resolve-dispute.ts's own private RESPONDABLE_STATUSES -- not exported, so duplicated here for the exact-params assertion below. */
const RESPONDABLE_STATUSES = ['sent', 'in_progress'];

/**
 * Mirrors approve-dispute.test.ts's mockClient shape: a SELECT to read the
 * dispute's current row, then a guarded UPDATE re-checking the same
 * from-state (race-safety -- see resolve-dispute.ts's header comment), then
 * an audit_event insert. `selectRow: null` simulates "not found or already
 * resolved" (the SELECT itself returns nothing, or returns a row whose
 * status isn't in the caller's from-set).
 */
function mockClient(opts: { selectRow?: Record<string, unknown> | null; updateRows?: unknown[] }) {
  const { selectRow = null, updateRows = [] } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.startsWith('SELECT id, client_id, status, amount_claimed FROM dispute')) {
      return Promise.resolve({ rows: selectRow ? [selectRow] : [] });
    }
    if (sql.startsWith('UPDATE dispute')) return Promise.resolve({ rows: updateRows });
    if (sql.includes('INSERT INTO audit_event')) return Promise.resolve({ rows: [{ id: 'audit-event-id', created: true }] });
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('acceptDispute', () => {
  it('transitions a sent dispute to accepted and writes an audit event', async () => {
    const { client, query } = mockClient({
      selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'sent', amount_claimed: '500.0000' },
      updateRows: [{ id: DISPUTE_ID, client_id: CLIENT_ID }],
    });
    const result = await acceptDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result).toEqual({ found: true });

    const updateCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).startsWith('UPDATE dispute')) as [string, unknown[]];
    expect(updateCall[0]).toContain("status = 'accepted'");

    const auditCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).includes('INSERT INTO audit_event')) as [string, unknown[]];
    expect(auditCall[1][4]).toBe('dispute.accepted');
    expect((auditCall[1][9] as { fromStatus: string; toStatus: string }).toStatus).toBe('accepted');
  });

  it('accepts an in_progress dispute too', async () => {
    const { client } = mockClient({
      selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'in_progress', amount_claimed: '500.0000' },
      updateRows: [{ id: DISPUTE_ID, client_id: CLIENT_ID }],
    });
    const result = await acceptDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result).toEqual({ found: true });
  });

  it('reports found: false for a dispute that is not found', async () => {
    const { client } = mockClient({ selectRow: null });
    const result = await acceptDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result).toEqual({ found: false });
  });

  it('reports found: false for a dispute in a non-respondable status (e.g. draft)', async () => {
    const { client, query } = mockClient({ selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'draft', amount_claimed: '500.0000' } });
    const result = await acceptDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result).toEqual({ found: false });
    expect(query.mock.calls.some((c: unknown[]) => (c[0] as string).startsWith('UPDATE dispute'))).toBe(false);
  });

  it('is idempotent: accepting an already-accepted dispute a second time reports found: false', async () => {
    const { client } = mockClient({ selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'accepted', amount_claimed: '500.0000' } });
    const result = await acceptDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result.found).toBe(false);
  });

  it('reports found: false when the row changed between the SELECT and the guarded UPDATE (race)', async () => {
    const { client } = mockClient({
      selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'sent', amount_claimed: '500.0000' },
      updateRows: [], // a concurrent transaction already moved it out of the from-set
    });
    const result = await acceptDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result).toEqual({ found: false });
  });
});

describe('rejectDispute', () => {
  it('transitions a sent dispute to rejected and writes an audit event', async () => {
    const { client, query } = mockClient({
      selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'sent', amount_claimed: '500.0000' },
      updateRows: [{ id: DISPUTE_ID, client_id: CLIENT_ID }],
    });
    const result = await rejectDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result).toEqual({ found: true });

    const updateCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).startsWith('UPDATE dispute')) as [string, unknown[]];
    expect(updateCall[0]).toContain("status = 'rejected'");

    const auditCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).includes('INSERT INTO audit_event')) as [string, unknown[]];
    expect(auditCall[1][4]).toBe('dispute.rejected');
  });

  it('reports found: false for a dispute in a non-respondable status', async () => {
    const { client } = mockClient({ selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'closed', amount_claimed: '500.0000' } });
    const result = await rejectDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result).toEqual({ found: false });
  });
});

describe('partiallyAcceptDispute', () => {
  it('transitions a sent dispute to partial, records accepted_amount, and writes an audit event', async () => {
    const { client, query } = mockClient({
      selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'sent', amount_claimed: '500.0000' },
      updateRows: [{ id: DISPUTE_ID, client_id: CLIENT_ID }],
    });
    const result = await partiallyAcceptDispute(client, DISPUTE_ID, ACTOR_USER_ID, '300.0000');
    expect(result).toEqual({ found: true });

    const updateCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).startsWith('UPDATE dispute')) as [string, unknown[]];
    expect(updateCall[0]).toContain("status = 'partial'");
    expect(updateCall[1]).toEqual([DISPUTE_ID, '300.0000', RESPONDABLE_STATUSES]);

    const auditCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).includes('INSERT INTO audit_event')) as [string, unknown[]];
    expect(auditCall[1][4]).toBe('dispute.partially_accepted');
    expect((auditCall[1][9] as { acceptedAmount: string }).acceptedAmount).toBe('300.0000');
  });

  it('rejects an accepted amount greater than amount_claimed without writing anything', async () => {
    const { client, query } = mockClient({
      selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'sent', amount_claimed: '500.0000' },
    });
    await expect(partiallyAcceptDispute(client, DISPUTE_ID, ACTOR_USER_ID, '600.0000'))
      .rejects.toThrow(DisputeTransitionError);
    expect(query.mock.calls.some((c: unknown[]) => (c[0] as string).startsWith('UPDATE dispute'))).toBe(false);
  });

  it('allows an accepted amount exactly equal to amount_claimed', async () => {
    const { client } = mockClient({
      selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'sent', amount_claimed: '500.0000' },
      updateRows: [{ id: DISPUTE_ID, client_id: CLIENT_ID }],
    });
    const result = await partiallyAcceptDispute(client, DISPUTE_ID, ACTOR_USER_ID, '500.0000');
    expect(result).toEqual({ found: true });
  });

  it('skips the amount-claimed check when amount_claimed is null (nothing to compare against)', async () => {
    const { client } = mockClient({
      selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'sent', amount_claimed: null },
      updateRows: [{ id: DISPUTE_ID, client_id: CLIENT_ID }],
    });
    const result = await partiallyAcceptDispute(client, DISPUTE_ID, ACTOR_USER_ID, '999.0000');
    expect(result).toEqual({ found: true });
  });

  it('reports found: false for a dispute that is not found', async () => {
    const { client } = mockClient({ selectRow: null });
    const result = await partiallyAcceptDispute(client, DISPUTE_ID, ACTOR_USER_ID, '100.0000');
    expect(result).toEqual({ found: false });
  });
});

describe('closeDispute', () => {
  it('closes an accepted dispute and writes an audit event', async () => {
    const { client, query } = mockClient({
      selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'accepted', amount_claimed: '500.0000' },
      updateRows: [{ id: DISPUTE_ID, client_id: CLIENT_ID }],
    });
    const result = await closeDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result).toEqual({ found: true });

    const updateCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).startsWith('UPDATE dispute')) as [string, unknown[]];
    expect(updateCall[0]).toContain("status = 'closed'");

    const auditCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).includes('INSERT INTO audit_event')) as [string, unknown[]];
    expect(auditCall[1][4]).toBe('dispute.closed');
  });

  it('closes a rejected dispute', async () => {
    const { client } = mockClient({
      selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'rejected', amount_claimed: '500.0000' },
      updateRows: [{ id: DISPUTE_ID, client_id: CLIENT_ID }],
    });
    const result = await closeDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result).toEqual({ found: true });
  });

  it('closes a partial dispute', async () => {
    const { client } = mockClient({
      selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'partial', amount_claimed: '500.0000' },
      updateRows: [{ id: DISPUTE_ID, client_id: CLIENT_ID }],
    });
    const result = await closeDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result).toEqual({ found: true });
  });

  it('reports found: false for a dispute still in a draft/sent/in_progress state (nothing to close yet)', async () => {
    const { client, query } = mockClient({ selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'sent', amount_claimed: '500.0000' } });
    const result = await closeDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result).toEqual({ found: false });
    expect(query.mock.calls.some((c: unknown[]) => (c[0] as string).startsWith('UPDATE dispute'))).toBe(false);
  });

  it('is idempotent: closing an already-closed dispute a second time reports found: false', async () => {
    const { client } = mockClient({ selectRow: { id: DISPUTE_ID, client_id: CLIENT_ID, status: 'closed', amount_claimed: '500.0000' } });
    const result = await closeDispute(client, DISPUTE_ID, ACTOR_USER_ID);
    expect(result.found).toBe(false);
  });
});
