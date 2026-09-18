import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAuth } from '../../auth/better-auth.js';
import { readHeader, toFetchHeaders, lookupIsInternal } from '../findings/tenant-auth.js';

/**
 * Own auth resolver for /api/internal/tenants* (86e38rdnm), a genuinely
 * cross-client surface -- creating or listing tenants can't be scoped to an
 * existing account_id the way registerTenantAuthPreHandler requires (the
 * caller has no membership in a tenant that doesn't exist yet). This item's
 * own body named registerTenantAuthPreHandler + registerAnalystOnlyPreHandler,
 * but that pairing structurally can't work here for the same reason
 * internal-analyst-auth.ts's header comment documents for portfolio-routes.ts
 * (PR #247's cross-tenant leak) -- reusing THAT resolver as-is would also be
 * wrong here in the other direction: this item's AC5 requires a portal
 * (client_viewer/client_admin) session to get 403, not the 401
 * internal-analyst-auth.ts's resolver returns for "authenticated but not
 * internal" (it doesn't distinguish that from "no identity at all"). So this
 * is its own small resolver, reusing only the pure header helpers
 * (readHeader/toFetchHeaders) and the shared lookupIsInternal() (86e39qa6r)
 * -- not the resolvers themselves -- distinguishing "no identity" (401) from
 * "identity, but not an internal analyst" (403) so AC5 holds exactly as
 * written.
 */

interface ResolvedTenantAdminIdentity {
  userId: string;
  isInternal: boolean;
}

async function resolveIdentity(request: FastifyRequest): Promise<ResolvedTenantAdminIdentity | null> {
  if (process.env.DEV_AUTH_HEADERS === '1') {
    const userId = readHeader(request.headers['x-user-id']);
    if (!userId) return null;
    return { userId, isInternal: await lookupIsInternal(userId) };
  }

  if (!request.headers.cookie) return null;
  const session = await getAuth().api.getSession({ headers: toFetchHeaders(request) });
  if (!session) return null;
  return { userId: session.user.id, isInternal: await lookupIsInternal(session.user.id) };
}

/**
 * 401 on no identity at all, 403 on a real (portal) identity that isn't an
 * internal analyst -- see this file's header comment for why that split
 * matters here specifically. Grants `{ internal: true }` on success, same
 * shape as internal-analyst-auth.ts's own cross-client context.
 */
export async function registerTenantAdminAuthPreHandler(routes: FastifyInstance): Promise<void> {
  routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveIdentity(request);
    if (!identity) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    if (!identity.isInternal) {
      await reply.code(403).send({ error: 'internal analyst role required' });
      return;
    }
    request.actorUserId = identity.userId;
    request.tenantContext = { internal: true };
  });
}
