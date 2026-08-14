import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { withTenantTx, type TenantContext } from '../db/tenant-context.js';
import { listFindings } from '../modules/findings/list-findings.js';
import { getFindingsSummary } from '../modules/findings/findings-summary.js';
import { resolveAuthorizedTenantContext } from '../modules/findings/tenant-auth.js';

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
 * Locate the built frontend (web/dist) relative to the repo root. Not present
 * in the production image yet (Dockerfile/deploy tarball only ship the
 * backend's dist/ — see 86e2u7j01's PR for the follow-up); this resolves for
 * local dev (tsx, repo root two levels up from src/server) and for tests run
 * from the repo root.
 */
function resolveWebDist(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, '..', '..', 'web', 'dist');
  return existsSync(candidate) ? candidate : undefined;
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

  // Encapsulated so the tenant-auth preHandler binds ONLY to these two
  // routes -- registering it on `app` directly would also gate /health,
  // breaking the rolling-deploy health check (and anything else mounted
  // later) with a 401 it was never meant to see.
  void app.register(async (findingsRoutes) => {
    findingsRoutes.addHook(
      'preHandler',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const ctx = await resolveAuthorizedTenantContext(request);
        if (!ctx) {
          await reply.code(401).send({ error: 'unauthorized' });
          return;
        }
        (request as FastifyRequest & { tenantContext: TenantContext }).tenantContext = ctx;
      },
    );

    findingsRoutes.get('/api/findings', async (request) => {
      // Fastify's querystring parser returns keys literally as sent -- the
      // item's own AC names this param `min-amount` (kebab-case, conventional
      // for query strings), so it must be read that way, not as `minAmount`
      // (86e2u7j0d Review finding: the camelCase read left the filter dead).
      const query = request.query as { carrier?: string; status?: string; 'min-amount'?: string };
      const ctx = (request as FastifyRequest & { tenantContext: TenantContext }).tenantContext;
      const findings = await withTenantTx(ctx, (client) =>
        listFindings(client, {
          carrier: query.carrier,
          status: query.status,
          minAmount: query['min-amount'],
        }),
      );
      return { findings };
    });

    findingsRoutes.get('/api/findings/summary', async (request) => {
      const ctx = (request as FastifyRequest & { tenantContext: TenantContext }).tenantContext;
      const summary = await withTenantTx(ctx, (client) => getFindingsSummary(client));
      return summary;
    });
  });

  const webDist = resolveWebDist();
  if (webDist) {
    void app.register(fastifyStatic, {
      root: webDist,
      index: 'index.html',
    });
  }

  return app;
}
