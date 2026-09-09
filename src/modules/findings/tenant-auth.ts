import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withTenantTx, type TenantContext } from '../../db/tenant-context.js';
import { getAuth } from '../../auth/better-auth.js';

// 86e2xcna3: augments Fastify's own request type with tenantContext, rather
// than each route file re-declaring `(request as FastifyRequest & {
// tenantContext: TenantContext })` at every read site (findings-routes.ts
// had 5 copies, audit-runs-routes.ts had 2). This is the "one place" the
// item's AC3 asks for -- the unsafe cast now lives only inside
// registerTenantAuthPreHandler below; every other call site reads
// request.tenantContext directly, fully typed.
declare module 'fastify' {
  interface FastifyRequest {
    tenantContext?: TenantContext;
    actorUserId?: string;
    // 86e367qxx: the resolved membership row's role (analyst/lead/
    // client_viewer/client_admin), set alongside actorUserId by the same
    // membership lookup below. Existing routes don't read this -- it exists
    // for analyst-only-mutation guards (see registerAnalystOnlyPreHandler)
    // to check without a second DB round trip.
    actorRole?: string;
  }
}

/**
 * Real session verification (86e2v1bbr) replaces the old dev-tenant-stub's
 * unconditional header trust (86e2u7j2y, stub removed in 86e2v24zj; 86e2v1bbr
 * gated the header path's user id, but that user id itself was still
 * unverified -- any caller could claim any UUID via a header).
 *
 * DEV_AUTH_HEADERS gates which identity source is trusted:
 *   - exactly "1": the x-client-id/x-user-id header pair (today's dev/CI/e2e
 *     behavior, unchanged) -- Greg's explicit hard constraint is that this
 *     path must keep working exactly as before when the flag is set (the
 *     full-stack e2e suite and seeded fixture both depend on it).
 *   - unset (the prod default): a verified better-auth session is the only
 *     accepted identity source. A request bearing only the dev headers and
 *     no valid session is rejected -- the stub must not work by accident in
 *     an environment where the flag wasn't explicitly set.
 *
 * The membership lookup itself must run BEFORE any tenant scope exists for
 * the request -- membership carries FORCE RLS keyed on client_id (migration
 * 0009), so it can only be read via an internal-scoped transaction (which
 * bypasses the client_id check), never via the scope we're still deciding
 * whether to grant.
 */
function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 86e367qxx: returns the membership row's role (not just existence) so
 * callers can set request.actorRole -- widened in place rather than adding a
 * second lookup because it's the exact same SELECT, one extra column, and
 * every existing caller here still only checks truthiness (a role string is
 * as truthy as `1` was) so no existing 401/access behavior changes.
 */
async function lookupMembership(userId: string, clientId: string): Promise<string | null> {
  return withTenantTx({ internal: true }, async (client) => {
    const result = await client.query<{ role: string }>(
      `SELECT role FROM membership WHERE user_id = $1 AND client_id = $2 LIMIT 1`,
      [userId, clientId],
    );
    return result.rows[0]?.role ?? null;
  });
}

/**
 * 86e2wb92b: a real (non-dev-header) session proves WHO the user is, but not
 * WHICH client they're scoped to -- resolveViaSession still requires an
 * explicit x-client-id, and nothing told the frontend what value to send.
 * This is the lookup the new GET /api/auth/memberships route (app.ts) uses
 * to answer that, so login can store a client_id and start sending it.
 * Same internal-scoped-transaction shape as lookupMembership -- membership
 * carries FORCE RLS keyed on client_id, so listing a user's own rows across
 * clients also needs the internal scope, not a tenant scope that doesn't
 * exist yet.
 */
export async function listMembershipClientIds(userId: string): Promise<string[]> {
  return withTenantTx({ internal: true }, async (client) => {
    const result = await client.query(`SELECT client_id FROM membership WHERE user_id = $1`, [userId]);
    return result.rows.map((row: { client_id: string }) => row.client_id);
  });
}

/**
 * 86e2zfjmb: the actor-type half of GET /api/auth/memberships' response --
 * whether the caller is an internal analyst (app_user.is_internal) or, if
 * not, their portal membership role (client_viewer/client_admin). A pure
 * read, alongside listMembershipClientIds above (same internal-scoped-
 * transaction shape, same reason: app_user carries no RLS but membership
 * does, keyed on client_id, migration 0009). Does not touch
 * resolveViaSession/resolveViaDevHeaders or grant any access -- App.tsx uses
 * this only to pick which UI shell to render, never as an authorization
 * decision (every tenant-scoped route still enforces its own boundary via
 * TenantContext/RLS, independent of what this returns).
 *
 * LIMIT 1 on the membership lookup mirrors this codebase's existing
 * single-membership-per-user assumption (see api.ts's fetchAndStoreClientId
 * comment) -- a portal user with more than one membership row gets an
 * arbitrary one of their roles back, not a list.
 */
