import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { generateClaimFollowUp, GenerateClaimFollowUpError } from '../../src/modules/claims/generate-claim-follow-up.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_ID = '10000000-0000-4000-8000-000000000002';

function mockClient(claimRow: Record<string, unknown> | null, auditResult: { id: string; created: boolean }) {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM claim')) return { rows: claimRow ? [claimRow] : [] };
    if (sql.includes('INSERT INTO audit_event')) return { rows: [auditResult] };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('generateClaimFollowUp (unit, mocked client)', () => {
  it('writes a claim.follow_up_sent audit event for an open claim past its deadline', async () => {
    const past = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-15T00:00:00Z');
    const { client, query } = mockClient(
      { id: CLAIM_ID, client_id: CLIENT_ID, status: 'open', aging_deadline_at: past },
      { id: 'audit-1', created: true },
    );

    const result = await generateClaimFollowUp(client, CLIENT_ID, CLAIM_ID, now);

    expect(result.claimId).toBe(CLAIM_ID);
    expect(result.created).toBe(true);
    expect(result.auditEventId).toMatch(/^[0-9a-f-]{36}$/);
    const auditCall = query.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO audit_event'));
    expect(auditCall).toBeTruthy();
    const [, params] = auditCall as [string, unknown[]];
    // detail is the last param; confirm the Date was converted to an ISO string, not passed raw.
    expect(params[params.length - 1]).toEqual({ agingDeadlineAt: past.toISOString() });
  });

  it('is idempotent: a redelivered job for the same claim returns created: false, writes no duplicate', async () => {
    const past = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-15T00:00:00Z');
    const { client } = mockClient(
      { id: CLAIM_ID, client_id: CLIENT_ID, status: 'open', aging_deadline_at: past },
      { id: 'audit-1', created: false },
    );

    const result = await generateClaimFollowUp(client, CLIENT_ID, CLAIM_ID, now);
    expect(result.created).toBe(false);
  });

  it('throws CLAIM_NOT_FOUND for an unknown or cross-tenant claim', async () => {
    const { client } = mockClient(null, { id: 'unused', created: false });
    await expect(generateClaimFollowUp(client, CLIENT_ID, CLAIM_ID)).rejects.toThrow(GenerateClaimFollowUpError);
    await expect(generateClaimFollowUp(client, CLIENT_ID, CLAIM_ID)).rejects.toMatchObject({ code: 'CLAIM_NOT_FOUND' });
  });

  it.each(['recovered', 'denied', 'written_off'])('throws CLAIM_TERMINAL for a %s claim', async (status) => {
    const { client } = mockClient(
      { id: CLAIM_ID, client_id: CLIENT_ID, status, aging_deadline_at: new Date('2026-01-01T00:00:00Z') },
      { id: 'unused', created: false },
    );
    await expect(generateClaimFollowUp(client, CLIENT_ID, CLAIM_ID)).rejects.toMatchObject({ code: 'CLAIM_TERMINAL' });
  });

  it('throws NO_DEADLINE_SET when aging_deadline_at is null', async () => {
    const { client } = mockClient(
      { id: CLAIM_ID, client_id: CLIENT_ID, status: 'open', aging_deadline_at: null },
      { id: 'unused', created: false },
    );
    await expect(generateClaimFollowUp(client, CLIENT_ID, CLAIM_ID)).rejects.toMatchObject({ code: 'NO_DEADLINE_SET' });
  });

  it('throws DEADLINE_NOT_PASSED when the deadline is still in the future', async () => {
    const future = new Date('2026-02-01T00:00:00Z');
    const now = new Date('2026-01-15T00:00:00Z');
    const { client } = mockClient(
      { id: CLAIM_ID, client_id: CLIENT_ID, status: 'open', aging_deadline_at: future },
      { id: 'unused', created: false },
    );
    await expect(generateClaimFollowUp(client, CLIENT_ID, CLAIM_ID, now)).rejects.toMatchObject({ code: 'DEADLINE_NOT_PASSED' });
  });
});
