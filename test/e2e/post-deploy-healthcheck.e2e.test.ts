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

  beforeAll(async () => {
    app = Fastify();
    app.get('/health', async () => ({ status: 'ok', build: currentBuild }));
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
});
