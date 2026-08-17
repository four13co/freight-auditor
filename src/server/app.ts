import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { withTenantTx, type TenantContext } from '../db/tenant-context.js';
import { getPool } from '../db/pool.js';
import { listFindings } from '../modules/findings/list-findings.js';
import { getFindingsSummary } from '../modules/findings/findings-summary.js';
import { listGateFailures } from '../modules/findings/list-gate-failures.js';
import { resolveAuthorizedTenantContext } from '../modules/findings/tenant-auth.js';

// 86e2v24ye: mirrors migrations/0002_enums.sql's variance_status enum exactly
// -- kept as a literal set here (not imported) since src/ has no existing
// runtime dependency on the migrations/ directory; FindingsTable.tsx's status
// dropdown is the other place these same values are duplicated.
const VARIANCE_STATUS_VALUES = new Set([
  'open', 'in_review', 'accepted', 'waived',
  'queued_for_dispute', 'disputed', 'recovered', 'written_off', 'closed',
]);

// Explicit numeric-string check rather than Number()/isNaN -- Number('') is
// 0, Number('0x10') is 16, and Number('Infinity') is finite per isNaN, all of
// which would wrongly pass a naive check and still reach Postgres unvalidated.
const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

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

  // Deliberately never throws and never changes the response status: /health also
  // functions as CapRover's container-liveness probe, and a 5xx or hang here would
  // trigger restart-loop behavior unrelated to the actual DB outage. The `database`
  // field is the signal for callers (post-deploy-healthcheck.mjs) who care about
  // more than "the process is up" -- see 86e2v0acm, where DATABASE_URL was never
  // wired into the running container and every data endpoint 500'd while /health
  // stayed green because it never touched Postgres.
  app.get('/health', async () => {
    let database: 'ok' | 'unreachable';
    try {
      await getPool().query('SELECT 1');
      database = 'ok';
    } catch {
      database = 'unreachable';
    }
    return { status: 'ok', build: buildSha, database };
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

    findingsRoutes.get('/api/findings', async (request, reply) => {
      // Fastify's querystring parser returns keys literally as sent -- the
      // item's own AC names this param `min-amount` (kebab-case, conventional
      // for query strings), so it must be read that way, not as `minAmount`
      // (86e2u7j0d Review finding: the camelCase read left the filter dead).
      const query = request.query as { carrier?: string; status?: string; 'min-amount'?: string };

      // 86e2v24ye: both params previously reached listFindings' raw SQL
      // unvalidated -- an invalid status broke the ::variance_status cast and
      // a non-numeric min-amount broke the numeric comparison, and with no
      // setErrorHandler registered, Fastify's default handler reflected the
      // raw Postgres error (query/stack detail) straight into the 500 body.
      // Validating here, before withTenantTx ever runs, keeps listFindings'
      // own query-building free of HTTP concerns (already fully covered via
      // a mocked client in list-findings.test.ts) and matches this repo's
      // boundary-validation convention -- these values are only ever
      // untrusted at the moment they cross the wire.
      if (query.status !== undefined && !VARIANCE_STATUS_VALUES.has(query.status)) {
        await reply.code(400).send({ error: `invalid status: must be one of ${[...VARIANCE_STATUS_VALUES].join(', ')}` });
        return;
      }
      if (query['min-amount'] !== undefined && !NUMERIC_STRING.test(query['min-amount'])) {
        await reply.code(400).send({ error: 'invalid min-amount: must be numeric' });
        return;
      }

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

    // 86e2v17xn: a rejected invoice's kickback -- structurally distinct from
    // a variance finding (no billed/expected/variance amounts), so it's a
    // separate route returning a separate row shape, not a filter/field on
    // /api/findings.
    findingsRoutes.get('/api/gate-failures', async (request) => {
      const query = request.query as { carrier?: string };
      const ctx = (request as FastifyRequest & { tenantContext: TenantContext }).tenantContext;
      const gateFailures = await withTenantTx(ctx, (client) =>
        listGateFailures(client, { carrier: query.carrier }),
      );
      return { gateFailures };
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
