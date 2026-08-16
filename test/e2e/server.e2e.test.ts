import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';

/**
 * e2e: boot a real listening server on an ephemeral port and hit it over HTTP
 * with the platform fetch — the user-visible flow, not an in-process inject.
 */
describe('server boots and serves /health over HTTP', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('expected a TCP address');
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('responds 200 {status:"ok"} on GET /health', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });
});

/**
 * 86e2v07n3: the dashboard has never been deployed -- these run only when
 * web/dist exists (built via `npm --prefix web run build` before `npm test`
 * in CI/locally), the same condition resolveWebDist() itself checks. Skipped
 * rather than failed when absent, so a fresh checkout's `npm test` (no web/
 * build step) doesn't spuriously fail -- this mirrors resolveWebDist()'s own
 * tolerant-by-design behavior, not a gap in coverage: AC5's "still starts and
 * serves the API without web/dist" is proven by the /health + 401 tests
 * above and in test/db/dashboard-auth-headers.db.test.ts, which run with no
 * web/dist present at all in a bare checkout.
 */
describe.skipIf(!existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist')))(
  'server serves the built frontend when web/dist exists (86e2v07n3)',
  () => {
    let app: FastifyInstance;
    let baseUrl: string;

    beforeAll(async () => {
      app = buildApp();
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      if (addr === null || typeof addr === 'string') {
        throw new Error('expected a TCP address');
      }
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
      await app.close();
    });

    it('AC2: GET / serves the dashboard HTML (200, not 404), containing the app root element', async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<div id="root">');
    });

    it('AC3: the JS asset index.html references resolves (no 404 on /assets/*)', async () => {
      const indexRes = await fetch(`${baseUrl}/`);
      const html = await indexRes.text();
      const assetMatch = html.match(/src="(\/assets\/[^"]+\.js)"/);
      expect(assetMatch).not.toBeNull();
      const assetRes = await fetch(`${baseUrl}${assetMatch![1]}`);
      expect(assetRes.status).toBe(200);
    });

    it('AC4: /api/findings is still reachable (401 without auth headers, not 404) -- the static handler does not shadow it', async () => {
      const res = await fetch(`${baseUrl}/api/findings`);
      expect(res.status).toBe(401);
    });
  },
);
