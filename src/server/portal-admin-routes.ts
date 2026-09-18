import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withTenantTx, type TenantContext } from '../db/tenant-context.js';
import { requireSingleClientId } from '../modules/ingestion/raw-upload-route.js';
import { isUuid } from '../shared/request-validation.js';
import { decodeCursor, paginateKeyset } from '../shared/cursor-pagination.js';
import { parseLimitOffset } from '../shared/parse-limit-offset.js';
import { resolveAccountAdminContext, registerAccountAdminAuthPreHandler } from '../modules/identity/account-admin-auth.js';
import { resolveAccountViewerContext } from '../modules/identity/account-viewer-auth.js';
import { listPortalMembers } from '../modules/identity/list-portal-members.js';
import { updatePortalMemberRole, type PortalRole } from '../modules/identity/update-portal-member-role.js';
import { roleWireToDb } from '../modules/identity/role-wire-mapping.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
// Wire-facing values (frozen by AC5/the No-go on touching web/) -- NOT the
// same set as update-portal-member-role.ts's PORTAL_ROLES, which is the DB
// enum's current labels. Translated via roleWireToDb() before it reaches
// the DB-facing call below.
const ASSIGNABLE_ROLES = new Set<string>(['client_viewer', 'client_admin']);

/**
 * Portal-specific tenant-scoped APIs (P6.A.4) -- the first routes to use
 * client-admin-auth.ts's/client-viewer-auth.ts's preHandlers, which both
 * shipped (P6.A.2/P6.A.3) with zero consumers by design (see each module's
 * own header comment naming this task as the one that would build them).
 *
 * Two separately-encapsulated route groups, each with its OWN preHandler,
 * nested under this one exported registration -- Fastify route paths are
 * global even across sibling `app.register()` calls, so a single GET path
 * usable by either role needs a composite preHandler in one group, while
 * the admin-only write lives in a completely separate group using the
 * existing registerAccountAdminAuthPreHandler unmodified.
 *
 * Distinct from portal-content-routes.ts (P6.B.1, PR #256 as of this
 * writing): that module builds read-only client_viewer content views
 * (invoices, scorecards) under P6.B ("Client portal experiences"); this one
 * builds the tenant-access management surface under P6.A ("Portal identity
 * and tenant access") -- a client_admin's own roster of who has portal
 * access to their client, and the ability to change a portal member's role.
 * No file overlap with #256's own PR by design.
 */
export async function registerPortalAdminRoutes(app: FastifyInstance): Promise<void> {
  // Read: available to EITHER portal role -- an admin needs to see the
  // roster to know who to act on, a viewer needs it to see who else has
  // access. Composite preHandler tries client_admin first, then
  // client_viewer; a caller with neither role gets 401 from either resolver
  // failing, exactly as client-viewer-auth.ts's/client-admin-auth.ts's own
  // preHandlers already behave individually.
  await app.register(async (readRoutes) => {
    readRoutes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx: TenantContext | null = (await resolveAccountAdminContext(request)) ?? (await resolveAccountViewerContext(request));
      if (!ctx) {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }
      request.tenantContext = ctx;
    });

    readRoutes.get('/api/portal/members', async (request, reply) => {
      const clientId = requireSingleClientId(request.tenantContext!);
      if (!clientId) {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }

      const query = request.query as { limit?: string; offset?: string; cursor?: string };

      const parsedLimitOffset = parseLimitOffset(query, { maxLimit: MAX_LIMIT });
      if (!parsedLimitOffset.ok) {
        await reply.code(400).send({ error: parsedLimitOffset.error });
        return;
      }
      const { limit, offset } = parsedLimitOffset.value;

      if (query.cursor !== undefined && query.offset !== undefined) {
        await reply.code(400).send({ error: 'cannot combine cursor with offset' });
        return;
      }

      let cursor: { id: string } | undefined;
      if (query.cursor !== undefined) {
        const decoded = decodeCursor(query.cursor);
        if (!decoded) {
          await reply.code(400).send({ error: 'invalid cursor' });
          return;
        }
        cursor = { id: decoded.id };
      }

      const effectiveLimit = limit ?? DEFAULT_LIMIT;
      const rows = await withTenantTx(request.tenantContext!, (client) =>
        listPortalMembers(client, clientId, { limit: effectiveLimit + 1, offset: cursor ? undefined : offset, cursor }),
      );
      const { page, nextCursor } = paginateKeyset(rows, effectiveLimit, (r) => ({ v: r.createdAt.toISOString(), id: r.id }));
      return { members: page, nextCursor };
    });
  });

  // Write: client_admin only, full-stop -- registerAccountAdminAuthPreHandler
  // unmodified, same as every other route that opts into it.
  await app.register(async (adminRoutes) => {
    await registerAccountAdminAuthPreHandler(adminRoutes);

    adminRoutes.patch('/api/portal/members/:id/role', async (request, reply) => {
      const clientId = requireSingleClientId(request.tenantContext!);
      if (!clientId) {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }

      const { id } = request.params as { id: string };
      if (!isUuid(id)) {
        await reply.code(400).send({ error: 'invalid membership id: must be a well-formed UUID' });
        return;
      }

      const body = request.body as { role?: unknown };
      if (typeof body.role !== 'string' || !ASSIGNABLE_ROLES.has(body.role)) {
        await reply.code(400).send({ error: `invalid role: must be one of ${[...ASSIGNABLE_ROLES].join(', ')}` });
        return;
      }

      const result = await withTenantTx(request.tenantContext!, (client) =>
        updatePortalMemberRole(client, clientId, id, roleWireToDb(body.role as string) as PortalRole, request.actorUserId),
      );
      if (!result.found) {
        await reply.code(404).send({ error: 'membership not found' });
        return;
      }
      return { id, role: body.role };
    });
  });
}
