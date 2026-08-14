import type { FastifyRequest } from 'fastify';
import type { TenantContext } from '../../db/tenant-context.js';

/**
 * DEV-ONLY tenant resolution stub (86e2u7j0d rabbit hole): no auth/session
 * layer exists yet. Resolves the tenant scope from an `x-client-id` header
 * with NO verification -- any caller can claim any client_id. This is a
 * documented, tracked stopgap (86e2kp4d3 / 86e2u7j2y is the real-auth
 * follow-up), not a silently-permanent shortcut.
 *
 * Every endpoint that needs a tenant scope before real auth lands (findings
 * list, KPI summary) MUST reuse this one function -- do not fork a second stub.
 */
export function resolveDevTenantContext(request: FastifyRequest): TenantContext {
  const header = request.headers['x-client-id'];
  const clientId = Array.isArray(header) ? header[0] : header;
  if (!clientId) return { clientIds: [], internal: false };
  return { clientIds: [clientId], internal: false };
}
