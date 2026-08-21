import type { FastifyRequest } from 'fastify';
import { withTenantTx, type TenantContext } from '../../db/tenant-context.js';
import { getAuth } from '../../auth/better-auth.js';

/**
 * Real session verification (86e2v1bbr) replaces the old dev-tenant-stub's
 * unconditional header trust (86e2u7j2y, stub removed in 86e2v24zj; 86e2v1bbr
 * gated the header path's user id, but that user id itself was still
 * unverified -- any caller could claim any UUID via a header).
 *
 * DEV_AUTH_HEADERS gates which identity source is trusted:
 *   - set: the x-client-id/x-user-id header pair (today's dev/CI/e2e
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

async function lookupMembership(userId: string, clientId: string): Promise<boolean> {
  return withTenantTx({ internal: true }, async (client) => {
    const result = await client.query(
      `SELECT 1 FROM membership WHERE user_id = $1 AND client_id = $2 LIMIT 1`,
      [userId, clientId],
    );
    return (result.rowCount ?? 0) > 0;
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

/** DEV_AUTH_HEADERS path: x-client-id/x-user-id headers, membership-checked. Unchanged behavior. */
async function resolveViaDevHeaders(request: FastifyRequest): Promise<TenantContext | null> {
  const clientId = readHeader(request.headers['x-client-id']);
  const userId = readHeader(request.headers['x-user-id']);
  if (!clientId || !userId) return null;

  const hasMembership = await lookupMembership(userId, clientId);
  if (!hasMembership) return null;
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
 * (app.ts's preHandler) does not currently catch that, so it would 500,
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

  const hasMembership = await lookupMembership(session.user.id, clientId);
  if (!hasMembership) return null;
  return { clientIds: [clientId], internal: false };
}

/**
 * Resolve and validate the request's tenant scope. Returns `null` when the
 * request should be rejected (no valid identity, missing/unmatched
 * x-client-id, or no membership row for the resolved user+client pair) --
 * the caller (app.ts's preHandler) turns that into a 401. A request that
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
  if (process.env.DEV_AUTH_HEADERS) return resolveViaDevHeaders(request);
  return resolveViaSession(request);
}
