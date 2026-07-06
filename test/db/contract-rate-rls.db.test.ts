import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { makePool, withOwnerTx, withAppTx } from './helpers.js';

/**
 * contract_rate tenant isolation (ClickUp 86e25ujwg). contract_rate (0011)
 * postdated 0009's RLS pairs list and was never added to it, so the
 * freight_app grants in 0011 allowed cross-tenant read/write. 0012 closes
 * the gap via apply_tenant_rls, matching contract_clause's wiring.
 */
describe('contract_rate RLS', () => {
  let pool: pg.Pool;
  let clientA: string;
  let clientB: string;
  let versionA: string;
  let rateAId: string;
  let rateBId: string;
  const tag = `rls-${Date.now()}`;

  beforeAll(async () => {
    pool = makePool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('RLS-A', $1) RETURNING id`, [`${tag}-a`]);
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('RLS-B', $1) RETURNING id`, [`${tag}-b`]);
      clientA = a.rows[0].id;
      clientB = b.rows[0].id;
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ('RLS Carrier') RETURNING id`);
      const carrierId = carrier.rows[0].id;
      const contractA = await owner.query(
        `INSERT INTO contract (client_id, carrier_id, name) VALUES ($1,$2,'A') RETURNING id`,
        [clientA, carrierId],
      );
      const contractB = await owner.query(
        `INSERT INTO contract (client_id, carrier_id, name) VALUES ($1,$2,'B') RETURNING id`,
        [clientB, carrierId],
      );
      const verA = await owner.query(
        `INSERT INTO contract_version (client_id, contract_id, version_label, valid_from) VALUES ($1,$2,'v1',CURRENT_DATE) RETURNING id`,
        [clientA, contractA.rows[0].id],
      );
      const verB = await owner.query(
        `INSERT INTO contract_version (client_id, contract_id, version_label, valid_from) VALUES ($1,$2,'v1',CURRENT_DATE) RETURNING id`,
        [clientB, contractB.rows[0].id],
      );
      versionA = verA.rows[0].id;
      const rateA = await owner.query(
        `INSERT INTO contract_rate (client_id, contract_version_id, category, rate, currency) VALUES ($1,$2,'LINEHAUL',900.00,'USD') RETURNING id`,
        [clientA, verA.rows[0].id],
      );
      const rateB = await owner.query(
        `INSERT INTO contract_rate (client_id, contract_version_id, category, rate, currency) VALUES ($1,$2,'LINEHAUL',750.00,'USD') RETURNING id`,
        [clientB, verB.rows[0].id],
      );
      rateAId = rateA.rows[0].id;
      rateBId = rateB.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM contract_rate WHERE client_id = ANY($1)`, [[clientA, clientB]]);
      await owner.query(`DELETE FROM contract_version WHERE client_id = ANY($1)`, [[clientA, clientB]]);
      await owner.query(`DELETE FROM contract WHERE client_id = ANY($1)`, [[clientA, clientB]]);
      await owner.query(`DELETE FROM client WHERE id = ANY($1)`, [[clientA, clientB]]);
    } finally {
      owner.release();
    }
    await pool.end();
  });

  it('rowsecurity is enabled with a tenant_isolation policy', async () => {
    await withOwnerTx(pool, async (c) => {
      const { rows } = await c.query(
        `SELECT relrowsecurity FROM pg_class WHERE relname = 'contract_rate'`,
      );
      expect(rows[0].relrowsecurity).toBe(true);
      const pol = await c.query(
        `SELECT polname FROM pg_policy WHERE polrelid = 'contract_rate'::regclass`,
      );
      expect(pol.rows.map((r) => r.polname)).toContain('tenant_isolation');
    });
  });

  it('a session scoped to client A cannot see client B rows', async () => {
    const rows = await withAppTx(pool, { clientIds: [clientA], internal: false }, async (c) => {
      const r = await c.query(`SELECT id, client_id FROM contract_rate WHERE contract_version_id = ANY($1)`, [
        [versionA],
      ]);
      return r.rows;
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.client_id === clientA)).toBe(true);

    const bRows = await withAppTx(pool, { clientIds: [clientA], internal: false }, async (c) => {
      const r = await c.query(`SELECT id FROM contract_rate WHERE id = $1`, [rateBId]);
      return r.rows;
    });
    expect(bRows).toHaveLength(0);
  });

  it('an internal session sees rows across both clients', async () => {
    const seen = await withAppTx(pool, { internal: true }, async (c) => {
      const r = await c.query(`SELECT DISTINCT client_id FROM contract_rate WHERE id = ANY($1)`, [
        [rateAId, rateBId],
      ]);
      return new Set(r.rows.map((row) => row.client_id));
    });
    expect(seen.has(clientA)).toBe(true);
    expect(seen.has(clientB)).toBe(true);
  });

  it('a session scoped to client A cannot insert or update a row claiming client B', async () => {
    await expect(
      withAppTx(pool, { clientIds: [clientA], internal: false }, async (c) => {
        await c.query(
          `INSERT INTO contract_rate (client_id, contract_version_id, category, rate, currency) VALUES ($1,$2,'FUEL',1.00,'USD')`,
          [clientB, versionA],
        );
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);

    await expect(
      withAppTx(pool, { clientIds: [clientA], internal: false }, async (c) => {
        await c.query(`UPDATE contract_rate SET client_id = $1 WHERE id = $2`, [clientB, rateAId]);
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });
});
