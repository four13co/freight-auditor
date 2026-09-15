import { describe, it, expect, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { createCustomerBranding } from '../../src/modules/identity/create-customer-branding.js';

/**
 * 86e38rdnm: the INSERT half of customer_branding -- companion to
 * update-customer-branding.db.test.ts's UPDATE-only coverage. Proves the
 * insert succeeds under an internal (cross-client) context, and that a
 * second call for the same tenant is rejected (409-mapped by the route,
 * asserted at the pg error-code level here).
 */
describe('createCustomerBranding (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `ccb-${Date.now()}`;
  const domain = `bank.${tag}.test`;

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM customer_branding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC2: inserts a branding row for a tenant with none yet, scoped via internal context', async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const created = await owner.query(`INSERT INTO client (name, slug) VALUES ('CCB Client', $1) RETURNING id`, [tag]);
      clientId = created.rows[0].id;
    } finally {
      owner.release();
    }

    const result = await withTenantTx({ internal: true }, (client) =>
      createCustomerBranding(client, { clientId, domain, logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233', secondaryColor: '#445566' }),
    );
    expect(result).toEqual({ logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233', secondaryColor: '#445566' });

    const readBack = await withTenantTx({ internal: true }, (client) =>
      client.query(`SELECT domain, logo_url FROM customer_branding WHERE client_id = $1`, [clientId]),
    );
    expect(readBack.rows[0]).toMatchObject({ domain, logo_url: 'https://cdn.example.com/logo.png' });
  });

  it('a second insert for the same tenant throws a unique-violation (409 at the route)', async () => {
    await expect(
      withTenantTx({ internal: true }, (client) =>
        createCustomerBranding(client, { clientId, domain: `${domain}-second`, logoUrl: 'https://cdn.example.com/other.png', primaryColor: '#000000', secondaryColor: null }),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('a non-internal context scoped to a different tenant cannot insert branding for this one (RLS)', async () => {
    await expect(
      withTenantTx({ clientIds: ['00000000-0000-4000-8000-000000000000'], internal: false }, (client) =>
        createCustomerBranding(client, { clientId, domain: `${domain}-rls`, logoUrl: 'https://cdn.example.com/rls.png', primaryColor: '#abcdef', secondaryColor: null }),
      ),
    ).rejects.toBeTruthy();
  });
});
