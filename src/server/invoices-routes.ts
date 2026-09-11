import type { FastifyInstance } from 'fastify';
import { withTenantReadTx } from '../db/tenant-context.js';
import { listInvoices } from '../modules/invoices/list-invoices.js';
import { registerTenantAuthPreHandler, registerAnalystOnlyPreHandler } from '../modules/findings/tenant-auth.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * 86e37r2rt: internal-analyst-facing invoice list -- the second "Soon"-badged
 * Sidebar item to get a real route (86e37r2rm's Discrepancies page was the
 * first). Encapsulated so the preHandlers below bind ONLY to this plugin
 * (findings-routes.ts's own precedent/warning against registering at the app
 * level).
 *
 * Requeued after the first attempt (PR #372, closed on review) used
 * registerInternalAnalystAuthPreHandler (internal-analyst-auth.ts) -- that
 * resolver deliberately grants `{ internal: true }` with NO clientIds at all
 * (see its own header comment: reserved for genuinely cross-client routes
 * like portfolio-routes.ts's GET /api/portfolio/cross-client-recovery), so
 * every tenant's invoices leaked into every request regardless of caller.
 * This item's own AC1 requires per-tenant RLS scoping ("every invoice
 * visible under RLS" for THIS caller, mirroring list-findings.db.test.ts's
 * fixture pattern), so it needs registerTenantAuthPreHandler instead --
 * same shared resolver findings-routes.ts/dispute-review-routes.ts/
 * payment-routes.ts already use. Unlike those files (whose plain GET routes
 * stay open to portal viewers too), this item's own AC5 requires a portal
 * session to be rejected from GET /api/invoices specifically, so
 * registerAnalystOnlyPreHandler is applied at the top level here rather than
 * nested around a mutation-only sub-scope -- there is no mutation route in
 * this file to separate it from.
 */
export async function registerInvoicesRoutes(routes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(routes);
  await registerAnalystOnlyPreHandler(routes);

  routes.get('/api/invoices', async (request, reply) => {
    const query = request.query as { carrier?: string; status?: string; limit?: string; offset?: string };

    let limit: number | undefined;
    if (query.limit !== undefined) {
      limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        await reply.code(400).send({ error: `invalid limit: must be an integer between 1 and ${MAX_LIMIT}` });
        return;
      }
    }

    let offset: number | undefined;
    if (query.offset !== undefined) {
      offset = Number(query.offset);
      if (!Number.isInteger(offset) || offset < 0) {
        await reply.code(400).send({ error: 'invalid offset: must be a non-negative integer' });
        return;
      }
    }

    const ctx = request.tenantContext!;
    const invoices = await withTenantReadTx(ctx, (client) =>
      listInvoices(client, {
        carrier: query.carrier,
        status: query.status,
        limit: limit ?? DEFAULT_LIMIT,
        offset,
      }),
    );
    return { invoices };
  });
}
