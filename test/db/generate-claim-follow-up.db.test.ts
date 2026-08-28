import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { generateClaimFollowUp } from '../../src/modules/claims/generate-claim-follow-up.js';

/**
 * 86e2zfj99: idempotent claim follow-up generation (P5.B.2), against real
 * Postgres.
 */
describe('generateClaimFollowUp (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `cfu-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('CFU', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM claim WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedClaim(client: pg.PoolClient, opts: { deadlinePast?: boolean; status?: string }): Promise<string> {
    const deadline = opts.deadlinePast === false ? null : new Date(Date.now() - 86_400_000).toISOString();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status, aging_deadline_at) VALUES ($1, '500.0000', 'USD', $2, $3) RETURNING id`,
      [clientId, opts.status ?? 'open', deadline],
    );
    return rows[0]!.id;
  }

  it('creates a follow-up marker for a claim past its deadline, idempotently', async () => {
    const row = await withTenantTx({ clientIds: [clientId] }, async (client) => {
      const claimId = await seedClaim(client, {});
      const first = await generateClaimFollowUp(client, { clientId, claimId });
      const retry = await generateClaimFollowUp(client, { clientId, claimId });
      const events = await client.query(`SELECT id FROM audit_event WHERE client_id = $1 AND entity = 'claim' AND entity_id = $2 AND event = 'claim.follow_up_sent'`, [clientId, claimId]);
      return { first, retry, eventCount: events.rows.length };
    });

    expect(row.first.created).toBe(true);
    expect(row.retry.created).toBe(false);
    expect(row.eventCount).toBe(1);
  });
});
