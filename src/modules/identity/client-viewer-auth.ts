import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withTenantTx, type TenantContext } from '../../db/tenant-context.js';
import { getAuth } from '../../auth/better-auth.js';
import { toFetchHeaders } from '../findings/tenant-auth.js';

// 86e2zfjmw: augments Fastify's own request type with clientPortalReadOnly,
// separate from tenantContext/actorUserId (already declared by
// tenant-auth.ts) -- a route can read this flag to confirm why a write was
// blocked without needing to know this resolver's internals.
declare module 'fastify' {
  interface FastifyRequest {
    clientPortalReadOnly?: boolean;
  }
}

/**
 * Isolated auth resolver for the client portal's client_viewer surface
 * (P6.A.2). Deliberately does NOT reuse resolveViaDevHeaders /
 * resolveViaSession / registerTenantAuthPreHandler from tenant-auth.ts, nor
 * internal-analyst-auth.ts's resolver -- same reasoning as
 * internal-analyst-auth.ts's own header comment: the shared resolver's PR
 * #247 rebuild is bound by every existing tenant-scoped route, all assuming
 * today's behavior (any membership row, any role, grants full read+write
 * access to that one client). Widening it in place to add role checks would
 * risk narrowing existing analyst/lead access by accident. This resolver
 * only grants access on whichever route(s) opt into THIS preHandler --
 * currently none (P6.A.4, 86e2zfjp9, builds the portal API routes that will
 * use it); no existing route's auth behavior changes.
 *
 * Scope is deliberately narrow to this task's own boundary: only the
 * `client_viewer` membership role is granted a context here. `client_admin`
 * is a sibling capability (P6.A.3, 86e2zfjnd) and is explicitly excluded --
 * a client_admin caller hitting this preHandler is rejected exactly like
 * any other non-client_viewer caller, so the two roles' authorization
 * primitives ship and are reviewable independently.
 *
 * Read-only is enforced STRUCTURALLY, not left to each route handler to
 * remember: registerClientViewerAuthPreHandler rejects any request whose
 * method isn't GET/HEAD with 403 before the route handler ever runs, and
 * sets request.clientPortalReadOnly = true on every request it lets
 * through, so any future write escape route in this surface is easy to
 * audit for.
 */

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * membership carries FORCE RLS keyed on client_id (migration 0009), so the
 * role lookup must run inside an internal-scoped transaction -- same shape
 * as tenant-auth.ts's own lookupMembership, which this deliberately does
 * not import (see module header): that function only proves a membership
 * row exists, it never returns the role, and widening its return type would
 * touch the shared module every other tenant-scoped route depends on.
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

/** DEV_AUTH_HEADERS path: x-client-id/x-user-id headers, role-checked against client_viewer. */
async function resolveViaDevHeaders(request: FastifyRequest): Promise<TenantContext | null> {
  const clientId = readHeader(request.headers['x-client-id']);
  const userId = readHeader(request.headers['x-user-id']);
  if (!clientId || !userId) return null;

  const role = await lookupMembershipRole(userId, clientId);
  if (role !== 'client_viewer') return null;
  request.actorUserId = userId;
  return { clientIds: [clientId], internal: false };
}

/** Prod-default path: a verified better-auth session, membership role checked against client_viewer. */
async function resolveViaSession(request: FastifyRequest): Promise<TenantContext | null> {
  if (!request.headers.cookie) return null;

  const session = await getAuth().api.getSession({ headers: toFetchHeaders(request) });
  if (!session) return null;

  const clientId = readHeader(request.headers['x-client-id']);
  if (!clientId) return null;

  const role = await lookupMembershipRole(session.user.id, clientId);
  if (role !== 'client_viewer') return null;
  request.actorUserId = session.user.id;
  return { clientIds: [clientId], internal: false };
}

export async function resolveClientViewerContext(request: FastifyRequest): Promise<TenantContext | null> {
  if (process.env.DEV_AUTH_HEADERS === '1') return resolveViaDevHeaders(request);
  return resolveViaSession(request);
}

/**
 * Own preHandler, for routes that opt into the client_viewer portal surface.
 * 401 on no valid client_viewer context (no identity, no membership, or a
 * membership row whose role isn't client_viewer -- including client_admin,
 * which is out of scope here per this task's own Exclusions). 403 on any
 * non-safe HTTP method, structurally enforcing read-only before the route
 * handler ever runs -- a route registered under this preHandler cannot
 * accidentally accept a write just because a future author forgot to check
 * the role themselves.
 */
export async function registerClientViewerAuthPreHandler(routes: FastifyInstance): Promise<void> {
  routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await resolveClientViewerContext(request);
    if (!ctx) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    if (!SAFE_METHODS.has(request.method)) {
      await reply.code(403).send({ error: 'client_viewer is read-only' });
      return;
    }
    request.tenantContext = ctx;
    request.clientPortalReadOnly = true;
  });
}
