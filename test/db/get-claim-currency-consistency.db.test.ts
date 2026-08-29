import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import {
  getClaimCurrencyConsistency,
  GetClaimCurrencyConsistencyError,
} from '../../src/modules/claims/get-claim-currency-consistency.js';

/**
 * 86e2zfj6c: currency-consistency reconciliation sweep for a claim
 * (P5.A.6), read against real Postgres.
 */
describe('getClaimCurrencyConsistency (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `ccc-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('CCC-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('CCC-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM recovery_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM claim WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedClaim(client: pg.PoolClient, opts: { clientId: string; currency?: string | null }): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '500.0000', $2, 'open') RETURNING id`,
      [opts.clientId, opts.currency ?? 'USD'],
    );
    return rows[0]!.id;
  }

  it('reports consistent when all recovery_event currencies match the claim', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      await client.query(`INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '100.0000', 'USD')`, [clientAId, claimId]);
      return getClaimCurrencyConsistency(client, clientAId, claimId);
    });

    expect(result.consistent).toBe(true);
    expect(result.currencies).toEqual(['USD']);
  });

  it('reports inconsistent when a recovery_event currency disagrees with the claim', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      await client.query(`INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '100.0000', 'CAD')`, [clientAId, claimId]);
      return getClaimCurrencyConsistency(client, clientAId, claimId);
    });

    expect(result.consistent).toBe(false);
    expect(result.mismatchedEventIds).toHaveLength(1);
  });

  it('surfaces a null-currency recovery_event as its own finding', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      await client.query(`INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '100.0000', NULL)`, [clientAId, claimId]);
      return getClaimCurrencyConsistency(client, clientAId, claimId);
    });

    expect(result.consistent).toBe(false);
    expect(result.nullCurrencyEventIds).toHaveLength(1);
  });

  it('fails not-found for a claim belonging to a different tenant', async () => {
    const claimId = await withTenantTx({ clientIds: [clientAId] }, (client) => seedClaim(client, { clientId: clientAId }));

    await expect(
      withTenantTx({ clientIds: [clientBId] }, (client) => getClaimCurrencyConsistency(client, clientBId, claimId)),
    ).rejects.toBeInstanceOf(GetClaimCurrencyConsistencyError);
  });

  it('fails not-found for a nonexistent claim id', async () => {
    await expect(
      withTenantTx({ clientIds: [clientAId] }, (client) =>
        getClaimCurrencyConsistency(client, clientAId, '00000000-0000-0000-0000-000000000000'),
      ),
    ).rejects.toBeInstanceOf(GetClaimCurrencyConsistencyError);
  });
});
