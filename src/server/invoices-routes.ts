import type { FastifyInstance } from 'fastify';
import { withTenantReadTx } from '../db/tenant-context.js';
import { registerInternalAnalystAuthPreHandler } from '../modules/findings/internal-analyst-auth.js';
import { listInvoices } from '../modules/invoices/list-invoices.js';

/**
 * 86e37r2rt: the internal-analyst-facing invoice list backing Sidebar.tsx's
 * "Invoices" nav item (the second "Soon"-badged item under "Audit", after
 * 86e37r2rm's Discrepancies). Own preHandler --
 * registerInternalAnalystAuthPreHandler, the same one portfolio-routes.ts
 * uses -- not the shared registerTenantAuthPreHandler every per-tenant route
 * uses: this is a cross-client, ops-facing view (the sidebar groups it under
 * "Audit" alongside the portfolio-wide Discrepancies list), distinct from
 * ClientInvoicesView.tsx's portal-scoped /api/portal/invoices (a client's own
 * tenant-scoped invoices, untouched by this item's No-gos). A portal
 * membership alone (client_viewer/client_admin) is rejected 401 here even
 * though it would be accepted by the shared tenant-auth preHandler on other
 * routes -- see internal-analyst-auth.ts's own header comment.
 */
export async function registerInvoicesRoutes(routes: FastifyInstance): Promise<void> {
  await registerInternalAnalystAuthPreHandler(routes);

  // Read-only, so routed through withTenantReadTx (replica pool when
  // configured, else the primary), same as GET /api/findings and GET
  // /api/portfolio/cross-client-recovery.
  routes.get('/api/invoices', async (request) => {
    const query = request.query as { carrier?: string; status?: string };
    const invoices = await withTenantReadTx(request.tenantContext!, (client) =>
      listInvoices(client, { carrier: query.carrier, status: query.status }),
    );
    return { invoices };
  });
}
