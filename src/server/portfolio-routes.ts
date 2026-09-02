import type { FastifyInstance } from 'fastify';
import { withTenantReadTx } from '../db/tenant-context.js';
import { registerInternalAnalystAuthPreHandler } from '../modules/findings/internal-analyst-auth.js';
import { getCrossClientPortfolio } from '../modules/claims/get-cross-client-portfolio.js';

/**
 * Cross-client portfolio reporting for internal analysts (P5.C.3, rebuild
 * of the PR #247 attempt Review closed for a cross-tenant leak). Own
 * encapsulation with its OWN preHandler -- registerInternalAnalystAuthPreHandler,
 * not the shared registerTenantAuthPreHandler every other tenant-scoped
 * route module uses -- so no existing route's auth behavior is touched by
 * this item. See internal-analyst-auth.ts's header comment for the full
 * rationale.
 */
export async function registerPortfolioRoutes(routes: FastifyInstance): Promise<void> {
  await registerInternalAnalystAuthPreHandler(routes);

  // 86e2zfjym: read-only, so routed through withTenantReadTx (replica pool
  // when configured, else the primary — identical to today when unconfigured).
  routes.get('/api/portfolio/cross-client-recovery', async (request) => {
    const buckets = await withTenantReadTx(request.tenantContext!, (client) => getCrossClientPortfolio(client));
    return { buckets };
  });
}
