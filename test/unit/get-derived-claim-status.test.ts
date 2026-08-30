import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { getDerivedClaimStatus, GetDerivedClaimStatusError } from '../../src/modules/claims/get-derived-claim-status.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_ID = '10000000-0000-4000-8000-000000000002';

function mockClient(opts: {
  claimRow?: { status: string } | null;
  terminalEvents?: { event: string; recorded_at: Date }[];
  recoveryEvents?: { amount_recovered: string }[];
}) {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM claim')) return { rows: opts.claimRow ? [opts.claimRow] : [] };
    if (sql.includes('FROM audit_event')) return { rows: opts.terminalEvents ?? [] };
    if (sql.includes('FROM recovery_event')) return { rows: opts.recoveryEvents ?? [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('getDerivedClaimStatus (unit, mocked client)', () => {
  it('reads all three sources and derives the status via deriveClaimStatus, converting recorded_at Date correctly', async () => {
    const { client } = mockClient({
      claimRow: { status: 'recovered' },
      terminalEvents: [{ event: 'claim.recovered', recorded_at: new Date('2026-01-01T00:00:00Z') }],
      recoveryEvents: [{ amount_recovered: '500.0000' }],
    });

    const result = await getDerivedClaimStatus(client, CLIENT_ID, CLAIM_ID);
    expect(result).toEqual({ derivedStatus: 'recovered', cumulativeRecovered: '500.0000', matches: true });
  });

  it('handles 2+ terminal events without throwing (the bug that closed the prior PR)', async () => {
    const { client } = mockClient({
      claimRow: { status: 'written_off' },
      terminalEvents: [
        { event: 'claim.denied', recorded_at: new Date('2026-01-01T00:00:00Z') },
        { event: 'claim.written_off', recorded_at: new Date('2026-01-05T00:00:00Z') },
      ],
      recoveryEvents: [],
    });

    const result = await getDerivedClaimStatus(client, CLIENT_ID, CLAIM_ID);
    expect(result.derivedStatus).toBe('written_off');
    expect(result.matches).toBe(true);
  });

  it('throws GetDerivedClaimStatusError for an unknown or cross-tenant claim', async () => {
    const { client } = mockClient({ claimRow: null });
    await expect(getDerivedClaimStatus(client, CLIENT_ID, CLAIM_ID)).rejects.toBeInstanceOf(GetDerivedClaimStatusError);
    await expect(getDerivedClaimStatus(client, CLIENT_ID, CLAIM_ID)).rejects.toMatchObject({ code: 'CLAIM_NOT_FOUND' });
  });

  it('derives "open" for a claim with no events at all', async () => {
    const { client } = mockClient({ claimRow: { status: 'open' } });
    const result = await getDerivedClaimStatus(client, CLIENT_ID, CLAIM_ID);
    expect(result).toEqual({ derivedStatus: 'open', cumulativeRecovered: '0.0000', matches: true });
  });
});
