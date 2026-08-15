import { describe, it, expect, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool.js';
import { seedDevTenant, DEV_CLIENT_ID, DEV_USER_ID } from '../../scripts/seed-dev-tenant.mjs';

/**
 * 86e2urebj: the dashboard's dev-mode auth headers (web/src/lib/api.ts)
 * claim DEV_CLIENT_ID/DEV_USER_ID -- this script is what makes that claimed
 * pair pass tenant-auth.ts's real membership check, not just its shape
 * check. Without it, both headers present still 401s (verified locally
 * during development: reproduced the 401, ran this script, reproduced 200).
 */
describe('seedDevTenant (DB)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('creates a client + app_user + membership row for the fixed dev IDs', async () => {
    const pool = getPool();
    await seedDevTenant({ pool });

    const membership = await pool.query(
      `SELECT 1 FROM membership WHERE user_id = $1 AND client_id = $2`,
      [DEV_USER_ID, DEV_CLIENT_ID],
    );
    expect(membership.rowCount).toBe(1);

    const client = await pool.query(`SELECT 1 FROM client WHERE id = $1`, [DEV_CLIENT_ID]);
    expect(client.rowCount).toBe(1);

    const user = await pool.query(`SELECT 1 FROM app_user WHERE id = $1`, [DEV_USER_ID]);
    expect(user.rowCount).toBe(1);
  });

  it('is idempotent: running it twice does not error or duplicate rows', async () => {
    const pool = getPool();
    await seedDevTenant({ pool });
    await seedDevTenant({ pool }); // second run must not throw

    const membership = await pool.query(
      `SELECT count(*) FROM membership WHERE user_id = $1 AND client_id = $2`,
      [DEV_USER_ID, DEV_CLIENT_ID],
    );
    expect(Number(membership.rows[0].count)).toBe(1);
  });
});
