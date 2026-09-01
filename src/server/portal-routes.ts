import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { getPortalOverview } from '../modules/portal/get-portal-overview.js';

/**
 * Client portal shell routes (P6.A.1). Own encapsulation so the tenant-auth
 * preHandler binds ONLY to portal routes, following recovery-report-routes.ts's
 * pattern -- reuses the SAME tenant identity (client/membership, RLS-bound
 * TenantContext) every other tenant-scoped route uses, per the item's own
 * rabbit-hole note against introducing a second notion of tenant.
 *
 * Role-appropriate scoping (client_admin vs. client_viewer) is P6.A.2/3's
 * job -- not built yet, so this route only proves tenant boundary, not role
 * boundary (same scope cut as P5.C.2's recovery-report-routes.ts, which also
 * predates any role model).
 */
export async function registerPortalRoutes(routes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(routes);

  routes.get('/api/portal/overview', async (request, reply) => {
    const clientId = request.tenantContext!.clientIds?.[0];
    if (!clientId) return reply.code(401).send({ error: 'unauthorized' });
    const overview = await withTenantTx(request.tenantContext!, (client) => getPortalOverview(client, clientId));
    if (!overview) return reply.code(404).send({ error: 'not_found' });
    return overview;
  });
}
