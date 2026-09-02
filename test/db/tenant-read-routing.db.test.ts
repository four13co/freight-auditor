import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool, closeReplicaPool } from '../../src/db/pool.js';
import { withTenantReadTx } from '../../src/db/tenant-context.js';
import { requireDatabaseUrl } from './helpers.js';

/**
 * 86e2zfjym AC3, against real Postgres: withTenantReadTx must run the exact
 * setTenantTxScope GUC + SET LOCAL ROLE sequence on whichever connection it
 * checks out, so RLS still binds when the connection comes from the replica
 * pool -- not just the primary. There's no second physical Postgres instance
 * in this ephemeral test environment, so DATABASE_READ_REPLICA_URL is pointed
 * at the same DSN as DATABASE_URL: that's sufficient to prove the routing
 * decision and GUC/role sequence bind correctly on the connection it selects
 * (this item's own Rabbit holes explicitly exclude proving real replica
 * activation/replication-lag -- see pool.ts/tenant-context.ts's own docs).
 *
 * Uses `membership` (client_id-scoped, FORCE RLS per migration 0009) as the
 * simplest tenant table with real cross-tenant rows to assert against --
 * same table tenant-auth.db.test.ts already seeds for its own DB-level RLS
 * coverage.
 */
describe('withTenantReadTx routing + RLS on the selected pool (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let otherClientId: string;
  let userId: string;
  let otherUserId: string;
  const tag = `trr-${Date.now()}`;

  beforeAll(async () => {
    process.env.DATABASE_READ_REPLICA_URL = requireDatabaseUrl();
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c1 = await owner.query(`INSERT INTO client (name, slug) VALUES ('TRR', $1) RETURNING id`, [tag]);
      clientId = c1.rows[0].id;
      const c2 = await owner.query(`INSERT INTO client (name, slug) VALUES ('TRR Other', $1) RETURNING id`, [`${tag}-other`]);
      otherClientId = c2.rows[0].id;

      const u1 = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u1.rows[0].id;
      const u2 = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-other@example.com`]);
      otherUserId = u2.rows[0].id;

      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [userId, clientId]);
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [otherUserId, otherClientId]);
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    delete process.env.DATABASE_READ_REPLICA_URL;
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM membership WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM app_user WHERE id = ANY($1)`, [[userId, otherUserId]]);
      await owner.query(`DELETE FROM client WHERE id = ANY($1)`, [[clientId, otherClientId]]);
    } finally {
      owner.release();
    }
    await closeReplicaPool();
    await closePool();
  });

  it('applies the tenant-scope GUCs and SET LOCAL ROLE on the replica-selected connection, so cross-tenant rows stay invisible', async () => {
    const rows = await withTenantReadTx({ clientIds: [clientId], internal: false }, (client) =>
      client.query('SELECT client_id FROM membership WHERE client_id = ANY($1)', [[clientId, otherClientId]]).then((r) => r.rows),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].client_id).toBe(clientId);
  });

  it('an internal analyst context sees rows across both clients through the same routed connection', async () => {
    const rows = await withTenantReadTx({ internal: true }, (client) =>
      client.query('SELECT client_id FROM membership WHERE client_id = ANY($1)', [[clientId, otherClientId]]).then((r) => r.rows),
    );

    const seen = new Set(rows.map((r: { client_id: string }) => r.client_id));
    expect(seen).toEqual(new Set([clientId, otherClientId]));
  });
});
