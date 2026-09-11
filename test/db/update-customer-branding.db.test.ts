import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx, withTenantReadTx } from '../../src/db/tenant-context.js';
import { updateCustomerBranding } from '../../src/modules/identity/update-customer-branding.js';
import { resolveBrandingByDomain } from '../../src/modules/identity/resolve-branding-by-domain.js';

/**
 * 86e37r2t4: PATCH /api/internal/branding's backing write. Covers the update
 * itself, RLS tenant isolation (customer_branding carries FORCE RLS keyed on
 * client_id, migration 0077), the "no row yet for this tenant" boundary, and
 * AC1's explicit requirement that a subsequent GET /api/branding-equivalent
 * read (resolveBrandingByDomain) reflects the change.
 */
describe('updateCustomerBranding (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  let clientCId: string;
  const tag = `ucb-${Date.now()}`;
  const domainA = `bank-a.${tag}.test`;
  const domainB = `bank-b.${tag}.test`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('UCB-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('UCB-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('UCB-C', $1) RETURNING id`, [`${tag}-c`]);
      clientCId = c.rows[0].id;

      await owner.query(
        `INSERT INTO customer_branding (client_id, domain, logo_url, primary_color, secondary_color)
         VALUES ($1, $2, $3, $4, $5)`,
        [clientAId, domainA, 'https://cdn.example.com/a/logo.png', '#111111', '#222222'],
      );
      await owner.query(
        `INSERT INTO customer_branding (client_id, domain, logo_url, primary_color, secondary_color)
         VALUES ($1, $2, $3, $4, $5)`,
        [clientBId, domainB, 'https://cdn.example.com/b/logo.png', '#333333', '#444444'],
      );
      // clientCId deliberately gets no customer_branding row -- the "not
      // configured yet" case (found: false).
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM customer_branding WHERE client_id = ANY($1::uuid[])`, [[clientAId, clientBId, clientCId]]);
      await owner.query(`DELETE FROM client WHERE id = ANY($1::uuid[])`, [[clientAId, clientBId, clientCId]]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC1: updates the tenant\'s row and a subsequent read reflects the change', async () => {
    const result = await withTenantTx({ clientIds: [clientAId], internal: false }, (client) =>
      updateCustomerBranding(client, clientAId, {
        logoUrl: 'https://cdn.example.com/a/new-logo.png',
        primaryColor: '#abcdef',
        secondaryColor: '#123456',
      }),
    );
    expect(result).toEqual({
      found: true,
      branding: { logoUrl: 'https://cdn.example.com/a/new-logo.png', primaryColor: '#abcdef', secondaryColor: '#123456' },
    });

    const read = await withTenantReadTx({ internal: true }, (client) => resolveBrandingByDomain(client, domainA));
    expect(read).toMatchObject({
      logoUrl: 'https://cdn.example.com/a/new-logo.png',
      primaryColor: '#abcdef',
      secondaryColor: '#123456',
    });
  });

  it('accepts a null secondaryColor, clearing the previously-set value', async () => {
    const result = await withTenantTx({ clientIds: [clientBId], internal: false }, (client) =>
      updateCustomerBranding(client, clientBId, {
        logoUrl: 'https://cdn.example.com/b/logo.png',
        primaryColor: '#333333',
        secondaryColor: null,
      }),
    );
    expect(result).toEqual({
      found: true,
      branding: { logoUrl: 'https://cdn.example.com/b/logo.png', primaryColor: '#333333', secondaryColor: null },
    });
  });

  it('returns found: false when the tenant has no customer_branding row yet', async () => {
    const result = await withTenantTx({ clientIds: [clientCId], internal: false }, (client) =>
      updateCustomerBranding(client, clientCId, {
        logoUrl: 'https://cdn.example.com/c/logo.png',
        primaryColor: '#000000',
        secondaryColor: null,
      }),
    );
    expect(result).toEqual({ found: false });
  });

  it('AC2/RLS: a request scoped to client B cannot update client A\'s row, even naming client A\'s id explicitly', async () => {
    const result = await withTenantTx({ clientIds: [clientBId], internal: false }, (client) =>
      updateCustomerBranding(client, clientAId, {
        logoUrl: 'https://cdn.example.com/attacker/logo.png',
        primaryColor: '#ff0000',
        secondaryColor: null,
      }),
    );
    expect(result).toEqual({ found: false });

    const stillA = await withTenantReadTx({ internal: true }, (client) => resolveBrandingByDomain(client, domainA));
    expect(stillA?.logoUrl).not.toBe('https://cdn.example.com/attacker/logo.png');
  });
});
