import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { withTenantTx } from '../db/tenant-context.js';
import { listFindings } from '../modules/findings/list-findings.js';
import { resolveDevTenantContext } from '../modules/findings/dev-tenant-stub.js';

/**
 * The running revision's build SHA, for a rolling-deploy health check to tell
 * revisions apart. `BUILD_SHA` wins for tests/local dev; otherwise read the
 * file the CI build step writes into the image (see .github/workflows/deploy.yml).
 */
function resolveBuildSha(): string {
  if (process.env.BUILD_SHA) return process.env.BUILD_SHA;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, 'BUILD_SHA'), 'utf8').trim();
  } catch {
    return 'dev';
  }
}

/**
 * Build the Fastify application instance.
 *
 * Kept separate from the server bootstrap (`index.ts`) so tests can build the
 * app and call `.inject()` without binding a TCP port.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  const buildSha = resolveBuildSha();

  app.get('/health', async () => {
    return { status: 'ok', build: buildSha };
  });

  app.get('/api/findings', async (request) => {
    // Fastify's querystring parser returns keys literally as sent -- the
    // item's own AC names this param `min-amount` (kebab-case, conventional
    // for query strings), so it must be read that way, not as `minAmount`
    // (86e2u7j0d Review finding: the camelCase read left the filter dead).
    const query = request.query as { carrier?: string; status?: string; 'min-amount'?: string };
    const ctx = resolveDevTenantContext(request);
    const findings = await withTenantTx(ctx, (client) =>
      listFindings(client, {
        carrier: query.carrier,
        status: query.status,
        minAmount: query['min-amount'],
      }),
    );
    return { findings };
  });

  return app;
}
