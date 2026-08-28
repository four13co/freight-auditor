import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import {
  createClaimFromDispute,
  DisputeNotFoundError,
} from '../../src/modules/claims/create-claim-from-dispute.js';
import { ClaimableDisputeError } from '../../src/modules/claims/validate-claimable-dispute.js';

/**
 * 86e2zfj3w: creating a claim from an accepted dispute (P5.A.1).
 */
describe('createClaimFromDispute (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `cfd-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('CFD-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('CFD-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM claim WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM dispute WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedDispute(
    client: pg.PoolClient,
    opts: { clientId: string; status?: string; amountClaimed?: string | null; currency?: string | null },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO dispute (client_id, status, amount_claimed, currency)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [opts.clientId, opts.status ?? 'accepted', opts.amountClaimed ?? '250.0000', opts.currency ?? 'USD'],
    );
    return rows[0]!.id;
  }

  it('creates a claim from an accepted dispute', async () => {
    const disputeId = await withTenantTx({ clientIds: [clientAId] }, (client) =>
      seedDispute(client, { clientId: clientAId }),
    );

    const result = await withTenantTx({ clientIds: [clientAId] }, (client) =>
      createClaimFromDispute(client, { clientId: clientAId, disputeId }),
    );

    expect(result.created).toBe(true);
    expect(result.disputeId).toBe(disputeId);
    expect(result.amountClaimed).toBe('250.0000');
    expect(result.currency).toBe('USD');

    const { rows } = await pool.query(`SELECT status, dispute_id FROM claim WHERE id = $1`, [result.claimId]);
    expect(rows[0].status).toBe('open');
    expect(rows[0].dispute_id).toBe(disputeId);
  });

  it('is idempotent on retry for the same dispute', async () => {
    const disputeId = await withTenantTx({ clientIds: [clientAId] }, (client) =>
      seedDispute(client, { clientId: clientAId }),
    );

    const first = await withTenantTx({ clientIds: [clientAId] }, (client) =>
      createClaimFromDispute(client, { clientId: clientAId, disputeId }),
    );
    const second = await withTenantTx({ clientIds: [clientAId] }, (client) =>
      createClaimFromDispute(client, { clientId: clientAId, disputeId }),
    );

    expect(second.created).toBe(false);
    expect(second.claimId).toBe(first.claimId);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM claim WHERE dispute_id = $1`, [disputeId]);
    expect(rows[0].n).toBe(1);
  });

  it('rejects a dispute that is not accepted', async () => {
    const disputeId = await withTenantTx({ clientIds: [clientAId] }, (client) =>
      seedDispute(client, { clientId: clientAId, status: 'sent' }),
    );

    await expect(
      withTenantTx({ clientIds: [clientAId] }, (client) =>
        createClaimFromDispute(client, { clientId: clientAId, disputeId }),
      ),
    ).rejects.toBeInstanceOf(ClaimableDisputeError);
  });

  it('fails not-found for a dispute belonging to a different tenant', async () => {
    const disputeId = await withTenantTx({ clientIds: [clientAId] }, (client) =>
      seedDispute(client, { clientId: clientAId }),
    );

    await expect(
      withTenantTx({ clientIds: [clientBId] }, (client) =>
        createClaimFromDispute(client, { clientId: clientBId, disputeId }),
      ),
    ).rejects.toBeInstanceOf(DisputeNotFoundError);
  });

  it('fails not-found for a nonexistent dispute id', async () => {
    await expect(
      withTenantTx({ clientIds: [clientAId] }, (client) =>
        createClaimFromDispute(client, { clientId: clientAId, disputeId: '00000000-0000-0000-0000-000000000000' }),
      ),
    ).rejects.toBeInstanceOf(DisputeNotFoundError);
  });
});
