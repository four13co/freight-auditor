import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TenantContext } from '../../db/tenant-context.js';
import { getAuth } from '../../auth/better-auth.js';
import { readHeader, toFetchHeaders, lookupIsInternal } from './tenant-auth.js';

/**
 * Isolated auth resolver for internal-analyst-only routes (P5.C.3, rebuild).
 *
 * Deliberately does NOT reuse resolveViaDevHeaders / resolveViaSession /
 * registerTenantAuthPreHandler from tenant-auth.ts. That module's shared
 * preHandler is bound by EVERY other tenant-scoped route file, all of which
 * assume the resolved TenantContext always carries exactly one clientId --
 * e.g. dispute-review-routes.ts's getDisputeDetail(client, id) has no
 * clientId param at all and relies on that invariant via RLS alone. The
 * first attempt at this item (PR #247, closed on review) extended the
 * shared resolver to grant { internal: true } to any is_internal caller who
 * omitted x-client-id, which broke that invariant platform-wide and opened
 * cross-tenant read/write leaks on several existing routes this item never
 * touched (rubric-conflicts, rule-proposals, rule-proposal-previews,
 * disputes/:id [+approve], payment-authorizations/pending, rule-proposal
 * accept/ratify).
 *
 * This resolver only grants { internal: true } (no clientIds at all) on
 * whichever route(s) opt into THIS preHandler -- currently just
 * portfolio-routes.ts's GET /api/portfolio/cross-account-recovery. No
 * existing route's auth behavior changes. `toFetchHeaders`, `readHeader`,
 * and `lookupIsInternal` (86e39qa6r) are imported (not duplicated) from
 * tenant-auth.ts -- all three are pure lookups/header-format helpers with
 * no auth *decision* in them, so reusing them carries none of the risk that
 * reusing the resolvers themselves would.
 */

/** DEV_AUTH_HEADERS path: x-user-id only -- no x-client-id, this scope is cross-client by design. */
async function resolveViaDevHeader(request: FastifyRequest): Promise<TenantContext | null> {
  const userId = readHeader(request.headers['x-user-id']);
  if (!userId) return null;
  if (!(await lookupIsInternal(userId))) return null;
  request.actorUserId = userId;
  return { internal: true };
}

/** Prod-default path: a verified better-auth session, checked against app_user.is_internal. */
async function resolveViaSession(request: FastifyRequest): Promise<TenantContext | null> {
  if (!request.headers.cookie) return null;

  const session = await getAuth().api.getSession({ headers: toFetchHeaders(request) });
  if (!session) return null;

  if (!(await lookupIsInternal(session.user.id))) return null;
  request.actorUserId = session.user.id;
  return { internal: true };
}

export async function resolveInternalAnalystContext(
  request: FastifyRequest,
): Promise<TenantContext | null> {
  if (process.env.DEV_AUTH_HEADERS === '1') return resolveViaDevHeader(request);
  return resolveViaSession(request);
}

/**
 * Own preHandler, registered ONLY on portfolio-routes.ts. 401 on no
 * authorized internal-analyst context, matching registerTenantAuthPreHandler's
 * existing convention for "no valid context" (tenant-auth.ts).
 */
export async function registerInternalAnalystAuthPreHandler(routes: FastifyInstance): Promise<void> {
  routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await resolveInternalAnalystContext(request);
    if (!ctx) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    request.tenantContext = ctx;
  });
}
