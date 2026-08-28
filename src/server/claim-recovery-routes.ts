import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { isUuid } from '../shared/request-validation.js';
import { listClaims } from '../modules/claims/list-claims.js';
import { getClaimDetail } from '../modules/claims/get-claim-detail.js';

const MAX_LIMIT = 200;

/**
 * Claim and recovery read APIs (P5.B.4): list + detail, following
 * findings-routes.ts's/payment-routes.ts's own tenant-auth-preHandler
 * encapsulation pattern so it binds ONLY to these routes, never gating
 * /health.
 */
export async function registerClaimRecoveryRoutes(claimRoutes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(claimRoutes);

  claimRoutes.get('/api/claims', async (request, reply) => {
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

    const claims = await withTenantTx(request.tenantContext!, (client) =>
      listClaims(client, { status: query.status, limit, offset }),
    );
    return { claims };
  });

  claimRoutes.get('/api/claims/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid claim id: must be a well-formed UUID' });
      return;
    }

    const detail = await withTenantTx(request.tenantContext!, (client) => getClaimDetail(client, id));
    if (!detail) {
      await reply.code(404).send({ error: 'claim not found' });
      return;
    }
    return detail;
  });
}
