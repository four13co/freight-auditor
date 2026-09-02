import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { buildApp } from '../../src/server/app.js';

/**
 * 86e320pkc: live-wiring proof for GET /api/branding -- a real Fastify app,
 * a real Postgres, two real Customers each with their own domain/branding
 * row, resolved purely from the request's Host header via app.inject
 * (mirrors metrics-endpoint.db.test.ts's app.inject shape). No session/auth
 * headers at all -- this route is deliberately reachable pre-login (see
 * branding-routes.ts's own header comment).
 */
describe('GET /api/branding against a live database (database)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientAId: string;
  let clientBId: string;
  const tag = `wl-${Date.now()}`;
  const domainA = `bank-a.${tag}.test`;
  const domainB = `bank-b.${tag}.test`;
  const defaultDomain = `app.${tag}.test`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('Bank A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('Bank B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;

      await owner.query(
        `INSERT INTO customer_branding (client_id, domain, logo_url, primary_color, secondary_color)
         VALUES ($1, $2, $3, $4, $5)`,
        [clientAId, domainA, 'https://cdn.example.com/bank-a/logo.png', '#111111', '#222222'],
      );
      await owner.query(
        `INSERT INTO customer_branding (client_id, domain, logo_url, primary_color, secondary_color)
         VALUES ($1, $2, $3, $4, $5)`,
        [clientBId, domainB, 'https://cdn.example.com/bank-b/logo.png', '#333333', '#444444'],
      );
    } finally {
      owner.release();
    }

    app = buildApp();
  });

  afterAll(async () => {
    await app.close();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM customer_branding WHERE client_id = ANY($1)`, [[clientAId, clientBId]]);
      await owner.query(`DELETE FROM client WHERE id = ANY($1)`, [[clientAId, clientBId]]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC1: a request for a configured domain gets that Customer\'s logo and colors', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/branding', headers: { host: domainA } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      branded: true,
      logoUrl: 'https://cdn.example.com/bank-a/logo.png',
      primaryColor: '#111111',
      secondaryColor: '#222222',
    });
  });

  it('AC2: a request for the platform default domain (no Customer configured) gets default (unbranded) fallback', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/branding', headers: { host: defaultDomain } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ branded: false });
  });

  it('AC2: no Host header at all also falls back to unbranded, never throws', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/branding' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ branded: false });
  });

  it('AC3: switching domains shows switching branding, with no bleed-through between the two Customers', async () => {
    const resA = await app.inject({ method: 'GET', url: '/api/branding', headers: { host: domainA } });
    const resB = await app.inject({ method: 'GET', url: '/api/branding', headers: { host: domainB } });

    expect(resA.json()).toMatchObject({ primaryColor: '#111111', logoUrl: 'https://cdn.example.com/bank-a/logo.png' });
    expect(resB.json()).toMatchObject({ primaryColor: '#333333', logoUrl: 'https://cdn.example.com/bank-b/logo.png' });
    expect(resA.json()).not.toEqual(resB.json());
  });

  it('a request Host header carrying a port still resolves to the configured domain', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/branding', headers: { host: `${domainA}:4180` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ branded: true, primaryColor: '#111111' });
  });
});
