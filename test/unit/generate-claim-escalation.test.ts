import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { generateClaimEscalation, GenerateClaimEscalationError } from '../../src/modules/claims/generate-claim-escalation.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_ID = '10000000-0000-4000-8000-000000000002';

function mockClient(opts: {
  claimRow?: { id: string; client_id: string; status: string } | null;
  followUpRow?: { recorded_at: Date } | null;
  auditResult?: { id: string; created: boolean };
}) {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM claim')) return { rows: opts.claimRow ? [opts.claimRow] : [] };
    if (sql.includes('FROM audit_event') && sql.includes('ORDER BY recorded_at')) {
      return { rows: opts.followUpRow ? [opts.followUpRow] : [] };
    }
    if (sql.includes('INSERT INTO audit_event')) return { rows: [opts.auditResult ?? { id: 'audit-1', created: true }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('generateClaimEscalation (unit, mocked client)', () => {
  it('writes a claim.escalated audit event when the grace period since follow-up has elapsed', async () => {
    const followUpAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-10T00:00:00Z'); // 9 days later, past the 7-day default grace period
    const { client, query } = mockClient({
      claimRow: { id: CLAIM_ID, client_id: CLIENT_ID, status: 'open' },
      followUpRow: { recorded_at: followUpAt },
    });

    const result = await generateClaimEscalation(client, CLIENT_ID, CLAIM_ID, now);

    expect(result.claimId).toBe(CLAIM_ID);
    expect(result.created).toBe(true);
    const auditCall = query.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO audit_event'));
    expect(auditCall).toBeTruthy();
    const [, params] = auditCall as [string, unknown[]];
    // detail is the last param; confirm the follow-up Date was converted to an ISO string, not passed raw.
    expect(params[params.length - 1]).toEqual({ followUpRecordedAt: followUpAt.toISOString(), gracePeriodDays: 7 });
  });

  it('is idempotent: a redelivered job returns created: false, writes no duplicate', async () => {
    const followUpAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-10T00:00:00Z');
    const { client } = mockClient({
      claimRow: { id: CLAIM_ID, client_id: CLIENT_ID, status: 'open' },
      followUpRow: { recorded_at: followUpAt },
      auditResult: { id: 'audit-1', created: false },
    });

    const result = await generateClaimEscalation(client, CLIENT_ID, CLAIM_ID, now);
    expect(result.created).toBe(false);
  });

  it('throws CLAIM_NOT_FOUND for an unknown or cross-tenant claim', async () => {
    const { client } = mockClient({ claimRow: null });
    await expect(generateClaimEscalation(client, CLIENT_ID, CLAIM_ID)).rejects.toMatchObject({ code: 'CLAIM_NOT_FOUND' });
  });

  it.each(['recovered', 'denied', 'written_off'])('throws CLAIM_TERMINAL for a %s claim', async (status) => {
    const { client } = mockClient({ claimRow: { id: CLAIM_ID, client_id: CLIENT_ID, status } });
    await expect(generateClaimEscalation(client, CLIENT_ID, CLAIM_ID)).rejects.toMatchObject({ code: 'CLAIM_TERMINAL' });
  });

  it('throws NO_FOLLOW_UP_SENT when the claim has no follow-up marker (escalation cannot skip the follow-up stage)', async () => {
    const { client } = mockClient({
      claimRow: { id: CLAIM_ID, client_id: CLIENT_ID, status: 'open' },
      followUpRow: null,
    });
    await expect(generateClaimEscalation(client, CLIENT_ID, CLAIM_ID)).rejects.toMatchObject({ code: 'NO_FOLLOW_UP_SENT' });
  });

  it('throws GRACE_PERIOD_NOT_ELAPSED when the follow-up is too recent', async () => {
    const followUpAt = new Date('2026-01-08T00:00:00Z');
    const now = new Date('2026-01-10T00:00:00Z'); // only 2 days later, default grace is 7
    const { client } = mockClient({
      claimRow: { id: CLAIM_ID, client_id: CLIENT_ID, status: 'open' },
      followUpRow: { recorded_at: followUpAt },
    });
    await expect(generateClaimEscalation(client, CLIENT_ID, CLAIM_ID, now)).rejects.toMatchObject({ code: 'GRACE_PERIOD_NOT_ELAPSED' });
  });

  it('respects a caller-supplied non-default grace period', async () => {
    const followUpAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-03T00:00:00Z'); // 2 days later
    const { client } = mockClient({
      claimRow: { id: CLAIM_ID, client_id: CLIENT_ID, status: 'open' },
      followUpRow: { recorded_at: followUpAt },
    });
    const result = await generateClaimEscalation(client, CLIENT_ID, CLAIM_ID, now, 1);
    expect(result.created).toBe(true);
  });

  it('throws GenerateClaimEscalationError, not a generic Error, on every refusal', async () => {
    const { client } = mockClient({ claimRow: null });
    await expect(generateClaimEscalation(client, CLIENT_ID, CLAIM_ID)).rejects.toBeInstanceOf(GenerateClaimEscalationError);
  });
});
