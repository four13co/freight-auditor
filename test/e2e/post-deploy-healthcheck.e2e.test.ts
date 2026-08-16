import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { pollHealth } from '../../scripts/post-deploy-healthcheck.mjs';

/**
 * e2e: poll a real listening HTTP server (not a mocked fetch), matching how
 * scripts/post-deploy-healthcheck.mjs is actually invoked in deploy.yml.
 */
describe('pollHealth against a real server (e2e)', () => {
  let app: FastifyInstance;
  let healthUrl: string;
  let currentBuild = 'sha-old';
  let currentDatabase = 'ok';

  beforeAll(async () => {
    app = Fastify();
    app.get('/health', async () => ({ status: 'ok', build: currentBuild, database: currentDatabase }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('expected a TCP address');
    healthUrl = `http://127.0.0.1:${addr.port}/health`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('detects the new revision immediately once it is the one being served', async () => {
    currentBuild = 'sha-new';
    const result = await pollHealth({
      healthUrl,
      expectedBuild: 'sha-new',
      retries: 3,
      intervalMs: 10,
    });
    expect(result.healthy).toBe(true);
    expect(result.lastBuild).toBe('sha-new');
  });

  it('exhausts retries and reports unhealthy if the revision never matches (simulated crash-loop)', async () => {
    currentBuild = 'sha-stuck-old';
    const result = await pollHealth({
      healthUrl,
      expectedBuild: 'sha-never-arrives',
      retries: 3,
      intervalMs: 10,
    });
    expect(result.healthy).toBe(false);
    expect(result.lastBuild).toBe('sha-stuck-old');
  });

  it('reports unhealthy when the endpoint is unreachable (simulated down port)', async () => {
    const result = await pollHealth({
      healthUrl: 'http://127.0.0.1:1/health',
      expectedBuild: 'sha-new',
      retries: 2,
      intervalMs: 10,
    });
    expect(result.healthy).toBe(false);
    expect(result.lastBuild).toBeNull();
  });

  describe('database-reachability gate (86e2v0acm)', () => {
    // Red/green verification of the exact bug that shipped: the right revision
    // deployed (build matches) but DATABASE_URL was never wired into the running
    // container, so every data endpoint 500'd while /health stayed green. The old
    // poller matched on build alone and would report this healthy.
    it('RED: never reports healthy while the deployed revision cannot reach its database', async () => {
      currentBuild = 'sha-new';
      currentDatabase = 'unreachable';
      const result = await pollHealth({
        healthUrl,
        expectedBuild: 'sha-new',
        retries: 3,
        intervalMs: 10,
      });
      expect(result.healthy).toBe(false);
      expect(result.lastBuild).toBe('sha-new');
      expect(result.lastDatabase).toBe('unreachable');
    });

    it('GREEN: reports healthy once the same revision can also reach its database', async () => {
      currentBuild = 'sha-new';
      currentDatabase = 'ok';
      const result = await pollHealth({
        healthUrl,
        expectedBuild: 'sha-new',
        retries: 3,
        intervalMs: 10,
      });
      expect(result.healthy).toBe(true);
      expect(result.lastBuild).toBe('sha-new');
      expect(result.lastDatabase).toBe('ok');
    });
  });
});
