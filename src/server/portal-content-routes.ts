import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerClientViewerAuthPreHandler } from '../modules/identity/client-viewer-auth.js';
import { listClientInvoices } from '../modules/portal/list-client-invoices.js';
import { getClientScorecardSummary } from '../modules/portal/get-client-scorecard-summary.js';

const MAX_LIMIT = 200;

/**
 * Client portal content read APIs (P6.B.1): invoice list + scorecard
 * summary, gated by client-viewer-auth.ts's OWN preHandler
 * (registerClientViewerAuthPreHandler) rather than the shared
 * registerTenantAuthPreHandler every internal-facing route module uses --
 * same reasoning as portfolio-routes.ts's own header comment: this surface
 * must only ever grant access to a `client_viewer` membership, and must
 * reject client_admin/internal roles and any non-GET/HEAD method
 * structurally, before this handler runs. client_viewer-auth.ts's context
 * always resolves a single clientId (never multi-client), so unlike
 * claim-recovery-routes.ts there is no "no single tenant scope" case to
 * reject here.
 *
 * client_admin's equivalent access (P6.A.3, sibling capability) and the
 * portal UI shell/nav that will mount these views (P6.A.1) are explicitly
 * out of this task's boundary -- see this task's own Exclusions.
 */
export async function registerPortalContentRoutes(routes: FastifyInstance): Promise<void> {
  await registerClientViewerAuthPreHandler(routes);

  routes.get('/api/portal/invoices', async (request, reply) => {
    const clientId = request.tenantContext!.clientIds![0]!;

    const query = request.query as { status?: string; limit?: string; offset?: string };

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

    const invoices = await withTenantTx(request.tenantContext!, (client) =>
      listClientInvoices(client, clientId, { status: query.status, limit, offset }),
    );
    return { invoices };
  });

  routes.get('/api/portal/scorecard', async (request) => {
    const clientId = request.tenantContext!.clientIds![0]!;

    const buckets = await withTenantTx(request.tenantContext!, (client) => getClientScorecardSummary(client, clientId));
    return { buckets };
  });
}
