import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withTenantTx, type TenantContext } from '../../db/tenant-context.js';
import { getAuth } from '../../auth/better-auth.js';
import { toFetchHeaders } from '../findings/tenant-auth.js';

// 86e2zfjnd: augments Fastify's own request type with actorUserId only --
// tenantContext is already declared by tenant-auth.ts's own declare-module
// block, and this resolver returns the same TenantContext shape, so no new
// field is needed on the request beyond what client-viewer-auth.ts already
// established for actorUserId.

/**
 * Isolated auth resolver for the client portal's client_admin surface
 * (P6.A.3). Deliberately does NOT reuse resolveViaDevHeaders /
 * resolveViaSession / registerTenantAuthPreHandler from tenant-auth.ts, nor
 * internal-analyst-auth.ts's or client-viewer-auth.ts's resolvers -- same
 * reasoning as those modules' own header comments: the shared resolver in
 * tenant-auth.ts is bound by every existing tenant-scoped route, all
 * assuming today's behavior (any membership row, any role, grants full
 * read+write access to that one client). Widening it in place to add role
 * checks would risk narrowing existing analyst/lead access by accident.
 * This resolver only grants access on whichever route(s) opt into THIS
 * preHandler -- currently none (P6.A.4, 86e2zfjp9, builds the portal API
 * routes that will use it); no existing route's auth behavior changes.
 *
 * Scope is deliberately narrow to this task's own boundary: only the
 * `client_admin` membership role is granted a context here. `client_viewer`
 * (86e2zfjmw, P6.A.2) is a sibling capability and is explicitly excluded --
 * a client_viewer caller hitting this preHandler is rejected exactly like
 * any other non-client_admin caller, so the two roles' authorization
 * primitives ship and are reviewable independently.
 *
 * Unlike client-viewer-auth.ts, this preHandler does NOT restrict HTTP
 * methods -- "admin" carries full read+write within the caller's own
 * client scope (RLS on every tenant table still confines that scope to
 * exactly clientIds: [clientId]). Policy-controlled approval workflows on
 * top of that raw write capability are a sibling capability (P6.B.5,
 * "Add policy-controlled client-admin approvals") and out of scope here.
 */

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * membership carries FORCE RLS keyed on client_id (migration 0009), so the
 * role lookup must run inside an internal-scoped transaction -- same shape
 * as tenant-auth.ts's own lookupMembership and client-viewer-auth.ts's own
 * lookupMembershipRole, neither of which this module reuses (see module
 * header): tenant-auth.ts's version never returns the role, and importing
 * client-viewer-auth.ts's would couple two independently-reviewable
 * sibling modules together.
 */
async function lookupMembershipRole(userId: string, clientId: string): Promise<string | null> {
  return withTenantTx({ internal: true }, async (client) => {
    const result = await client.query<{ role: string }>(
      `SELECT role FROM membership WHERE user_id = $1 AND client_id = $2 LIMIT 1`,
      [userId, clientId],
    );
    return result.rows[0]?.role ?? null;
  });
}

/** DEV_AUTH_HEADERS path: x-client-id/x-user-id headers, role-checked against client_admin. */
async function resolveViaDevHeaders(request: FastifyRequest): Promise<TenantContext | null> {
  const clientId = readHeader(request.headers['x-client-id']);
  const userId = readHeader(request.headers['x-user-id']);
  if (!clientId || !userId) return null;

  const role = await lookupMembershipRole(userId, clientId);
  if (role !== 'client_admin') return null;
  request.actorUserId = userId;
  return { clientIds: [clientId], internal: false };
}

/** Prod-default path: a verified better-auth session, membership role checked against client_admin. */
async function resolveViaSession(request: FastifyRequest): Promise<TenantContext | null> {
  if (!request.headers.cookie) return null;

  const session = await getAuth().api.getSession({ headers: toFetchHeaders(request) });
  if (!session) return null;

  const clientId = readHeader(request.headers['x-client-id']);
  if (!clientId) return null;

  const role = await lookupMembershipRole(session.user.id, clientId);
  if (role !== 'client_admin') return null;
  request.actorUserId = session.user.id;
  return { clientIds: [clientId], internal: false };
}

export async function resolveClientAdminContext(request: FastifyRequest): Promise<TenantContext | null> {
  if (process.env.DEV_AUTH_HEADERS === '1') return resolveViaDevHeaders(request);
  return resolveViaSession(request);
}

/**
 * Own preHandler, for routes that opt into the client_admin portal surface.
 * 401 on no valid client_admin context (no identity, no membership, or a
 * membership row whose role isn't client_admin -- including client_viewer,
 * which is out of scope here per this task's own Exclusions). No 403/
 * method restriction -- see the module header for why client_admin is
 * granted full read+write within its own client scope.
 */
export async function registerClientAdminAuthPreHandler(routes: FastifyInstance): Promise<void> {
  routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await resolveClientAdminContext(request);
    if (!ctx) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    request.tenantContext = ctx;
  });
}
