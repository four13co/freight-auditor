import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAdminAuthPreHandler } from '../modules/identity/tenant-admin-auth.js';
import { createClient as createClientRow } from '../modules/identity/onboarding.js';
import { listClients } from '../modules/identity/list-clients.js';
import { getClientDetail } from '../modules/identity/get-client-detail.js';
import { updateClient } from '../modules/identity/update-client.js';
import { createCustomerBranding } from '../modules/identity/create-customer-branding.js';
import { updateCustomerBranding } from '../modules/identity/update-customer-branding.js';
import { createMembership } from '../modules/identity/create-membership.js';
import { listTenantMembers } from '../modules/identity/list-tenant-members.js';
import { removeMembership } from '../modules/identity/remove-membership.js';
import { isUuid } from '../shared/request-validation.js';
import { decodeCursor, paginateKeyset } from '../shared/cursor-pagination.js';

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MEMBERSHIP_ROLES = new Set(['analyst', 'lead', 'client_viewer', 'client_admin']);
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Tenant lifecycle management for internal analysts (86e38rdnm): create a
 * tenant, configure its branding, and assign portal/analyst membership --
 * the admin surface the Problem statement says doesn't exist today (manual
 * DB inserts are the only path). Own encapsulation, own preHandler
 * (registerTenantAdminAuthPreHandler, tenant-admin-auth.ts) -- see that
 * module's header comment for why this can't reuse
 * registerTenantAuthPreHandler + registerAnalystOnlyPreHandler as the
 * item's own body originally named.
 */
