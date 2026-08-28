import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import { handleClaimFollowUpJob } from '../../src/jobs/claim-follow-up-handler.js';
import { JobPayloadValidationError } from '../../src/jobs/contracts.js';

const base = {
  schemaVersion: 1 as const,
  clientId: '10000000-0000-4000-8000-000000000001',
  idempotencyKey: 'claim:10000000-0000-4000-8000-000000000002:follow-up:v1',
  requestedAt: '2026-08-25T18:00:00-05:00',
  claimId: '10000000-0000-4000-8000-000000000002',
};

describe('handleClaimFollowUpJob', () => {
  it('rejects an invalid payload before touching the database', async () => {
    const query = vi.fn();
    await expect(handleClaimFollowUpJob({ query } as unknown as PoolClient, { ...base, claimId: undefined }))
      .rejects.toBeInstanceOf(JobPayloadValidationError);
    expect(query).not.toHaveBeenCalled();
  });
});