export async function lookupActorType(userId: string): Promise<{ isInternal: boolean; role: string | null }> {
  return withTenantTx({ internal: true }, async (client) => {
    const userResult = await client.query<{ is_internal: boolean }>(
      `SELECT is_internal FROM app_user WHERE id = $1`,
      [userId],
    );
    if (userResult.rows[0]?.is_internal === true) return { isInternal: true, role: null };

    const membershipResult = await client.query<{ role: string }>(
      `SELECT role FROM membership WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    return { isInternal: false, role: membershipResult.rows[0]?.role ?? null };
  });
}

/** DEV_AUTH_HEADERS path: x-client-id/x-user-id headers, membership-checked. Unchanged behavior. */
async function resolveViaDevHeaders(request: FastifyRequest): Promise<TenantContext | null> {
  const clientId = readHeader(request.headers['x-client-id']);
  const userId = readHeader(request.headers['x-user-id']);
  if (!clientId || !userId) return null;

  const role = await lookupMembership(userId, clientId);
  if (!role) return null;
  request.actorUserId = userId;
  request.actorRole = role;
  return { clientIds: [clientId], internal: false };
}

/**
 * Convert Fastify's headers into the Headers object auth.api.getSession
 * requires. Cookies never legitimately repeat across multiple header
 * instances (a single `cookie` header carries all of a client's cookies,
 * `; `-joined, per RFC 6265) -- `, `-joining an array here would only ever
 * apply to a header better-auth doesn't read from this path, so it's not
 * exercised by any test; documented rather than silently assumed correct.
 */
export function toFetchHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

/**
 * Prod-default path: a verified better-auth session resolves the user id;
 * membership-checked from there.
 *
 * Short-circuits on no `cookie` header before calling getAuth()/getSession()
 * -- mirrors resolveViaDevHeaders' own "check presence before touching the
 * DB" shape (getPool() is called lazily inside getAuth(), so a request with
 * no session-carrying header at all never needs a live DB connection to be
 * correctly rejected). A request that DOES present a cookie but hits a real
 * DB/session error surfaces as whatever error propagates -- the caller
 * (the registered tenant-auth preHandler) does not catch that, so it would 500,
 * which is correct: that's a genuine backend fault, not "this caller is
 * unauthorized," and collapsing the two into the same 401 would hide a
 * production DB outage as silent mass-unauthorization.
 */
async function resolveViaSession(request: FastifyRequest): Promise<TenantContext | null> {
  if (!request.headers.cookie) return null;

  const session = await getAuth().api.getSession({ headers: toFetchHeaders(request) });
  if (!session) return null;

  const clientId = readHeader(request.headers['x-client-id']);
  if (!clientId) return null;

  const role = await lookupMembership(session.user.id, clientId);
  if (!role) return null;
  request.actorUserId = session.user.id;
  request.actorRole = role;
  return { clientIds: [clientId], internal: false };
}

/**
 * Resolve and validate the request's tenant scope. Returns `null` when the
 * request should be rejected (no valid identity, missing/unmatched
 * x-client-id, or no membership row for the resolved user+client pair) --
 * registerTenantAuthPreHandler turns that into a 401. A request that
 * presents no identity at all (no dev headers, no session cookie) is
 * rejected without touching the DB. A request that presents SOME identity
 * but hits a genuine backend fault while resolving it (DB unreachable,
 * session lookup errors) is allowed to throw -- that is a 500, correctly
 * distinct from 401, not something this function silently downgrades to
 * "unauthorized."
 */
export async function resolveAuthorizedTenantContext(
  request: FastifyRequest,
): Promise<TenantContext | null> {
  if (process.env.DEV_AUTH_HEADERS === '1') return resolveViaDevHeaders(request);
  return resolveViaSession(request);
}

/**
 * 86e2xcna3: the shared tenant-auth preHandler, extracted out of
 * findings-routes.ts and audit-runs-routes.ts (both had their own byte-for-
 * byte identical copy -- audit-runs-routes.ts's own header comment already
 * acknowledged this without unifying it). Register on any route instance
 * that needs tenant scoping; behavior is unchanged (401 on no valid
 * context, request.tenantContext set on success).
 *
 * NOT registered at the top level in app.ts -- /health and /api/auth/* must
 * stay reachable with no tenant scope at all (see each call site's own
 * header comment for why), so this is opt-in per route-file plugin, exactly
 * as it was before this extraction.
 */
export async function registerTenantAuthPreHandler(routes: FastifyInstance): Promise<void> {
  routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await resolveAuthorizedTenantContext(request);
    if (!ctx) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    request.tenantContext = ctx;
  });
}

const ANALYST_MEMBERSHIP_ROLES: ReadonlySet<string> = new Set(['analyst', 'lead']);

/**
 * 86e367qxx: analyst/lead vs. client_viewer/client_admin -- registerTenantAuthPreHandler
 * grants a full read+write TenantContext to ANY membership row for the
 * user+client pair regardless of role (it has to: most tenant-scoped routes,
 * e.g. GET /api/disputes/:id, are legitimately readable by a portal user too).
 * A route that must additionally reject the two portal roles nests this
 * preHandler in its own registered sub-scope, AFTER registerTenantAuthPreHandler
 * has already run and set request.actorRole -- see dispute-review-routes.ts's
 * and findings-routes.ts's mutation sub-scopes for the pattern.
 */
export async function registerAnalystOnlyPreHandler(routes: FastifyInstance): Promise<void> {
  routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ANALYST_MEMBERSHIP_ROLES.has(request.actorRole ?? '')) {
      await reply.code(403).send({ error: 'internal analyst role required' });
      return;
    }
  });
}