export async function registerTenantAdminRoutes(routes: FastifyInstance): Promise<void> {
  // Nested in its own registered sub-scope (rather than applying
  // registerTenantAdminAuthPreHandler directly on `routes`) so
  // scripts/check-analyst-only-gating.mjs's static scan -- which only
  // recognizes a role gate via a `<scope>.register(async (<var>) => {...})`
  // block calling a role-scoped preHandler on `<var>` -- can see every
  // mutating route here is gated, matching internal-branding-routes.ts's
  // own convention.
  await routes.register(async (adminRoutes) => {
    await registerTenantAdminAuthPreHandler(adminRoutes);

    adminRoutes.post('/api/internal/tenants', async (request, reply) => {
      const body = request.body as { name?: unknown; slug?: unknown };
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        await reply.code(400).send({ error: 'invalid name: must be a non-empty string' });
        return;
      }
      if (typeof body.slug !== 'string' || body.slug.trim() === '') {
        await reply.code(400).send({ error: 'invalid slug: must be a non-empty string' });
        return;
      }

      try {
        const created = await withTenantTx(request.tenantContext!, (client) =>
          createClientRow(client, { name: body.name as string, slug: body.slug as string }),
        );
        await reply.code(201).send({ id: created.id, name: body.name, slug: body.slug, isActive: true });
      } catch (err) {
        if (isUniqueViolation(err)) {
          await reply.code(409).send({ error: 'a tenant with this slug already exists' });
          return;
        }
        throw err;
      }
    });

    adminRoutes.get('/api/internal/tenants', async (request, reply) => {
      const query = request.query as { limit?: string; offset?: string; cursor?: string };

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
        listClients(client, { limit: effectiveLimit + 1, offset: cursor ? undefined : offset, cursor }),
      );
      const { page, nextCursor } = paginateKeyset(rows, effectiveLimit, (r) => ({ v: r.createdAt.toISOString(), id: r.id }));
      return { tenants: page, nextCursor };
    });

    adminRoutes.get('/api/internal/tenants/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) {
        await reply.code(400).send({ error: 'invalid tenant id: must be a well-formed UUID' });
        return;
      }

      const detail = await withTenantTx(request.tenantContext!, (client) => getClientDetail(client, id));
      if (!detail) {
        await reply.code(404).send({ error: 'tenant not found' });
        return;
      }
      return detail;
    });

    adminRoutes.patch('/api/internal/tenants/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) {
        await reply.code(400).send({ error: 'invalid tenant id: must be a well-formed UUID' });
        return;
      }

      const body = request.body as { name?: unknown; isActive?: unknown };
      if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
        await reply.code(400).send({ error: 'invalid name: must be a non-empty string' });
        return;
      }
      if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
        await reply.code(400).send({ error: 'invalid isActive: must be a boolean' });
        return;
      }

      const updated = await withTenantTx(request.tenantContext!, (client) =>
        updateClient(client, id, { name: body.name as string | undefined, isActive: body.isActive as boolean | undefined }),
      );
      if (!updated) {
        await reply.code(404).send({ error: 'tenant not found' });
        return;
      }
      return updated;
    });

    adminRoutes.post('/api/internal/tenants/:id/branding', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) {
        await reply.code(400).send({ error: 'invalid tenant id: must be a well-formed UUID' });
        return;
      }

      const body = request.body as { domain?: unknown; logoUrl?: unknown; primaryColor?: unknown; secondaryColor?: unknown };
      if (typeof body.domain !== 'string' || body.domain.trim() === '') {
        await reply.code(400).send({ error: 'invalid domain: must be a non-empty string' });
        return;
      }
      if (typeof body.logoUrl !== 'string' || !isValidHttpUrl(body.logoUrl)) {
        await reply.code(400).send({ error: 'invalid logoUrl: must be a valid http(s) URL' });
        return;
      }
      if (typeof body.primaryColor !== 'string' || !HEX_COLOR_PATTERN.test(body.primaryColor)) {
        await reply.code(400).send({ error: 'invalid primaryColor: must be a hex color like #112233' });
        return;
      }
      if (
        body.secondaryColor !== undefined &&
        body.secondaryColor !== null &&
        (typeof body.secondaryColor !== 'string' || !HEX_COLOR_PATTERN.test(body.secondaryColor))
      ) {
        await reply.code(400).send({ error: 'invalid secondaryColor: must be a hex color like #112233, or null' });
        return;
      }

      try {
        const created = await withTenantTx(request.tenantContext!, (client) =>
          createCustomerBranding(client, {
            clientId: id,
            domain: body.domain as string,
            logoUrl: body.logoUrl as string,
            primaryColor: body.primaryColor as string,
            secondaryColor: (body.secondaryColor as string | null | undefined) ?? null,
          }),
        );
        await reply.code(201).send(created);
      } catch (err) {
        if (isUniqueViolation(err)) {
          await reply.code(409).send({ error: 'a branding configuration already exists for this tenant, or this domain is already in use' });
          return;
        }
        throw err;
      }
    });

    // Reconfigure an EXISTING tenant's branding (Branding tab's CREATE/UPDATE
    // toggle) -- domain is deliberately not accepted here (immutable once
    // set, same as internal-branding-routes.ts's own PATCH), only the
    // mutable fields updateCustomerBranding.ts already supports. This
    // supplements that existing tenant-scoped PATCH rather than rebuilding
    // it (per this item's own Rabbit-holes note): that route only lets a
    // tenant's OWN analyst update their tenant's branding, which doesn't
    // cover an admin managing a tenant they hold no membership in.
    adminRoutes.patch('/api/internal/tenants/:id/branding', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) {
        await reply.code(400).send({ error: 'invalid tenant id: must be a well-formed UUID' });
        return;
      }

      const body = request.body as { logoUrl?: unknown; primaryColor?: unknown; secondaryColor?: unknown };
      if (typeof body.logoUrl !== 'string' || !isValidHttpUrl(body.logoUrl)) {
        await reply.code(400).send({ error: 'invalid logoUrl: must be a valid http(s) URL' });
        return;
      }
      if (typeof body.primaryColor !== 'string' || !HEX_COLOR_PATTERN.test(body.primaryColor)) {
        await reply.code(400).send({ error: 'invalid primaryColor: must be a hex color like #112233' });
        return;
      }
      if (
        body.secondaryColor !== undefined &&
        body.secondaryColor !== null &&
        (typeof body.secondaryColor !== 'string' || !HEX_COLOR_PATTERN.test(body.secondaryColor))
      ) {
        await reply.code(400).send({ error: 'invalid secondaryColor: must be a hex color like #112233, or null' });
        return;
      }

      const result = await withTenantTx(request.tenantContext!, (client) =>
        updateCustomerBranding(client, id, {
          logoUrl: body.logoUrl as string,
          primaryColor: body.primaryColor as string,
          secondaryColor: (body.secondaryColor as string | null | undefined) ?? null,
        }),
      );
      if (!result.found) {
        await reply.code(404).send({ error: 'no branding configuration exists for this tenant yet' });
        return;
      }
      return result.branding;
    });

    adminRoutes.get('/api/internal/tenants/:id/members', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) {
        await reply.code(400).send({ error: 'invalid tenant id: must be a well-formed UUID' });
        return;
      }

      const members = await withTenantTx(request.tenantContext!, (client) => listTenantMembers(client, id));
      return { members };
    });

    adminRoutes.post('/api/internal/tenants/:id/members', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) {
        await reply.code(400).send({ error: 'invalid tenant id: must be a well-formed UUID' });
        return;
      }

      const body = request.body as { email?: unknown; fullName?: unknown; role?: unknown };
      if (typeof body.email !== 'string' || body.email.trim() === '') {
        await reply.code(400).send({ error: 'invalid email: must be a non-empty string' });
        return;
      }
      if (typeof body.role !== 'string' || !MEMBERSHIP_ROLES.has(body.role)) {
        await reply.code(400).send({ error: `invalid role: must be one of ${[...MEMBERSHIP_ROLES].join(', ')}` });
        return;
      }
      if (body.fullName !== undefined && body.fullName !== null && typeof body.fullName !== 'string') {
        await reply.code(400).send({ error: 'invalid fullName: must be a string' });
        return;
      }

      const result = await withTenantTx(request.tenantContext!, (client) =>
        createMembership(client, {
          clientId: id,
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

    adminRoutes.delete('/api/internal/tenants/:id/members/:membershipId', async (request, reply) => {
      const { id, membershipId } = request.params as { id: string; membershipId: string };
      if (!isUuid(id) || !isUuid(membershipId)) {
        await reply.code(400).send({ error: 'invalid id: must be a well-formed UUID' });
        return;
      }

      const result = await withTenantTx(request.tenantContext!, (client) => removeMembership(client, id, membershipId));
      if (!result.found) {
        await reply.code(404).send({ error: 'membership not found' });
        return;
      }
      await reply.code(204).send();
    });
  });
}
