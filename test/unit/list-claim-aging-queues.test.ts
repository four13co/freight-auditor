import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { listClaimsDueForEscalation, listClaimsDueForFollowUp } from '../../src/modules/claims/list-claim-aging-queues.js';

const CLIENT_ID = '30000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-01T00:00:00.000Z');

function mockClient(resolved: unknown) {
  const query = vi.fn().mockResolvedValue(resolved);
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('listClaimsDueForFollowUp', () => {
  it('maps rows to camelCase with ISO timestamps', async () => {
    const { client, query } = mockClient({
      rows: [{ id: 'claim-1', aging_deadline_at: new Date('2026-08-01T00:00:00.000Z') }],
    });

    const result = await listClaimsDueForFollowUp(client, { clientId: CLIENT_ID, now: NOW });

    expect(result).toEqual([{ claimId: 'claim-1', agingDeadlineAt: '2026-08-01T00:00:00.000Z' }]);
    const call = query.mock.calls[0] as [string, unknown[]];
    const [sql, values] = call;
    expect(sql).toContain('aging_deadline_at IS NOT NULL');
    expect(sql).toContain('NOT EXISTS');
    expect(values[0]).toBe(CLIENT_ID);
    expect(values[1]).toBe(NOW.toISOString());
    expect(values[2]).toEqual(['claim.recovered', 'claim.denied', 'claim.written_off', 'claim.follow_up_sent']);
  });

  it('returns an empty array when nothing is due', async () => {
    const { client } = mockClient({ rows: [] });
    const result = await listClaimsDueForFollowUp(client, { clientId: CLIENT_ID, now: NOW });
    expect(result).toEqual([]);
  });

  it('defaults now to the current time when omitted', async () => {
    const { client, query } = mockClient({ rows: [] });
    await listClaimsDueForFollowUp(client, { clientId: CLIENT_ID });
    const call = query.mock.calls[0] as [string, unknown[]];
    expect(typeof call[1][1]).toBe('string');
  });
});

describe('listClaimsDueForEscalation', () => {
  it('maps rows to camelCase with ISO timestamps and defaults the grace period to 7 days', async () => {
    const { client, query } = mockClient({
      rows: [{ id: 'claim-2', follow_up_sent_at: new Date('2026-08-01T00:00:00.000Z') }],
    });

    const result = await listClaimsDueForEscalation(client, { clientId: CLIENT_ID, now: NOW });

    expect(result).toEqual([{ claimId: 'claim-2', followUpSentAt: '2026-08-01T00:00:00.000Z' }]);
    const call = query.mock.calls[0] as [string, unknown[]];
    const [sql, values] = call;
    expect(sql).toContain('make_interval(days => $4)');
    expect(values[0]).toBe(CLIENT_ID);
    expect(values[1]).toBe(NOW.toISOString());
    expect(values[2]).toBe('claim.follow_up_sent');
    expect(values[3]).toBe(7);
    expect(values[4]).toEqual(['claim.recovered', 'claim.denied', 'claim.written_off']);
  });

  it('accepts a caller-supplied gracePeriodDays', async () => {
    const { client, query } = mockClient({ rows: [] });
    await listClaimsDueForEscalation(client, { clientId: CLIENT_ID, now: NOW }, 14);
    const call = query.mock.calls[0] as [string, unknown[]];
    expect(call[1][3]).toBe(14);
  });

  it('returns an empty array when nothing is due', async () => {
    const { client } = mockClient({ rows: [] });
    const result = await listClaimsDueForEscalation(client, { clientId: CLIENT_ID, now: NOW });
    expect(result).toEqual([]);
  });
});
