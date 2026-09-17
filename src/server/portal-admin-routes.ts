import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withTenantTx, type TenantContext } from '../db/tenant-context.js';
import { requireSingleClientId } from '../modules/ingestion/raw-upload-route.js';
import { isUuid } from '../shared/request-validation.js';
import { decodeCursor, paginateKeyset } from '../shared/cursor-pagination.js';
import { parseLimitOffset } from '../shared/parse-limit-offset.js';
import { resolveClientAdminContext, registerClientAdminAuthPreHandler } from '../modules/identity/client-admin-auth.js';
import { resolveClientViewerContext } from '../modules/identity/client-viewer-auth.js';
import { listPortalMembers } from '../modules/identity/list-portal-members.js';
import { updatePortalMemberRole, PORTAL_ROLES, type PortalRole } from '../modules/identity/update-portal-member-role.js';
import { createMembership } from '../modules/identity/create-membership.js';
import { removePortalMember } from '../modules/identity/remove-portal-member.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const ASSIGNABLE_ROLES = new Set<string>(PORTAL_ROLES);

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
 * existing registerClientAdminAuthPreHandler unmodified.
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
      const ctx: TenantContext | null = (await resolveClientAdminContext(request)) ?? (await resolveClientViewerContext(request));
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

  // Write: client_admin only, full-stop -- registerClientAdminAuthPreHandler
  // unmodified, same as every other route that opts into it.
  await app.register(async (adminRoutes) => {
    await registerClientAdminAuthPreHandler(adminRoutes);

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
        updatePortalMemberRole(client, clientId, id, body.role as PortalRole, request.actorUserId),
      );
      if (!result.found) {
        await reply.code(404).send({ error: 'membership not found' });
        return;
      }
      return { id, role: body.role };
    });

    /**
     * 86e3a6rgu (PR #408 review fix): invite -- reuses createMembership
     * (create-membership.ts) unmodified, same as
     * POST /api/internal/tenants/:id/members. That module's own header
     * comment says it "needs app_is_internal()" for a client_id the caller
     * has no membership in yet -- true for that internal route (an analyst
     * assigning a brand-new tenant), but irrelevant here: this client_admin
     * always already holds membership in their OWN clientId
     * (registerClientAdminAuthPreHandler resolved it from an existing
     * membership row), so migration 0009's RLS WITH CHECK admits the insert
     * via its `client_id = ANY(app_current_client_ids())` branch without
     * needing `internal: true`. Role is restricted to PORTAL_ROLES (not the
     * full membership_role set `/api/internal/tenants/:id/members` allows)
     * so a client_admin can never self-assign analyst/lead.
     */
    adminRoutes.post('/api/portal/members', async (request, reply) => {
      const clientId = requireSingleClientId(request.tenantContext!);
      if (!clientId) {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }

      const body = request.body as { email?: unknown; fullName?: unknown; role?: unknown };
      if (typeof body.email !== 'string' || body.email.trim() === '') {
        await reply.code(400).send({ error: 'invalid email: must be a non-empty string' });
        return;
      }
      if (typeof body.role !== 'string' || !ASSIGNABLE_ROLES.has(body.role)) {
        await reply.code(400).send({ error: `invalid role: must be one of ${[...ASSIGNABLE_ROLES].join(', ')}` });
        return;
      }
      if (body.fullName !== undefined && body.fullName !== null && typeof body.fullName !== 'string') {
        await reply.code(400).send({ error: 'invalid fullName: must be a string' });
        return;
      }

      const result = await withTenantTx(request.tenantContext!, (client) =>
        createMembership(client, {
          clientId,
          email: body.email as string,
          fullName: (body.fullName as string | null | undefined) ?? null,
          role: body.role as string,
        }),
      );

      if (!result.created) {
        await reply.code(409).send({ error: 'this user is already a member of this tenant' });
        return;
      }
      await reply.code(201).send({ membershipId: result.membershipId, userId: result.userId, isNewUser: result.isNewUser, role: body.role });
    });

    /**
     * 86e3a6rgu (PR #408 review fix): remove -- uses removePortalMember
     * (remove-portal-member.ts), NOT the generic remove-membership.ts the
     * internal route uses. That generic DELETE has no role filter (an
     * internal analyst is allowed to remove any membership row by design),
     * so reusing it here would let a client_admin delete the internal
     * analyst's own membership row servicing this client -- restricted to
     * PORTAL_ROLES instead, same structural guarantee
     * updatePortalMemberRole's UPDATE already enforces for edits. RLS's own
     * USING clause independently confines it to this client_admin's own
     * client regardless -- no `internal: true` needed.
     */
    adminRoutes.delete('/api/portal/members/:id', async (request, reply) => {
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

      const result = await withTenantTx(request.tenantContext!, (client) => removePortalMember(client, clientId, id));
      if (!result.found) {
        await reply.code(404).send({ error: 'membership not found' });
        return;
      }
      await reply.code(204).send();
    });
  });
}
