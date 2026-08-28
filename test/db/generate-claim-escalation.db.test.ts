import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { generateClaimEscalation, GenerateClaimEscalationError } from '../../src/modules/claims/generate-claim-escalation.js';

const CLAIM_FOLLOW_UP_EVENT = 'claim.follow_up_sent';

/**
 * 86e2zfja3: idempotent claim escalation generation (P5.B.3), against real
 * Postgres. Seeds the follow-up audit_event directly rather than calling
 * generateClaimFollowUp (P5.B.2/#179, unmerged).
 */
describe('generateClaimEscalation (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `ce-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('CE', $1) RETURNING id`, [tag]);
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

  async function seedClaim(client: pg.PoolClient): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '500.0000', 'USD', 'open') RETURNING id`,
      [clientId],
    );
    return rows[0]!.id;
  }

  async function seedFollowUp(client: pg.PoolClient, claimId: string, recordedAt: string): Promise<void> {
    await client.query(
      `INSERT INTO audit_event (id, client_id, entity, entity_id, event, actor_kind, recorded_at)
       VALUES (gen_random_uuid(), $1, 'claim', $2, $3, 'system', $4)`,
      [clientId, claimId, CLAIM_FOLLOW_UP_EVENT, recordedAt],
    );
  }

  it('escalates a claim whose follow-up grace period has elapsed, idempotently', async () => {
    const row = await withTenantTx({ clientIds: [clientId] }, async (client) => {
      const claimId = await seedClaim(client);
      const oldFollowUp = new Date(Date.now() - 30 * 86_400_000).toISOString();
      await seedFollowUp(client, claimId, oldFollowUp);
      const first = await generateClaimEscalation(client, { clientId, claimId });
      const retry = await generateClaimEscalation(client, { clientId, claimId });
      const events = await client.query(
        `SELECT id FROM audit_event WHERE client_id = $1 AND entity = 'claim' AND entity_id = $2 AND event = 'claim.escalated'`,
        [clientId, claimId],
      );
      return { first, retry, eventCount: events.rows.length };
    });

    expect(row.first.created).toBe(true);
    expect(row.retry.created).toBe(false);
    expect(row.eventCount).toBe(1);
  });

  it('refuses a claim with no follow-up event yet', async () => {
    await withTenantTx({ clientIds: [clientId] }, async (client) => {
      const claimId = await seedClaim(client);
      await expect(generateClaimEscalation(client, { clientId, claimId }))
        .rejects.toBeInstanceOf(GenerateClaimEscalationError);
    });
  });

  it('refuses escalation before the grace period has elapsed', async () => {
    await withTenantTx({ clientIds: [clientId] }, async (client) => {
      const claimId = await seedClaim(client);
      await seedFollowUp(client, claimId, new Date().toISOString());
      await expect(generateClaimEscalation(client, { clientId, claimId }))
        .rejects.toBeInstanceOf(GenerateClaimEscalationError);
    });
  });

  it('fails not-found for a nonexistent claim id', async () => {
    await expect(
      withTenantTx({ clientIds: [clientId] }, (client) =>
        generateClaimEscalation(client, { clientId, claimId: '00000000-0000-0000-0000-000000000000' }),
      ),
    ).rejects.toBeInstanceOf(GenerateClaimEscalationError);
  });
});
