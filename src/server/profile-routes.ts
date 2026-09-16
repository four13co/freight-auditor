import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { updateUserProfile } from '../modules/identity/update-user-profile.js';
import { isValidHttpUrl } from '../shared/request-validation.js';

const BLOCKED_FIELDS = ['role', 'clientId', 'client_id', 'tenantId', 'tenant_id', 'isInternal', 'is_internal', 'email'];

/**
 * 86e38pz8e: PATCH /api/profile -- "any authenticated user may edit only
 * their own row" (the item's own Solution). Gated with the shared
 * registerTenantAuthPreHandler (same as most tenant-scoped mutations in
 * this codebase) rather than an analyst-only preHandler -- a portal
 * client_viewer/client_admin editing their OWN display name/avatar is
 * exactly the intended caller, not a privilege to restrict. The route is
 * allow-listed in check-analyst-only-gating.mjs for this reason: it's
 * deliberately any-role-writable, but scoped to the caller's own row, never
 * another tenant's or another user's.
 *
 * request.actorUserId (set by registerTenantAuthPreHandler from the
 * verified session) is the ONLY source of which row gets updated -- the
 * request body is never read for an id, so there is no way for a caller to
 * target another user's row even if they tried.
 *
 * AC6: role/tenant/email fields are rejected outright (400) if present in
 * the body, rather than silently ignored -- an explicit statement that this
 * route will never become a privilege-escalation vector, checked before
 * name/image are even validated.
 */
export async function registerProfileRoutes(routes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(routes);

  routes.patch('/api/profile', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    const blocked = BLOCKED_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(body, field));
    if (blocked) {
      await reply.code(400).send({ error: `cannot edit '${blocked}': role and tenant info are not editable via this route` });
      return;
    }

    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length === 0)) {
      await reply.code(400).send({ error: 'invalid name: must be a non-empty string' });
      return;
    }
    if (body.image !== undefined && body.image !== null && (typeof body.image !== 'string' || !isValidHttpUrl(body.image))) {
      await reply.code(400).send({ error: 'invalid image: must be a valid http(s) URL, or null to clear it' });
      return;
    }
    if (body.name === undefined && body.image === undefined) {
      await reply.code(400).send({ error: 'nothing to update: provide name and/or image' });
      return;
    }

    const userId = request.actorUserId!;
    const updated = await withTenantTx(request.tenantContext!, (client) =>
      updateUserProfile(client, userId, {
        name: typeof body.name === 'string' ? body.name.trim() : undefined,
        image: body.image === null ? null : typeof body.image === 'string' ? body.image : undefined,
      }),
    );

    if (!updated) {
      await reply.code(404).send({ error: 'user not found' });
      return;
    }
    return { name: updated.name, email: updated.email, image: updated.image };
  });
}
