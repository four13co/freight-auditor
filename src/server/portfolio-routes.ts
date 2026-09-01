import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerInternalAnalystAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { getCrossClientPortfolioReport } from '../modules/claims/get-cross-client-portfolio-report.js';

/**
 * Cross-client portfolio reporting API (P5.C.3): an internal analyst reads
 * claimed/recovered/outstanding/written-off/denied totals bucketed by
 * (client, currency) across every client in the portfolio -- the analyst
 * sibling of get-carrier-recovery-report.ts (per-carrier, single client)
 * and get-portfolio-reconciliation.ts (single client, across carriers).
 *
 * Encapsulated so registerInternalAnalystAuthPreHandler binds ONLY to this
 * plugin instance -- registering it at the app level would also gate
 * /health and every other route (findings-routes.ts's own precedent).
 * registerInternalAnalystAuthPreHandler rejects a client-scoped caller with
 * 403 (identity proven, not authorized for this route) and any
 * unauthenticated caller with 401, so there is no clientId in this route's
 * path or query -- the whole point is that no single client is in scope.
 */
export async function registerPortfolioRoutes(portfolioRoutes: FastifyInstance): Promise<void> {
  await registerInternalAnalystAuthPreHandler(portfolioRoutes);

  portfolioRoutes.get('/api/portfolio/cross-client-recovery', async (request) => {
    const buckets = await withTenantTx(request.tenantContext!, (client) => getCrossClientPortfolioReport(client));
    return { buckets };
  });
}
