import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { closePool } from '../../src/db/pool.js';

/**
 * 86e2v0acm: /health must report actual DB reachability, not just process
 * liveness. The unit suite (test/unit/health.test.ts) proves the unreachable
 * path with no DATABASE_URL; this proves the positive path against the real
 * ephemeral container Postgres, per the reachable-DB half of that contract.
 */
describe('GET /health against a live database', () => {
  afterAll(async () => {
    await closePool();
  });

  it('reports database:"ok" when DATABASE_URL points at a reachable Postgres', async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'ok', database: 'ok' });
    } finally {
      await app.close();
    }
  });

  it('reports ready when Postgres and the configured local test store are reachable', async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'ready',
        database: 'ok',
        object_store: 'ok',
      });
    } finally {
      await app.close();
    }
  });
});
