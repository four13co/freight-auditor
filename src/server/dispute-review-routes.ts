import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { isUuid } from '../shared/request-validation.js';
import { getDisputeDetail } from '../modules/disputes/get-dispute-detail.js';
import { approveDispute } from '../modules/disputes/approve-dispute.js';

/**
 * Dispute review + approval API (P4.C.6): an analyst inspects a draft
 * dispute's lines/amounts and approves it for delivery. Own encapsulation
 * so the tenant-auth preHandler binds ONLY to this plugin, following
 * claim-routes.ts's (P5.A.1, merged) precedent exactly.
 */
export async function registerDisputeReviewRoutes(routes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(routes);

  routes.get('/api/disputes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid dispute id: must be a well-formed UUID' });
      return;
    }
    const detail = await withTenantTx(request.tenantContext!, (client) => getDisputeDetail(client, id));
    if (!detail) {
      await reply.code(404).send({ error: 'dispute not found' });
      return;
    }
    return detail;
  });

  routes.post('/api/disputes/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid dispute id: must be a well-formed UUID' });
      return;
    }
    if (!request.actorUserId) {
      await reply.code(401).send({ error: 'authenticated analyst identity required' });
      return;
    }

    const result = await withTenantTx(request.tenantContext!, (client) =>
      approveDispute(client, id, request.actorUserId!));
    if (!result.found) {
      await reply.code(409).send({ error: 'dispute not found or not in a draft state' });
      return;
    }
    return { disputeId: id, status: 'sent' };
  });
}
