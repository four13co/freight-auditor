import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withTenantTx, type TenantContext } from '../../db/tenant-context.js';
import { getAuth } from '../../auth/better-auth.js';
import { toFetchHeaders } from './tenant-auth.js';

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
 * portfolio-routes.ts's GET /api/portfolio/cross-client-recovery. No
 * existing route's auth behavior changes. `toFetchHeaders` is imported
 * (not duplicated) from tenant-auth.ts -- it is a pure header-format
 * conversion with no auth decision in it, so reusing it carries none of the
 * risk that reusing the resolvers themselves would.
 */

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * app_user carries no RLS (it is not in migration 0009's tenant-table list --
 * it is the identity table itself, not tenant-scoped data), but the lookup
 * still runs inside an internal-scoped transaction for consistency with
 * every other identity lookup in this codebase (lookupMembership in
 * tenant-auth.ts) and so a future RLS policy added to app_user wouldn't
 * silently break this path.
 */
async function lookupIsInternal(userId: string): Promise<boolean> {
  return withTenantTx({ internal: true }, async (client) => {
    const result = await client.query<{ is_internal: boolean }>(
      `SELECT is_internal FROM app_user WHERE id = $1 AND is_active = true`,
      [userId],
    );
    return result.rows[0]?.is_internal === true;
  });
}

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
