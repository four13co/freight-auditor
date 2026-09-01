import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { isUuid } from '../shared/request-validation.js';
import { requestReconciliationExport, getReconciliationExport } from '../modules/claims/reconciliation-export.js';

/**
 * Asynchronous reconciliation export API (P5.C.5): an analyst requests a
 * portfolio reconciliation export (getPortfolioReconciliation, P5.C.4) and
 * polls for its result. Encapsulated so registerTenantAuthPreHandler binds
 * ONLY to this plugin instance, following claim-routes.ts's precedent.
 *
 * POST creates the request row only -- it does NOT compute the export
 * inline or enqueue any job itself; SCAN_RECONCILIATION_EXPORTS_V1 (running
 * in the separate worker process, boss.ts) is what claims and processes it.
 * See 0067's migration comment for why this repo's API server never calls
 * boss.send directly.
 */
export async function registerReconciliationExportRoutes(routes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(routes);

  routes.post('/api/reconciliation-exports', async (request, reply) => {
    if (!request.actorUserId) {
      await reply.code(401).send({ error: 'authenticated analyst identity required' });
      return;
    }
    const clientId = request.tenantContext!.clientIds?.[0];
    if (!clientId) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const body = request.body as { idempotencyKey?: unknown } | undefined;
    if (body?.idempotencyKey !== undefined && typeof body.idempotencyKey !== 'string') {
      await reply.code(400).send({ error: 'invalid idempotencyKey: must be a string' });
      return;
    }
    // A caller with no idempotencyKey of its own (the common case -- a
    // one-off UI "export" click) gets a fresh, always-unique one so it
    // never collides with an unrelated prior request from the same tenant.
    const idempotencyKey = body?.idempotencyKey ?? randomUUID();

    const result = await withTenantTx(request.tenantContext!, (client) =>
      requestReconciliationExport(client, { clientId, idempotencyKey }));

    reply.code(result.created ? 202 : 200);
    return { exportId: result.exportId, status: 'pending' };
  });

  routes.get('/api/reconciliation-exports/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid export id: must be a well-formed UUID' });
      return;
    }
    const clientId = request.tenantContext!.clientIds?.[0];
    if (!clientId) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const exportRow = await withTenantTx(request.tenantContext!, (client) =>
      getReconciliationExport(client, { clientId, exportId: id }));
    if (!exportRow) {
      await reply.code(404).send({ error: 'reconciliation export not found' });
      return;
    }
    return exportRow;
  });
}
