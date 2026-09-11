import type { FastifyInstance } from 'fastify';
import { withTenantReadTx } from '../db/tenant-context.js';
import { registerInternalAnalystAuthPreHandler } from '../modules/findings/internal-analyst-auth.js';
import { listInternalAuditEvents } from '../modules/audit-ledger/list-internal-audit-events.js';

const MAX_LIMIT = 200;
// Same allowlist portal-content-routes.ts's own /api/portal/audit-log route enforces,
// mirroring write-audit-event.ts's AuditEventInputSchema constraint on entity/event.
const AUDIT_ENTITY_OR_EVENT = /^[a-z][a-z0-9_.-]*$/;

/**
 * Internal-analyst-facing audit log (86e37r2rv) -- the same audit-ledger
 * data the client portal's own /api/portal/audit-log already reads, gated
 * differently: registerInternalAnalystAuthPreHandler (the same helper
 * portfolio-routes.ts and rule-governance-routes.ts already use), own
 * encapsulation, NOT the portal's client-scoped preHandlers. Read-only, so
 * routed through withTenantReadTx, same as portfolio-routes.ts.
 */
export async function registerAuditLogRoutes(routes: FastifyInstance): Promise<void> {
  await registerInternalAnalystAuthPreHandler(routes);

  routes.get('/api/internal/audit-log', async (request, reply) => {
    const query = request.query as {
      entity?: string;
      event?: string;
      from?: string;
      to?: string;
      limit?: string;
      offset?: string;
    };

    if (query.entity !== undefined && !AUDIT_ENTITY_OR_EVENT.test(query.entity)) {
      await reply.code(400).send({ error: 'invalid entity: must match ^[a-z][a-z0-9_.-]*$' });
      return;
    }
    if (query.event !== undefined && !AUDIT_ENTITY_OR_EVENT.test(query.event)) {
      await reply.code(400).send({ error: 'invalid event: must match ^[a-z][a-z0-9_.-]*$' });
      return;
    }

    let from: Date | undefined;
    if (query.from !== undefined) {
      from = new Date(query.from);
      if (Number.isNaN(from.getTime())) {
        await reply.code(400).send({ error: 'invalid from: must be a parseable date' });
        return;
      }
    }

    let to: Date | undefined;
    if (query.to !== undefined) {
      to = new Date(query.to);
      if (Number.isNaN(to.getTime())) {
        await reply.code(400).send({ error: 'invalid to: must be a parseable date' });
        return;
      }
    }

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

    const events = await withTenantReadTx(request.tenantContext!, (client) =>
      listInternalAuditEvents(client, { entity: query.entity, event: query.event, from, to, limit, offset }),
    );
    return { events };
  });
}
