import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { makePool, withOwnerTx, withAppTx } from './helpers.js';

/**
 * 86e3a76bz (migration 0084): RLS isolation for the new `client`/`vendor`
 * tenant-hierarchy tables (Account -> Client -> Vendor), mirroring
 * contract-rate-rls.db.test.ts's own shape. Covers the Account-scoped
 * (existing app_current_account_ids() GUC, unchanged) and internal cases the
 * same way every other tenant table does, PLUS the two NEW scope GUCs
 * (app_current_client_ids()/app_current_vendor_ids()) apply_hierarchical_tenant_rls
 * introduces -- those branches are dormant in production (no auth resolver
 * populates them from a real session yet, per 0084's own header comment),
 * but the policy itself must behave correctly once something does.
 */
describe('client/vendor hierarchy RLS (DB)', () => {
  let pool: pg.Pool;
  let accountA: string;
  let accountB: string;
  let clientA1: string;
  let clientA2: string;
  let vendorA1a: string;
  let vendorA1b: string;
  const tag = `cvh-${Date.now()}`;

  beforeAll(async () => {
    pool = makePool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO account (name, slug) VALUES ('CVH-A', $1) RETURNING id`, [`${tag}-a`]);
      const b = await owner.query(`INSERT INTO account (name, slug) VALUES ('CVH-B', $1) RETURNING id`, [`${tag}-b`]);
      accountA = a.rows[0].id;
      accountB = b.rows[0].id;

      const c1 = await owner.query(`INSERT INTO client (account_id, name) VALUES ($1, 'Client A1') RETURNING id`, [accountA]);
      const c2 = await owner.query(`INSERT INTO client (account_id, name) VALUES ($1, 'Client A2') RETURNING id`, [accountA]);
      clientA1 = c1.rows[0].id;
      clientA2 = c2.rows[0].id;

      const v1a = await owner.query(`INSERT INTO vendor (account_id, client_id, name) VALUES ($1, $2, 'Vendor A1a') RETURNING id`, [accountA, clientA1]);
      const v1b = await owner.query(`INSERT INTO vendor (account_id, client_id, name) VALUES ($1, $2, 'Vendor A1b') RETURNING id`, [accountA, clientA1]);
      vendorA1a = v1a.rows[0].id;
      vendorA1b = v1b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM vendor WHERE account_id = ANY($1)`, [[accountA, accountB]]);
      await owner.query(`DELETE FROM client WHERE account_id = ANY($1)`, [[accountA, accountB]]);
      await owner.query(`DELETE FROM account WHERE id = ANY($1)`, [[accountA, accountB]]);
    } finally {
      owner.release();
    }
    await pool.end();
  });

  it('rowsecurity is enabled with a tenant_isolation policy on both new tables', async () => {
    await withOwnerTx(pool, async (c) => {
      for (const table of ['client', 'vendor']) {
        const rel = await c.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [table]);
        expect(rel.rows[0].relrowsecurity).toBe(true);
        expect(rel.rows[0].relforcerowsecurity).toBe(true);
        const pol = await c.query(`SELECT polname FROM pg_policy WHERE polrelid = $1::regclass`, [table]);
        expect(pol.rows.map((r) => r.polname)).toContain('tenant_isolation');
      }
    });
  });

  it('an Account-scoped session sees its own clients/vendors, not another account\'s', async () => {
    const ownClients = await withAppTx(pool, { clientIds: [accountA], internal: false }, async (c) => {
      const r = await c.query(`SELECT id FROM client WHERE account_id = $1`, [accountA]);
      return r.rows.map((row) => row.id);
    });
    expect(ownClients.sort()).toEqual([clientA1, clientA2].sort());

    const otherAccountClient = await withOwnerTx(pool, (c) =>
      c.query(`INSERT INTO client (account_id, name) VALUES ($1, 'Client B1') RETURNING id`, [accountB]),
    );
    const clientBId = otherAccountClient.rows[0].id;

    const invisible = await withAppTx(pool, { clientIds: [accountA], internal: false }, async (c) => {
      const r = await c.query(`SELECT id FROM client WHERE id = $1`, [clientBId]);
      return r.rows;
    });
    expect(invisible).toHaveLength(0);

    await withOwnerTx(pool, (c) => c.query(`DELETE FROM client WHERE id = $1`, [clientBId]));
  });

  it('an internal session sees clients/vendors across accounts', async () => {
    const seen = await withAppTx(pool, { internal: true }, async (c) => {
      const r = await c.query(`SELECT id FROM client WHERE id = ANY($1)`, [[clientA1, clientA2]]);
      return new Set(r.rows.map((row) => row.id));
    });
    expect(seen.has(clientA1)).toBe(true);
    expect(seen.has(clientA2)).toBe(true);
  });

  it('a Client-scoped session (app_current_client_ids) sees only its own client, and only vendors under it', async () => {
    const ownClient = await withAppTx(pool, { scopedClientIds: [clientA1], internal: false }, async (c) => {
      const r = await c.query(`SELECT id FROM client WHERE id = ANY($1)`, [[clientA1, clientA2]]);
      return r.rows.map((row) => row.id);
    });
    expect(ownClient).toEqual([clientA1]);

    const ownVendors = await withAppTx(pool, { scopedClientIds: [clientA1], internal: false }, async (c) => {
      const r = await c.query(`SELECT id FROM vendor WHERE client_id = $1`, [clientA1]);
      return r.rows.map((row) => row.id);
    });
    expect(ownVendors.sort()).toEqual([vendorA1a, vendorA1b].sort());
  });

  it('a Vendor-scoped session (app_current_vendor_ids) sees only its own vendor row', async () => {
    const rows = await withAppTx(pool, { scopedVendorIds: [vendorA1a], internal: false }, async (c) => {
      const r = await c.query(`SELECT id FROM vendor WHERE id = ANY($1)`, [[vendorA1a, vendorA1b]]);
      return r.rows.map((row) => row.id);
    });
    expect(rows).toEqual([vendorA1a]);
  });

  it('a session with no matching scope at all sees nothing', async () => {
    const rows = await withAppTx(pool, { internal: false }, async (c) => {
      const r = await c.query(`SELECT id FROM client WHERE id = $1`, [clientA1]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('an Account-scoped session cannot insert a client claiming a different account', async () => {
    await expect(
      withAppTx(pool, { clientIds: [accountA], internal: false }, async (c) => {
        await c.query(`INSERT INTO client (account_id, name) VALUES ($1, 'Sneaky')`, [accountB]);
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });
});

/**
 * 86e3a76bz (migration 0084): the (user_id, COALESCE(vendor_id, client_id,
 * account_id)) uniqueness that replaced membership's old plain UNIQUE
 * (user_id, account_id) -- required so one user can hold an Account-level
 * membership AND a separate Client-level (or Vendor-level) membership
 * within the same account (decision 2), while still rejecting a genuine
 * duplicate at any single level.
 */
describe('membership scope uniqueness (DB)', () => {
  let pool: pg.Pool;
  let accountId: string;
  let clientId: string;
  let vendorId: string;
  let userId: string;
  const tag = `msu-${Date.now()}`;

  beforeAll(async () => {
    pool = makePool();
    const owner = await pool.connect();
    try {
      const acct = await owner.query(`INSERT INTO account (name, slug) VALUES ('MSU', $1) RETURNING id`, [tag]);
      accountId = acct.rows[0].id;
      const client = await owner.query(`INSERT INTO client (account_id, name) VALUES ($1, 'MSU Client') RETURNING id`, [accountId]);
      clientId = client.rows[0].id;
      const vendor = await owner.query(`INSERT INTO vendor (account_id, client_id, name) VALUES ($1, $2, 'MSU Vendor') RETURNING id`, [accountId, clientId]);
      vendorId = vendor.rows[0].id;
      const user = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.test`]);
      userId = user.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM membership WHERE account_id = $1`, [accountId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM vendor WHERE account_id = $1`, [accountId]);
      await owner.query(`DELETE FROM client WHERE account_id = $1`, [accountId]);
      await owner.query(`DELETE FROM account WHERE id = $1`, [accountId]);
    } finally {
      owner.release();
    }
    await pool.end();
  });

  it('allows the same user to hold an Account-level AND a Client-level membership in the same account', async () => {
    await withOwnerTx(pool, async (c) => {
      await c.query(`INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'analyst')`, [userId, accountId]);
      await c.query(`INSERT INTO membership (user_id, account_id, client_id, role) VALUES ($1, $2, $3, 'client_scope_viewer')`, [userId, accountId, clientId]);
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM membership WHERE user_id = $1`, [userId]);
      expect(rows[0].n).toBe(2);
      await c.query(`DELETE FROM membership WHERE user_id = $1`, [userId]);
    });
  });

  it('rejects a duplicate Account-level membership for the same user', async () => {
    // withOwnerTx always ROLLBACKs at the end (see helpers.ts) -- no manual
    // cleanup query here, deliberately: once the expected INSERT below
    // fails, the transaction is aborted and any further statement in it
    // (including a DELETE) would itself throw "current transaction is
    // aborted, commands ignored until end of transaction block".
    await withOwnerTx(pool, async (c) => {
      await c.query(`INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'analyst')`, [userId, accountId]);
      await expect(
        c.query(`INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'lead')`, [userId, accountId]),
      ).rejects.toThrow(/duplicate key|unique constraint/i);
    });
  });

  it('rejects a duplicate Client-level membership for the same user+client', async () => {
    await withOwnerTx(pool, async (c) => {
      await c.query(`INSERT INTO membership (user_id, account_id, client_id, role) VALUES ($1, $2, $3, 'client_scope_viewer')`, [userId, accountId, clientId]);
      await expect(
        c.query(`INSERT INTO membership (user_id, account_id, client_id, role) VALUES ($1, $2, $3, 'client_scope_admin')`, [userId, accountId, clientId]),
      ).rejects.toThrow(/duplicate key|unique constraint/i);
    });
  });

  it('rejects a duplicate Vendor-level membership for the same user+vendor', async () => {
    await withOwnerTx(pool, async (c) => {
      await c.query(
        `INSERT INTO membership (user_id, account_id, client_id, vendor_id, role) VALUES ($1, $2, $3, $4, 'vendor_scope_viewer')`,
        [userId, accountId, clientId, vendorId],
      );
      await expect(
        c.query(
          `INSERT INTO membership (user_id, account_id, client_id, vendor_id, role) VALUES ($1, $2, $3, $4, 'vendor_scope_admin')`,
          [userId, accountId, clientId, vendorId],
        ),
      ).rejects.toThrow(/duplicate key|unique constraint/i);
    });
  });
});
