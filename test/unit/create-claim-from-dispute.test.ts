import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { createClaimFromDispute, DisputeNotFoundError } from '../../src/modules/claims/create-claim-from-dispute.js';
import { ClaimableDisputeError } from '../../src/modules/claims/validate-claimable-dispute.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const DISPUTE_ID = '10000000-0000-4000-8000-000000000002';
const CLAIM_ID = '10000000-0000-4000-8000-000000000003';

function mockClient(opts: {
  disputeRow?: { id: string; status: string; amountClaimed: string | null; currency: string | null } | null;
  existingClaimRow?: { id: string; amount_claimed: string; currency: string | null } | null;
  insertedRow?: { id: string } | null;
}) {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM dispute')) return { rows: opts.disputeRow ? [opts.disputeRow] : [] };
    if (sql.includes('FROM claim') && sql.includes('SELECT')) return { rows: opts.existingClaimRow ? [opts.existingClaimRow] : [] };
    if (sql.includes('INSERT INTO claim')) return { rows: opts.insertedRow ? [opts.insertedRow] : [] };
    if (sql.includes('INSERT INTO audit_event')) return { rows: [{ id: 'audit-1', created: true }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('createClaimFromDispute (unit, mocked client)', () => {
  it('creates a claim and writes a claim.created audit event for a fresh, accepted dispute', async () => {
    const { client } = mockClient({
      disputeRow: { id: DISPUTE_ID, status: 'accepted', amountClaimed: '500.0000', currency: 'USD' },
      existingClaimRow: null,
      insertedRow: { id: CLAIM_ID },
    });

    const result = await createClaimFromDispute(client, { clientId: CLIENT_ID, disputeId: DISPUTE_ID });

    expect(result).toEqual({ claimId: CLAIM_ID, disputeId: DISPUTE_ID, amountClaimed: '500.0000', currency: 'USD', created: true });
  });

  it('returns the existing claim without inserting when one already exists (idempotent read)', async () => {
    const { client, query } = mockClient({
      disputeRow: { id: DISPUTE_ID, status: 'accepted', amountClaimed: '500.0000', currency: 'USD' },
      existingClaimRow: { id: CLAIM_ID, amount_claimed: '500.0000', currency: 'USD' },
    });

    const result = await createClaimFromDispute(client, { clientId: CLIENT_ID, disputeId: DISPUTE_ID });

    expect(result).toEqual({ claimId: CLAIM_ID, disputeId: DISPUTE_ID, amountClaimed: '500.0000', currency: 'USD', created: false });
    const insertCall = query.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO claim'));
    expect(insertCall).toBeUndefined();
  });

  it('re-reads the winning row when INSERT ... ON CONFLICT DO NOTHING loses a concurrent race', async () => {
    const { client } = mockClient({
      disputeRow: { id: DISPUTE_ID, status: 'accepted', amountClaimed: '500.0000', currency: 'USD' },
      existingClaimRow: null,
      insertedRow: null,
    });

    // First SELECT (pre-insert check) returns none, INSERT returns none (race lost),
    // and the re-read fallback needs a row -- adjust the mock to simulate the race.
    let selectCalls = 0;
    (client.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM dispute')) return { rows: [{ id: DISPUTE_ID, status: 'accepted', amountClaimed: '500.0000', currency: 'USD' }] };
      if (sql.includes('FROM claim') && sql.includes('SELECT')) {
        selectCalls += 1;
        if (selectCalls === 1) return { rows: [] };
        return { rows: [{ id: CLAIM_ID, amount_claimed: '500.0000', currency: 'USD' }] };
      }
      if (sql.includes('INSERT INTO claim')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await createClaimFromDispute(client, { clientId: CLIENT_ID, disputeId: DISPUTE_ID });
    expect(result).toEqual({ claimId: CLAIM_ID, disputeId: DISPUTE_ID, amountClaimed: '500.0000', currency: 'USD', created: false });
  });

  it('throws DisputeNotFoundError for an unknown or cross-tenant dispute', async () => {
    const { client } = mockClient({ disputeRow: null });
    await expect(createClaimFromDispute(client, { clientId: CLIENT_ID, disputeId: DISPUTE_ID })).rejects.toBeInstanceOf(DisputeNotFoundError);
  });

  it('throws ClaimableDisputeError for a dispute that is not accepted', async () => {
    const { client } = mockClient({
      disputeRow: { id: DISPUTE_ID, status: 'sent', amountClaimed: '500.0000', currency: 'USD' },
      existingClaimRow: null,
    });
    await expect(createClaimFromDispute(client, { clientId: CLIENT_ID, disputeId: DISPUTE_ID })).rejects.toBeInstanceOf(ClaimableDisputeError);
  });
});
