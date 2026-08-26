import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { listFindings, type FindingsSortKey } from '../modules/findings/list-findings.js';
import { getFindingsSummary } from '../modules/findings/findings-summary.js';
import { listGateFailures } from '../modules/findings/list-gate-failures.js';
import { updateFindingStatus } from '../modules/findings/update-finding-status.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { ALL_VARIANCE_STATUSES, WRITABLE_VARIANCE_STATUSES } from '../shared/variance-status.js';
import { isUuid } from '../shared/request-validation.js';
import { listReviewQueues } from '../modules/findings/list-review-queues.js';

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
 * 86e2wb4zg: findings + gate-failures + status-update, split out of app.ts's
 * shared import/const seam (the region 86e2wwaeq's architecture review found
 * as the repo's actual recurring merge-collision point, not route bodies
 * themselves) into its own domain module. Mechanical move -- no behavior
 * change; registered by app.ts as `app.register(registerFindingsRoutes)`.
 *
 * Encapsulated so the tenant-auth preHandler binds ONLY to these routes --
 * registering it on the top-level app instance would also gate /health,
 * breaking the rolling-deploy health check (and anything else mounted
 * later) with a 401 it was never meant to see.
 */
export async function registerFindingsRoutes(findingsRoutes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(findingsRoutes);

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

    const ctx = request.tenantContext!;
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
    const ctx = request.tenantContext!;
    const summary = await withTenantTx(ctx, (client) => getFindingsSummary(client));
    return summary;
  });
  findingsRoutes.get('/api/findings/queues', async (request) =>
    withTenantTx(request.tenantContext!, (client) => listReviewQueues(client)));

  // 86e2v17xn: a rejected invoice's kickback -- structurally distinct from
  // a variance finding (no billed/expected/variance amounts), so it's a
  // separate route returning a separate row shape, not a filter/field on
  // /api/findings.
  findingsRoutes.get('/api/gate-failures', async (request) => {
    const query = request.query as { carrier?: string };
    const ctx = request.tenantContext!;
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

    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid finding id: must be a well-formed UUID' });
      return;
    }

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

    const ctx = request.tenantContext!;
    const result = await withTenantTx(ctx, (client) =>
      updateFindingStatus(client, id, body.status as string, body.note as string | undefined, request.actorUserId),
    );

    if (!result.found) {
      await reply.code(404).send({ error: 'finding not found' });
      return;
    }
    return { id, status: body.status };
  });
}
