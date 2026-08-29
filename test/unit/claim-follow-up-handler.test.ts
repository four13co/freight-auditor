import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { handleClaimFollowUpJob } from '../../src/jobs/claim-follow-up-handler.js';
import { JOB_NAMES, JobPayloadValidationError } from '../../src/jobs/contracts.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_ID = '10000000-0000-4000-8000-000000000002';

const basePayload = {
  schemaVersion: 1 as const,
  clientId: CLIENT_ID,
  idempotencyKey: `claim-follow-up:${CLAIM_ID}`,
  requestedAt: '2026-01-15T00:00:00-05:00',
  claimId: CLAIM_ID,
};

describe('handleClaimFollowUpJob', () => {
  it('parses the payload and delegates to generateClaimFollowUp', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM claim')) {
        return { rows: [{ id: CLAIM_ID, client_id: CLIENT_ID, status: 'open', aging_deadline_at: new Date('2026-01-01T00:00:00Z') }] };
      }
      if (sql.includes('INSERT INTO audit_event')) return { rows: [{ id: 'audit-1', created: true }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const client = { query } as unknown as pg.PoolClient;

    const result = await handleClaimFollowUpJob(client, basePayload);
    expect(result.claimId).toBe(CLAIM_ID);
    expect(result.created).toBe(true);
    expect(result.auditEventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects an invalid payload before touching the database', async () => {
    const query = vi.fn();
    const client = { query } as unknown as pg.PoolClient;

    await expect(handleClaimFollowUpJob(client, { ...basePayload, claimId: undefined }))
      .rejects.toBeInstanceOf(JobPayloadValidationError);
    expect(query).not.toHaveBeenCalled();
  });

  it('registers under FOLLOW_UP_CLAIM_V1', () => {
    expect(JOB_NAMES.FOLLOW_UP_CLAIM_V1).toBe('freight.claims.follow-up.v1');
  });
});
