import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { createClaimFromDispute, DisputeNotFoundError } from '../../src/modules/claims/create-claim-from-dispute.js';
import { ClaimableDisputeError } from '../../src/modules/claims/validate-claimable-dispute.js';
import { cleanupTenantFixtures } from './helpers/cleanup-tenant-fixtures.js';

/**
 * 86e2zfj3w (P5.A.1). Teardown goes through cleanupTenantFixtures
 * (86e30txkx), which derives a FK-safe delete order from the live schema --
 * the exact ordering #165's review closure found broken by hand (client
 * deleted before the audit_event rows the test itself wrote).
 */
describe('createClaimFromDispute (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `ccfd-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('CCFD-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('CCFD-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    await cleanupTenantFixtures(pool, [clientAId, clientBId]);
    await closePool();
  });

  async function seedDispute(
    client: pg.PoolClient,
    opts: { clientId: string; status?: string; amountClaimed?: string | null; currency?: string | null },
  ): Promise<string> {
    const row = await client.query(
      `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, $2, $3, $4) RETURNING id`,
      [opts.clientId, opts.status ?? 'accepted', opts.amountClaimed ?? '500.0000', opts.currency ?? 'USD'],
    );
    return row.rows[0].id;
  }

  it('AC1: opens a claim from an accepted dispute and writes a claim.created audit event', async () => {
    const { result, ledger } = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const disputeId = await seedDispute(c, { clientId: clientAId });
      const result = await createClaimFromDispute(c, { clientId: clientAId, disputeId });
      const ledger = await c.query(
        `SELECT event, actor_kind, detail FROM audit_event WHERE entity = 'claim' AND entity_id = $1`,
        [result.claimId],
      );
      return { result, ledger: ledger.rows[0] };
    });

    expect(result.created).toBe(true);
    expect(result.amountClaimed).toBe('500.0000');
    expect(result.currency).toBe('USD');
    expect(ledger).toMatchObject({ event: 'claim.created', actor_kind: 'analyst' });
  });

  it('AC2 (idempotent retry): a second create for the same dispute returns the existing claim, writes no duplicate', async () => {
    const { first, second, count } = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const disputeId = await seedDispute(c, { clientId: clientAId });
      const first = await createClaimFromDispute(c, { clientId: clientAId, disputeId });
      const second = await createClaimFromDispute(c, { clientId: clientAId, disputeId });
      const count = await c.query(`SELECT count(*)::int AS n FROM claim WHERE client_id = $1 AND dispute_id = $2`, [
        clientAId, disputeId,
      ]);
      return { first, second, count: count.rows[0].n };
    });

    expect(second.claimId).toBe(first.claimId);
    expect(second.created).toBe(false);
    expect(count).toBe(1);
  });

  it('AC4 (duplicate/retry stability): concurrent creates for the same dispute never violate the UNIQUE constraint', async () => {
    const results = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const disputeId = await seedDispute(c, { clientId: clientAId });
      return Promise.all([
        createClaimFromDispute(c, { clientId: clientAId, disputeId }),
        createClaimFromDispute(c, { clientId: clientAId, disputeId }),
      ]);
    });
    expect(results[0].claimId).toBe(results[1].claimId);
  });

  it('AC5 (cross-tenant fail closed): a dispute id outside the caller tenant scope is not found', async () => {
    const disputeId = await withTenantTx({ clientIds: [clientAId], internal: true }, (c) =>
      seedDispute(c, { clientId: clientAId }),
    );

    await expect(
      withTenantTx({ clientIds: [clientBId], internal: false }, (c) =>
        createClaimFromDispute(c, { clientId: clientBId, disputeId }),
      ),
    ).rejects.toBeInstanceOf(DisputeNotFoundError);
  });

  it('refuses a dispute that is not yet accepted', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const disputeId = await seedDispute(c, { clientId: clientAId, status: 'sent' });
      await expect(createClaimFromDispute(c, { clientId: clientAId, disputeId })).rejects.toBeInstanceOf(ClaimableDisputeError);
    });
  });

  it('refuses an unknown dispute id', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, (c) =>
      expect(createClaimFromDispute(c, { clientId: clientAId, disputeId: '99999999-9999-4999-8999-999999999999' }))
        .rejects.toBeInstanceOf(DisputeNotFoundError),
    );
  });
});
