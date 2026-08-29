import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { handleClaimEscalationJob } from '../../src/jobs/claim-escalation-handler.js';
import { JOB_NAMES, JobPayloadValidationError } from '../../src/jobs/contracts.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_ID = '10000000-0000-4000-8000-000000000002';

const basePayload = {
  schemaVersion: 1 as const,
  clientId: CLIENT_ID,
  idempotencyKey: `claim-escalation:${CLAIM_ID}`,
  requestedAt: '2026-01-15T00:00:00-05:00',
  claimId: CLAIM_ID,
};

describe('handleClaimEscalationJob', () => {
  it('parses the payload and delegates to generateClaimEscalation', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM claim')) return { rows: [{ id: CLAIM_ID, client_id: CLIENT_ID, status: 'open' }] };
      if (sql.includes('FROM audit_event') && sql.includes('ORDER BY recorded_at')) {
        return { rows: [{ recorded_at: new Date('2026-01-01T00:00:00Z') }] };
      }
      if (sql.includes('INSERT INTO audit_event')) return { rows: [{ id: 'audit-1', created: true }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const client = { query } as unknown as pg.PoolClient;

    const result = await handleClaimEscalationJob(client, basePayload);
    expect(result.claimId).toBe(CLAIM_ID);
    expect(result.created).toBe(true);
  });

  it('rejects an invalid payload before touching the database', async () => {
    const query = vi.fn();
    const client = { query } as unknown as pg.PoolClient;

    await expect(handleClaimEscalationJob(client, { ...basePayload, claimId: undefined }))
      .rejects.toBeInstanceOf(JobPayloadValidationError);
    expect(query).not.toHaveBeenCalled();
  });

  it('registers under ESCALATE_CLAIM_V1', () => {
    expect(JOB_NAMES.ESCALATE_CLAIM_V1).toBe('freight.claims.escalate.v1');
  });
});
