import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import { generateClaimEscalation, GenerateClaimEscalationError } from '../../src/modules/claims/generate-claim-escalation.js';

const clientId = '10000000-0000-4000-8000-000000000001';
const claimId = '20000000-0000-4000-8000-000000000002';

describe('generateClaimEscalation', () => {
  it('fails closed when the claim does not exist', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    try {
      await generateClaimEscalation({ query } as unknown as PoolClient, { clientId, claimId });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GenerateClaimEscalationError);
      expect((err as GenerateClaimEscalationError).code).toBe('CLAIM_NOT_FOUND');
    }
  });

  it('refuses a claim already in a terminal status', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ status: 'denied' }] });
    try {
      await generateClaimEscalation({ query } as unknown as PoolClient, { clientId, claimId });
      expect.unreachable();
    } catch (err) {
      expect((err as GenerateClaimEscalationError).code).toBe('CLAIM_TERMINAL');
    }
  });

  it('refuses a claim with no follow-up event yet', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [] });
    try {
      await generateClaimEscalation({ query } as unknown as PoolClient, { clientId, claimId });
      expect.unreachable();
    } catch (err) {
      expect((err as GenerateClaimEscalationError).code).toBe('NO_FOLLOW_UP_SENT');
    }
  });

  it('refuses escalation before the grace period has elapsed', async () => {
    const recentFollowUp = new Date(Date.now() - 60_000).toISOString();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ recorded_at: recentFollowUp }] });
    try {
      await generateClaimEscalation({ query } as unknown as PoolClient, { clientId, claimId });
      expect.unreachable();
    } catch (err) {
      expect((err as GenerateClaimEscalationError).code).toBe('GRACE_PERIOD_NOT_ELAPSED');
    }
  });

  it('is idempotent: returns created false when an escalation event already exists', async () => {
    const oldFollowUp = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ recorded_at: oldFollowUp }] })
      .mockResolvedValueOnce({ rows: [{ id: 'existing-escalation-id' }] });
    const result = await generateClaimEscalation({ query } as unknown as PoolClient, { clientId, claimId });
    expect(result).toEqual({ claimId, created: false });
  });
});
