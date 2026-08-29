import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { getClientRecoverySummary } from '../modules/claims/get-client-recovery-summary.js';

/**
 * Client-facing recovery report (P5.C.2): the tenant's own view of their
 * overall claimed/recovered/outstanding/written-off/denied position,
 * bucketed by currency. Own encapsulation so the tenant-auth preHandler
 * binds ONLY to this route, following evidence-routes.ts's pattern.
 *
 * No pagination: this returns one row per currency the tenant's claims use
 * (typically 1-2), not a list of records -- the "high-volume paths are
 * paginated" AC does not apply to an aggregation of this shape.
 */
export async function registerRecoveryReportRoutes(routes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(routes);

  routes.get('/api/recovery-report', async (request, reply) => {
    const clientId = request.tenantContext!.clientIds?.[0];
    if (!clientId) return reply.code(401).send({ error: 'unauthorized' });
    const buckets = await withTenantTx(request.tenantContext!, (client) => getClientRecoverySummary(client, clientId));
    return { buckets };
  });
}
