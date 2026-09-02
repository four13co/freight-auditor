import type { FastifyInstance } from 'fastify';
import { withTenantReadTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { getPortfolioReconciliation } from '../modules/claims/get-portfolio-reconciliation.js';

/**
 * Client-level recovery reporting (P5.C.2): the single-tenant analog of
 * portfolio-routes.ts's cross-client report. Reuses getPortfolioReconciliation
 * (P5.C.4) as-is -- no reconciliation math is re-derived here, only the
 * route wiring that module never had.
 */
export async function registerRecoveryReportRoutes(routes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(routes);

  routes.get('/api/portfolio/recovery-report', async (request, reply) => {
    const clientId = request.tenantContext!.clientIds?.[0];
    if (!clientId) return reply.code(401).send({ error: 'unauthorized' });

    const buckets = await withTenantReadTx(request.tenantContext!, (client) =>
      getPortfolioReconciliation(client, { clientId }));
    return { buckets };
  });
}
