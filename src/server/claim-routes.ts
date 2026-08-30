import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { isUuid } from '../shared/request-validation.js';
import { createClaimFromDispute, DisputeNotFoundError } from '../modules/claims/create-claim-from-dispute.js';
import { ClaimableDisputeError } from '../modules/claims/validate-claimable-dispute.js';

/**
 * Claim-creation API (P5.A.1): an analyst opens a claim against an accepted
 * dispute. Encapsulated so registerTenantAuthPreHandler binds ONLY to this
 * plugin instance -- registering it at the app level would also gate /health
 * (findings-routes.ts's own precedent/warning).
 */
export async function registerClaimRoutes(claimRoutes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(claimRoutes);

  claimRoutes.post('/api/disputes/:id/claim', async (request, reply) => {
    const { id } = request.params as { id: string };

    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid dispute id: must be a well-formed UUID' });
      return;
    }
    if (!request.actorUserId) {
      await reply.code(401).send({ error: 'authenticated analyst identity required' });
      return;
    }
    const clientId = request.tenantContext!.clientIds?.[0];
    if (!clientId) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    try {
      const result = await withTenantTx(request.tenantContext!, (client) =>
        createClaimFromDispute(client, {
          clientId,
          disputeId: id,
          actorUserId: request.actorUserId!,
        }),
      );
      reply.code(result.created ? 201 : 200);
      return {
        claimId: result.claimId,
        disputeId: result.disputeId,
        amountClaimed: result.amountClaimed,
        currency: result.currency,
      };
    } catch (error) {
      if (error instanceof DisputeNotFoundError) {
        await reply.code(404).send({ error: 'dispute not found' });
        return;
      }
      if (error instanceof ClaimableDisputeError) {
        await reply.code(409).send({ error: error.message });
        return;
      }
      throw error;
    }
  });
}
