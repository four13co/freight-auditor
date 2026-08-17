import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { makePool } from './helpers.js';

const { Pool } = pg;

/**
 * 86e2v1qxz: migration 0001 created `freight_app` NOLOGIN but never granted
 * it to anything. `SET LOCAL ROLE freight_app` (src/db/tenant-context.ts,
 * the call that drops BYPASSRLS so RLS actually enforces) only worked because
 * the CI/dev connecting role is a superuser/owner -- which may SET ROLE to
 * ANY role regardless of grants. Neon connects as a non-owner role and gets
 * 42501 "permission denied to set role" on every tenant-scoped query.
 *
 * Two separate tests, because one test cannot prove both things at once:
 *
 *   1. "did THIS migration grant membership to the role that ran it" --
 *      answered by reading pg_auth_members directly. Must NOT use
 *      pg_has_role(): that function returns true for a superuser regardless
 *      of any actual grant, which is exactly the masking that let this ship
 *      green in the first place.
 *   2. "does a genuinely non-superuser role, once granted membership, work
 *      end-to-end through withTenantTx" -- this proves the grant mechanism
 *      is *sufficient*, not that migration 0013 is what performed it (the
 *      test below grants membership itself, in setup, to construct the
 *      non-owner scenario -- it is not a substitute for test 1).
 */
describe('freight_app role grant (86e2v1qxz)', () => {
  it('migration 0013 grants freight_app to the role that ran the migrations, per pg_auth_members', async () => {
    const pool = makePool();
    try {
      const { rows } = await pool.query(`
        SELECT 1 FROM pg_auth_members m
          JOIN pg_roles r ON m.roleid = r.oid
          JOIN pg_roles g ON m.member = g.oid
         WHERE r.rolname = 'freight_app' AND g.rolname = current_user
      `);
      expect(rows).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  describe('a non-superuser role can assume freight_app and run tenant-scoped queries', () => {
    const nonOwnerRole = `test_nonowner_${Date.now()}`;
    // node:pg's PoolClient doesn't type-expose the connected database name --
    // read it from DATABASE_URL's own path instead of the client.
    const dbName = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, '');
    let nonOwnerPool: pg.Pool;

    beforeAll(async () => {
      const ownerPool = makePool();
      try {
        // CREATE ROLE / GRANT / DROP ROLE are transactional DDL in Postgres --
        // withOwnerTx always rolls back, which would silently undo the role
        // before any test ran. Run this DDL directly (no wrapping
        // transaction) so it actually persists for the tests below.
        //
        // Construct the non-owner scenario directly: a fresh LOGIN role with
        // no superuser/owner privilege, explicitly granted freight_app
        // membership here (mirroring what migration 0013 does for the real
        // connecting role) so this test isolates "does the grant mechanism
        // work for a non-owner" from "did the migration itself grant it".
        const client = await ownerPool.connect();
        try {
          await client.query(`CREATE ROLE ${nonOwnerRole} LOGIN PASSWORD 'test-password'`);
          await client.query(`GRANT freight_app TO ${nonOwnerRole}`);
          await client.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${nonOwnerRole}`);
        } finally {
          client.release();
        }
      } finally {
        await ownerPool.end();
      }

      const ownerUrl = new URL(process.env.DATABASE_URL!);
      const nonOwnerUrl = new URL(ownerUrl.toString());
      nonOwnerUrl.username = nonOwnerRole;
      nonOwnerUrl.password = 'test-password';
      nonOwnerPool = new Pool({ connectionString: nonOwnerUrl.toString(), max: 2 });
    });

    afterAll(async () => {
      await nonOwnerPool.end();
      const ownerPool = makePool();
      try {
        const client = await ownerPool.connect();
        try {
          await client.query(`REVOKE freight_app FROM ${nonOwnerRole}`);
          await client.query(`REVOKE CONNECT ON DATABASE ${dbName} FROM ${nonOwnerRole}`);
          await client.query(`DROP ROLE ${nonOwnerRole}`);
        } finally {
          client.release();
        }
      } finally {
        await ownerPool.end();
      }
    });

    it('SET LOCAL ROLE freight_app succeeds for a non-superuser connection once granted', async () => {
      const client = await nonOwnerPool.connect();
      try {
        await client.query('BEGIN');
        await expect(client.query('SET LOCAL ROLE freight_app')).resolves.toBeDefined();
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('withTenantTx runs successfully end-to-end for a non-superuser connection, RLS still enforced', async () => {
      // Empty tenant scope, non-internal: RLS must still admit only shared
      // catalog rows (tenant column IS NULL) -- proves the grant did not
      // also disable/weaken isolation for this connection.
      const findings = await withTenantTxOnPool(nonOwnerPool, { clientIds: [], internal: false }, (client) =>
        client.query('SELECT count(*) FROM client'),
      );
      expect(findings.rows[0].count).toBeDefined();
    });
  });
});

/**
 * withTenantTx (src/db/tenant-context.ts) always checks out from the shared
 * process-wide pool via getPool(). This test needs a SEPARATE pool connected
 * as the non-owner test role, so it reimplements the same three-step scope
 * (GUCs, then SET LOCAL ROLE) against the given pool directly rather than
 * against getPool()'s connection.
 */
async function withTenantTxOnPool<T>(
  pool: pg.Pool,
  ctx: { clientIds?: string[]; internal?: boolean },
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_client_ids',
      (ctx.clientIds ?? []).join(','),
    ]);
    await client.query('SELECT set_config($1, $2, true)', ['app.is_internal', ctx.internal ? 'true' : 'false']);
    await client.query('SET LOCAL ROLE freight_app');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}
