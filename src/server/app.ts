import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { withTenantTx, type TenantContext } from '../db/tenant-context.js';
import { getPool } from '../db/pool.js';
import { listFindings, type FindingsSortKey } from '../modules/findings/list-findings.js';
import { getFindingsSummary } from '../modules/findings/findings-summary.js';
import { listGateFailures } from '../modules/findings/list-gate-failures.js';
import { updateFindingStatus } from '../modules/findings/update-finding-status.js';
import { resolveAuthorizedTenantContext, listMembershipClientIds } from '../modules/findings/tenant-auth.js';
import { getAuth } from '../auth/better-auth.js';
import { ALL_VARIANCE_STATUSES, WRITABLE_VARIANCE_STATUSES } from '../shared/variance-status.js';

// 86e2v892h: derived from the shared source (mirrors migrations/0002_enums.sql's
// variance_status enum exactly) rather than a separate hand-maintained literal.
const VARIANCE_STATUS_VALUES = new Set<string>(ALL_VARIANCE_STATUSES);

// 86e2v1xyr: the drawer's write path is scoped to the same 5 values the
// status FILTER dropdown exposes (FindingsTable.tsx) -- the item's explicit
// coherence rule: a finding set to a value the filter can't select would
// become unreachable through the UI. GET /api/findings' own query-param
// validation intentionally stays on the full 9-value VARIANCE_STATUS_VALUES
// (a filter param and a write target are different concerns), so this stays
// a separate, narrower set rather than sharing VARIANCE_STATUS_VALUES --
// but both sides of the writable set (this, and FindingDetail.tsx's) now
// derive from the one shared WRITABLE_VARIANCE_STATUSES (86e2v892h).
const WRITABLE_STATUS_VALUES = new Set<string>(WRITABLE_VARIANCE_STATUSES);

// Explicit numeric-string check rather than Number()/isNaN -- Number('') is
// 0, Number('0x10') is 16, and Number('Infinity') is finite per isNaN, all of
// which would wrongly pass a naive check and still reach Postgres unvalidated.
const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

// 86e2v251e: must match list-findings.ts's ORDER_COLUMNS keys exactly --
// this is the query-param-facing half of the same allowlist boundary.
const SORT_KEYS = new Set<FindingsSortKey>(['variance', 'age']);
const SORT_DIRS = new Set(['asc', 'desc']);

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

  // 86e2v1bdj: 86e2v1bbr wired getAuth().api.getSession() into tenant-auth.ts
  // for session VERIFICATION only -- nothing mounted better-auth's own
  // handler as an actual HTTP route, so there was no endpoint a login form
  // could POST credentials to (sign-up/sign-in/get-session/sign-out, all of
  // better-auth's built-in routes). Registered at top level, NOT inside the
  // findingsRoutes encapsulation below -- it must NOT be gated behind
  // tenant-auth's preHandler, which would be circular (you need to hit this
  // route successfully to obtain the session tenant-auth then verifies).
  // better-auth's handler takes/returns the standard Fetch API Request/
  // Response; Fastify's raw req/res need adapting each way.
  app.all('/api/auth/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = `${request.protocol}://${request.hostname}${request.url}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const fetchRequest = new Request(url, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : JSON.stringify(request.body ?? {}),
    });

    const response = await getAuth().handler(fetchRequest);
    reply.status(response.status);
    response.headers.forEach((value, key) => {
      // set-cookie is the one header Fastify's reply.header() can't append
      // multiple values for via a single call the way Headers.forEach
      // iterates them (better-auth may set more than one cookie) -- raw.
      reply.raw.setHeader(key, key.toLowerCase() === 'set-cookie' ? response.headers.getSetCookie() : value);
    });
    const body = await response.text();
    return reply.send(body || null);
  });

  // 86e2wb92b: a real (non-dev-header) session proves WHO the user is, but
  // resolveViaSession (tenant-auth.ts) still requires an explicit
  // x-client-id header -- nothing previously told the frontend WHICH
  // client_id to send. This is that lookup: verify the session, then return
  // the client_id(s) the user has a membership row for, so login can store
  // one and start sending it as x-client-id on subsequent requests (option
  // (b), decided on the ClickUp task). Registered at top level like
  // /api/auth/* above, for the same reason -- it must be reachable with only
  // a session cookie, before any tenant scope exists.
  app.get('/api/auth/memberships', async (request: FastifyRequest, reply: FastifyReply) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const session = await getAuth().api.getSession({ headers });
    if (!session) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const clientIds = await listMembershipClientIds(session.user.id);
    return { clientIds };
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
      const query = request.query as {
        carrier?: string;
        status?: string;
        'min-amount'?: string;
        sort?: string;
        sortDir?: string;
      };

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
      // sort/sortDir feed an ORDER BY, which can't be parameter-bound like a
      // WHERE value -- this allowlist check IS the injection boundary (see
      // list-findings.ts's ORDER_COLUMNS comment), not just input hygiene.
      if (query.sort !== undefined && !SORT_KEYS.has(query.sort as FindingsSortKey)) {
        await reply.code(400).send({ error: `invalid sort: must be one of ${[...SORT_KEYS].join(', ')}` });
        return;
      }
      if (query.sortDir !== undefined && !SORT_DIRS.has(query.sortDir)) {
        await reply.code(400).send({ error: `invalid sortDir: must be one of ${[...SORT_DIRS].join(', ')}` });
        return;
      }

      const ctx = (request as FastifyRequest & { tenantContext: TenantContext }).tenantContext;
      const findings = await withTenantTx(ctx, (client) =>
        listFindings(client, {
          carrier: query.carrier,
          status: query.status,
          minAmount: query['min-amount'],
          sort: query.sort as FindingsSortKey | undefined,
          sortDir: query.sortDir as 'asc' | 'desc' | undefined,
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

    // 86e2v1xyr: the first mutating route in the app -- a single-finding
    // status transition from the detail drawer. Bulk actions stay disabled
    // (FindingsTable.tsx, per 86e2u7j1y's No-gos); this endpoint is
    // deliberately narrower than that.
    findingsRoutes.patch('/api/findings/:id/status', async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { status?: unknown; note?: unknown };

      if (typeof body.status !== 'string' || !WRITABLE_STATUS_VALUES.has(body.status)) {
        await reply
          .code(400)
          .send({ error: `invalid status: must be one of ${[...WRITABLE_STATUS_VALUES].join(', ')}` });
        return;
      }
      if (body.note !== undefined && typeof body.note !== 'string') {
        await reply.code(400).send({ error: 'invalid note: must be a string' });
        return;
      }

      const ctx = (request as FastifyRequest & { tenantContext: TenantContext }).tenantContext;
      const result = await withTenantTx(ctx, (client) =>
        updateFindingStatus(client, id, body.status as string, body.note as string | undefined),
      );

      if (!result.found) {
        await reply.code(404).send({ error: 'finding not found' });
        return;
      }
      return { id, status: body.status };
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
