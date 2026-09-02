import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { requireSingleClientId } from '../modules/ingestion/raw-upload-route.js';
import { isUuid } from '../shared/request-validation.js';
import { decodeCursor, paginateKeyset } from '../shared/cursor-pagination.js';
import { listClaims } from '../modules/claims/list-claims.js';
import { getClaimDetail } from '../modules/claims/get-claim-detail.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Claim and recovery read APIs (P5.B.4): list + detail, following
 * findings-routes.ts's/payment-routes.ts's own tenant-auth-preHandler
 * encapsulation pattern so it binds ONLY to these routes, never gating
 * /health. `clientId` is resolved once per request via
 * requireSingleClientId (86e31a9ch/#216 precedent) and threaded through to
 * both query modules as an explicit predicate alongside RLS.
 */
export async function registerClaimRecoveryRoutes(claimRoutes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(claimRoutes);

  claimRoutes.get('/api/claims', async (request, reply) => {
    const clientId = requireSingleClientId(request.tenantContext!);
    if (!clientId) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const query = request.query as { status?: string; limit?: string; offset?: string; cursor?: string };

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

    // P6.C.1: cursor and offset address the same "where in the list" concept
    // two different ways -- combining them is ambiguous, not additive.
    if (query.cursor !== undefined && query.offset !== undefined) {
      await reply.code(400).send({ error: 'cannot combine cursor with offset' });
      return;
    }

    let cursor: { id: string } | undefined;
    if (query.cursor !== undefined) {
      const decoded = decodeCursor(query.cursor);
      if (!decoded) {
        await reply.code(400).send({ error: 'invalid cursor' });
        return;
      }
      cursor = { id: decoded.id };
    }

    const effectiveLimit = limit ?? DEFAULT_LIMIT;
    const rows = await withTenantTx(request.tenantContext!, (client) =>
      listClaims(client, clientId, { status: query.status, limit: effectiveLimit + 1, offset: cursor ? undefined : offset, cursor }),
    );
    const { page, nextCursor } = paginateKeyset(rows, effectiveLimit, (r) => ({ v: r.openedAt.toISOString(), id: r.id }));
    return { claims: page, nextCursor };
  });

  claimRoutes.get('/api/claims/:id', async (request, reply) => {
    const clientId = requireSingleClientId(request.tenantContext!);
    if (!clientId) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid claim id: must be a well-formed UUID' });
      return;
    }

    const detail = await withTenantTx(request.tenantContext!, (client) => getClaimDetail(client, clientId, id));
    if (!detail) {
      await reply.code(404).send({ error: 'claim not found' });
      return;
    }
    return detail;
  });
}
