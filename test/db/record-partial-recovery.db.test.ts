import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import {
  recordPartialRecovery,
  RecordPartialRecoveryError,
} from '../../src/modules/claims/record-partial-recovery.js';
import { PartialRecoveryError } from '../../src/modules/claims/validate-partial-recovery.js';

/**
 * 86e2zfj55: recording partial recovery events against a claim (P5.A.3).
 */
describe('recordPartialRecovery (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `pr-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('PR-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('PR-B', $1) RETURNING id`, [`${tag}-b`]);
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

  it('records a first partial recovery below the claimed amount', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      return recordPartialRecovery(client, { clientId: clientAId, claimId, amountRecovered: '200.0000', currency: 'USD' });
    });

    expect(result.cumulativeRecovered).toBe('200.0000');
    expect(result.isFinal).toBe(false);
  });

  it('accumulates across multiple partial recovery events toward the claimed amount', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      await recordPartialRecovery(client, { clientId: clientAId, claimId, amountRecovered: '200.0000', currency: 'USD' });
      const second = await recordPartialRecovery(client, { clientId: clientAId, claimId, amountRecovered: '300.0000', currency: 'USD' });

      const rows = await client.query(`SELECT amount_recovered FROM recovery_event WHERE claim_id = $1 ORDER BY recorded_at`, [claimId]);
      return { second, count: rows.rows.length };
    });

    expect(result.second.cumulativeRecovered).toBe('500.0000');
    expect(result.second.isFinal).toBe(true);
    expect(result.count).toBe(2);
  });

  it('rejects a recovery that would push the cumulative total past the claimed amount', async () => {
    await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      await recordPartialRecovery(client, { clientId: clientAId, claimId, amountRecovered: '400.0000', currency: 'USD' });
      await expect(
        recordPartialRecovery(client, { clientId: clientAId, claimId, amountRecovered: '200.0000', currency: 'USD' }),
      ).rejects.toBeInstanceOf(PartialRecoveryError);

      const rows = await client.query(`SELECT id FROM recovery_event WHERE claim_id = $1`, [claimId]);
      expect(rows.rows).toHaveLength(1);
    });
  });

  it('fails not-found for a claim belonging to a different tenant', async () => {
    const claimId = await withTenantTx({ clientIds: [clientAId] }, (client) => seedClaim(client, { clientId: clientAId }));

    await expect(
      withTenantTx({ clientIds: [clientBId] }, (client) =>
        recordPartialRecovery(client, { clientId: clientBId, claimId, amountRecovered: '100.0000', currency: 'USD' }),
      ),
    ).rejects.toBeInstanceOf(RecordPartialRecoveryError);
  });

  it('fails not-found for a nonexistent claim id', async () => {
    await expect(
      withTenantTx({ clientIds: [clientAId] }, (client) =>
        recordPartialRecovery(client, {
          clientId: clientAId,
          claimId: '00000000-0000-0000-0000-000000000000',
          amountRecovered: '100.0000',
          currency: 'USD',
        }),
      ),
    ).rejects.toBeInstanceOf(RecordPartialRecoveryError);
  });
});
