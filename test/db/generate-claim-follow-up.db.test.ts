import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { generateClaimFollowUp, GenerateClaimFollowUpError } from '../../src/modules/claims/generate-claim-follow-up.js';

/**
 * 86e2zfj99 (P5.B.2). Depends on claim.aging_deadline_at (P5.B.1 / #178,
 * migration 0050) -- not runnable until that PR merges, matching #169's
 * declared dependency on workflow_instance (#160). Teardown order is
 * deepest-child-first (audit_event -> claim -> client).
 */
describe('generateClaimFollowUp (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `gcfu-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('GCFU-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('GCFU-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM claim WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedClaim(
    client: pg.PoolClient,
    opts: { clientId: string; status?: string; agingDeadlineAt?: Date | null },
  ): Promise<string> {
    const row = await client.query(
      `INSERT INTO claim (client_id, amount_claimed, currency, status, aging_deadline_at)
       VALUES ($1, '500.0000', 'USD', $2, $3) RETURNING id`,
      [opts.clientId, opts.status ?? 'open', opts.agingDeadlineAt ?? null],
    );
    return row.rows[0].id;
  }

  it('AC1: writes a claim.follow_up_sent audit event for a claim past its deadline', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { result, ledger } = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const claimId = await seedClaim(c, { clientId: clientAId, agingDeadlineAt: past });
      const result = await generateClaimFollowUp(c, clientAId, claimId);
      const ledger = await c.query(
        `SELECT event, actor_kind, detail FROM audit_event WHERE entity = 'claim' AND entity_id = $1`,
        [claimId],
      );
      return { result, ledger: ledger.rows[0] };
    });

    expect(result.created).toBe(true);
    expect(ledger).toMatchObject({ event: 'claim.follow_up_sent', actor_kind: 'system' });
  });

  it('AC2 (idempotent retry): a redelivered job for the same claim writes no duplicate event', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { count } = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const claimId = await seedClaim(c, { clientId: clientAId, agingDeadlineAt: past });
      const first = await generateClaimFollowUp(c, clientAId, claimId);
      const second = await generateClaimFollowUp(c, clientAId, claimId);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      const count = await c.query(
        `SELECT count(*)::int AS n FROM audit_event WHERE entity = 'claim' AND entity_id = $1 AND event = 'claim.follow_up_sent'`,
        [claimId],
      );
      return { count: count.rows[0].n };
    });
    expect(count).toBe(1);
  });

  it('AC5 (cross-tenant fail closed): a claim id outside the caller tenant scope is not found', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const claimId = await withTenantTx({ clientIds: [clientAId], internal: true }, (c) =>
      seedClaim(c, { clientId: clientAId, agingDeadlineAt: past }),
    );

    await expect(
      withTenantTx({ clientIds: [clientBId], internal: false }, (c) => generateClaimFollowUp(c, clientBId, claimId)),
    ).rejects.toBeInstanceOf(GenerateClaimFollowUpError);
  });

  it('refuses a claim with no deadline set', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const claimId = await seedClaim(c, { clientId: clientAId, agingDeadlineAt: null });
      await expect(generateClaimFollowUp(c, clientAId, claimId)).rejects.toMatchObject({ code: 'NO_DEADLINE_SET' });
    });
  });

  it('refuses a terminal claim even past its deadline', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const claimId = await seedClaim(c, { clientId: clientAId, status: 'recovered', agingDeadlineAt: past });
      await expect(generateClaimFollowUp(c, clientAId, claimId)).rejects.toMatchObject({ code: 'CLAIM_TERMINAL' });
    });
  });
});
