import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';

const run = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_DIR = join(REPO_ROOT, 'web');
const WEB_DIST = join(WEB_DIR, 'dist');
const WEB_NODE_MODULES = join(WEB_DIR, 'node_modules');

/**
 * e2e: boot a real listening server and hit GET / over HTTP — proves the
 * placeholder frontend is actually served, not just that files exist on disk
 * (86e2u7j01 AC2).
 *
 * No CI step installs/builds web/ yet (that's a deliberate follow-up, flagged
 * in this PR), so a genuinely clean checkout has neither web/node_modules nor
 * web/dist -- this test installs + builds them itself as setup, the same way
 * a real deploy would need to before this route can ever 200. Without this,
 * the test only passed on a machine where someone had manually run
 * `cd web && npm ci && npm run build` before -- exactly the bug Review caught
 * in the first pass at this item (the e2e test looked green locally but would
 * have failed on every fresh `npm ci` + `npm test` CI run).
 */
describe('server serves the frontend placeholder at GET /', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    if (!existsSync(WEB_NODE_MODULES)) {
      await run('npm', ['ci'], { cwd: WEB_DIR });
    }
    if (!existsSync(WEB_DIST)) {
      await run('npm', ['run', 'build'], { cwd: WEB_DIR });
    }
    app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('expected a TCP address');
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with HTML containing "Freight Auditor", not a 404', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Freight Auditor');
  });
});
