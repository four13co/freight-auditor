import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { resolveClaim, ResolveClaimError } from '../../src/modules/claims/resolve-claim.js';
import { ClaimResolutionError } from '../../src/modules/claims/validate-claim-resolution.js';

/**
 * 86e2zfj5k: resolving a claim to a terminal outcome (P5.A.4).
 */
describe('resolveClaim (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `rc-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('RC-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('RC-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM recovery_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM claim WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedClaim(client: pg.PoolClient, opts: { clientId: string; amountClaimed?: string }): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, $2, 'USD', 'open') RETURNING id`,
      [opts.clientId, opts.amountClaimed ?? '500.0000'],
    );
    return rows[0]!.id;
  }

  it('resolves a claim to recovered with a matching full-amount recovery event', async () => {
    const row = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      const result = await resolveClaim(client, { clientId: clientAId, claimId, kind: 'FULL_RECOVERY', amountRecovered: '500.0000', currency: 'USD' });
      const status = await client.query(`SELECT status FROM claim WHERE id = $1`, [claimId]);
      return { result, status: status.rows[0].status };
    });

    expect(row.result.newStatus).toBe('recovered');
    expect(row.result.recoveryEventId).not.toBeNull();
    expect(row.status).toBe('recovered');
  });

  it('resolves a claim to denied with no recovery event written', async () => {
    const row = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      const result = await resolveClaim(client, { clientId: clientAId, claimId, kind: 'DENIAL' });
      const events = await client.query(`SELECT id FROM recovery_event WHERE claim_id = $1`, [claimId]);
      const status = await client.query(`SELECT status FROM claim WHERE id = $1`, [claimId]);
      return { result, eventCount: events.rows.length, status: status.rows[0].status };
    });

    expect(row.result.newStatus).toBe('denied');
    expect(row.result.recoveryEventId).toBeNull();
    expect(row.eventCount).toBe(0);
    expect(row.status).toBe('denied');
  });

  it('resolves a claim to written_off with a partial recovery already recorded', async () => {
    const row = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      await client.query(
        `INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '100.0000', 'USD')`,
        [clientAId, claimId],
      );
      const result = await resolveClaim(client, { clientId: clientAId, claimId, kind: 'WRITE_OFF' });
      const status = await client.query(`SELECT status FROM claim WHERE id = $1`, [claimId]);
      return { result, status: status.rows[0].status };
    });

    expect(row.result.newStatus).toBe('written_off');
    expect(row.result.recoveryEventId).toBeNull();
    expect(row.status).toBe('written_off');
  });

  it('rejects resolving a claim that is already terminal', async () => {
    await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      await resolveClaim(client, { clientId: clientAId, claimId, kind: 'DENIAL' });
      await expect(resolveClaim(client, { clientId: clientAId, claimId, kind: 'WRITE_OFF' }))
        .rejects.toBeInstanceOf(ClaimResolutionError);
    });
  });

  it('fails not-found for a claim belonging to a different tenant', async () => {
    const claimId = await withTenantTx({ clientIds: [clientAId] }, (client) => seedClaim(client, { clientId: clientAId }));

    await expect(
      withTenantTx({ clientIds: [clientBId] }, (client) =>
        resolveClaim(client, { clientId: clientBId, claimId, kind: 'DENIAL' }),
      ),
    ).rejects.toBeInstanceOf(ResolveClaimError);
  });

  it('fails not-found for a nonexistent claim id', async () => {
    await expect(
      withTenantTx({ clientIds: [clientAId] }, (client) =>
        resolveClaim(client, { clientId: clientAId, claimId: '00000000-0000-0000-0000-000000000000', kind: 'DENIAL' }),
      ),
    ).rejects.toBeInstanceOf(ResolveClaimError);
  });
});
