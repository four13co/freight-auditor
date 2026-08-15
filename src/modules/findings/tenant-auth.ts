import type { FastifyRequest } from 'fastify';
import { withTenantTx, type TenantContext } from '../../db/tenant-context.js';

/**
 * Tightens resolveDevTenantContext's unconditional trust (86e2u7j2y): still
 * dev-mode (no real session/login), but the claimed x-client-id must now be
 * backed by a membership row for a claimed x-user-id, or the caller gets a
 * flat reject rather than a silently-scoped (or silently-empty) response.
 *
 * x-user-id is a new header, not previously part of the contract -- the
 * item's shape names a "resolved dev user" but predates any mechanism for
 * identifying one at the HTTP layer. This is the smallest faithful reading:
 * a second header alongside the existing x-client-id, dev-only, no real
 * session. Flagged as an explicit assumption in this item's PR.
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
 * Resolve and validate the request's tenant scope. Returns `null` when the
 * request should be rejected (missing header(s), or no membership row for
 * the claimed user+client pair) -- the caller (app.ts's preHandler) turns
 * that into a 401, this function never throws for an unauthorized caller.
 */
export async function resolveAuthorizedTenantContext(
  request: FastifyRequest,
): Promise<TenantContext | null> {
  const clientId = readHeader(request.headers['x-client-id']);
  const userId = readHeader(request.headers['x-user-id']);
  if (!clientId || !userId) return null;

  const hasMembership = await withTenantTx({ internal: true }, async (client) => {
    const result = await client.query(
      `SELECT 1 FROM membership WHERE user_id = $1 AND client_id = $2 LIMIT 1`,
      [userId, clientId],
    );
    return (result.rowCount ?? 0) > 0;
  });

  if (!hasMembership) return null;
  return { clientIds: [clientId], internal: false };
}
