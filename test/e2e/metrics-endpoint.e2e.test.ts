import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

/**
 * e2e: boot a real listening server on an ephemeral port and hit GET
 * /metrics over HTTP with the platform fetch, sending NO auth headers at
 * all -- the actual shape of a Prometheus scraper, which carries no
 * session. Mirrors server.e2e.test.ts's own /health e2e test. The two
 * collectors are mocked (same boundary as test/unit/metrics-endpoint.test.ts)
 * so this proves the route's real socket/registration/auth-posture path
 * without requiring a live Postgres -- this suite (test/e2e/**) is exercised
 * by the coverage-gate job, which runs with no DATABASE_URL. Real live-DB
 * wiring (real pgboss schema, real RLS-scoped discovery reads) is proven
 * separately in test/db/metrics-endpoint.db.test.ts.
 */
describe('GET /metrics against a real listening server, no auth headers (e2e)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/jobs/metrics.js');
    vi.doUnmock('../../src/jobs/discovery-metrics.js');
  });

  it('AC3: responds 200 with the metrics body, no session/auth required', async () => {
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: pg.PoolClient) => unknown) => fn({} as pg.PoolClient)),
    }));
    vi.doMock('../../src/jobs/metrics.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/jobs/metrics.js')>('../../src/jobs/metrics.js');
      return {
        ...actual,
        collectQueueMetrics: vi.fn().mockResolvedValue([
          { queue: 'freight.audit.evaluate.v1', depth: 1, failures: 0, retries: 0, oldestPendingAgeSeconds: 0 },
        ]),
      };
    });
    vi.doMock('../../src/jobs/discovery-metrics.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/jobs/discovery-metrics.js')>('../../src/jobs/discovery-metrics.js');
      return {
        ...actual,
        collectDiscoveryMetrics: vi.fn().mockResolvedValue({
          aiProposalsByModel: [], abstentionsByReason: [], humanTouchCorrections: 0,
          humanTouchRatifications: 0, proposalsByLifecycle: [],
        }),
      };
    });
    const { buildApp } = await import('../../src/server/app.js');

    app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('expected a TCP address');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${baseUrl}/metrics`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('freight_job_queue_depth{queue="freight.audit.evaluate.v1"} 1');
  });
});
