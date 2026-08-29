import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { setClaimAgingDeadline, SetClaimAgingDeadlineError } from '../../src/modules/claims/set-claim-aging-deadline.js';

/**
 * 86e2zfj8f: setting a claim's aging deadline (P5.B.1), read/write against
 * real Postgres.
 */
describe('setClaimAgingDeadline (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `cad-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('CAD-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('CAD-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM claim WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedClaim(client: pg.PoolClient, opts: { clientId: string; openedAt?: string }): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status, opened_at) VALUES ($1, '500.0000', 'USD', 'open', $2) RETURNING id`,
      [opts.clientId, opts.openedAt ?? '2026-01-01T00:00:00Z'],
    );
    return rows[0]!.id;
  }

  it('sets aging_deadline_at to opened_at plus the default 30 days', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      const setResult = await setClaimAgingDeadline(client, { clientId: clientAId, claimId });
      const stored = await client.query(`SELECT aging_deadline_at FROM claim WHERE id = $1`, [claimId]);
      return { setResult, stored: stored.rows[0].aging_deadline_at };
    });

    expect(new Date(result.setResult.agingDeadlineAt).toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(new Date(result.stored).toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('sets aging_deadline_at using a custom agingDays value', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      return setClaimAgingDeadline(client, { clientId: clientAId, claimId, agingDays: 7 });
    });

    expect(new Date(result.agingDeadlineAt).toISOString()).toBe('2026-01-08T00:00:00.000Z');
  });

  it('is idempotent on retry: recomputing yields the same deadline', async () => {
    const results = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      const first = await setClaimAgingDeadline(client, { clientId: clientAId, claimId });
      const second = await setClaimAgingDeadline(client, { clientId: clientAId, claimId });
      return { first, second };
    });

    expect(results.first.agingDeadlineAt).toBe(results.second.agingDeadlineAt);
  });

  it('fails not-found for a claim belonging to a different tenant', async () => {
    const claimId = await withTenantTx({ clientIds: [clientAId] }, (client) => seedClaim(client, { clientId: clientAId }));

    await expect(
      withTenantTx({ clientIds: [clientBId] }, (client) =>
        setClaimAgingDeadline(client, { clientId: clientBId, claimId }),
      ),
    ).rejects.toBeInstanceOf(SetClaimAgingDeadlineError);
  });

  it('fails not-found for a nonexistent claim id', async () => {
    await expect(
      withTenantTx({ clientIds: [clientAId] }, (client) =>
        setClaimAgingDeadline(client, { clientId: clientAId, claimId: '00000000-0000-0000-0000-000000000000' }),
      ),
    ).rejects.toBeInstanceOf(SetClaimAgingDeadlineError);
  });
});
