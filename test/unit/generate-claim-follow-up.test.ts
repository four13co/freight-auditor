import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import { generateClaimFollowUp, GenerateClaimFollowUpError } from '../../src/modules/claims/generate-claim-follow-up.js';

const clientId = '10000000-0000-4000-8000-000000000001';
const claimId = '20000000-0000-4000-8000-000000000002';

describe('generateClaimFollowUp', () => {
  it('fails closed when the claim does not exist', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    try {
      await generateClaimFollowUp({ query } as unknown as PoolClient, { clientId, claimId });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GenerateClaimFollowUpError);
      expect((err as GenerateClaimFollowUpError).code).toBe('CLAIM_NOT_FOUND');
    }
  });

  it('refuses a claim already in a terminal status', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ status: 'recovered', aging_deadline_at: null }] });
    try {
      await generateClaimFollowUp({ query } as unknown as PoolClient, { clientId, claimId });
      expect.unreachable();
    } catch (err) {
      expect((err as GenerateClaimFollowUpError).code).toBe('CLAIM_TERMINAL');
    }
  });

  it('refuses a claim with no aging deadline set', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ status: 'open', aging_deadline_at: null }] });
    try {
      await generateClaimFollowUp({ query } as unknown as PoolClient, { clientId, claimId });
      expect.unreachable();
    } catch (err) {
      expect((err as GenerateClaimFollowUpError).code).toBe('DEADLINE_NOT_SET');
    }
  });

  it('refuses a claim whose deadline has not passed yet', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ status: 'open', aging_deadline_at: future }] });
    try {
      await generateClaimFollowUp({ query } as unknown as PoolClient, { clientId, claimId });
      expect.unreachable();
    } catch (err) {
      expect((err as GenerateClaimFollowUpError).code).toBe('DEADLINE_NOT_PASSED');
    }
  });

  it('is idempotent: returns created false when a follow-up event already exists', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ status: 'open', aging_deadline_at: past }] })
      .mockResolvedValueOnce({ rows: [{ id: 'existing-event-id' }] });
    const result = await generateClaimFollowUp({ query } as unknown as PoolClient, { clientId, claimId });
    expect(result).toEqual({ claimId, created: false });
  });
});
