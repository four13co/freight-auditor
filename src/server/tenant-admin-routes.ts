import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAdminAuthPreHandler } from '../modules/identity/tenant-admin-auth.js';
import { createClient as createClientRow } from '../modules/identity/onboarding.js';
import { listClients } from '../modules/identity/list-accounts.js';
import { getAccountDetail } from '../modules/identity/get-account-detail.js';
import { updateClient } from '../modules/identity/update-account.js';
import { createCustomerBranding } from '../modules/identity/create-customer-branding.js';
import { updateCustomerBranding } from '../modules/identity/update-customer-branding.js';
import { createMembership } from '../modules/identity/create-membership.js';
import { createTenantClient, listTenantClients, updateTenantClient, clientBelongsToAccount } from '../modules/identity/tenant-client.js';
import { createTenantVendor, listTenantVendors, updateTenantVendor, vendorBelongsToClient, TenantVendorParentNotFoundError } from '../modules/identity/tenant-vendor.js';
import { listTenantMembers } from '../modules/identity/list-tenant-members.js';
import { removeMembership } from '../modules/identity/remove-membership.js';
import { updateTenantMembership } from '../modules/identity/update-tenant-membership.js';
import { listAllTenantMembers } from '../modules/identity/list-all-tenant-members.js';
import { isUuid, validateBrandingFields } from '../shared/request-validation.js';
import { decodeCursor, paginateKeyset } from '../shared/cursor-pagination.js';
import { parseLimitOffset } from '../shared/parse-limit-offset.js';
import { listContractVersionsForTenant } from '../modules/rate-engine/list-contract-versions.js';
import {
  listContractRates, createContractRate, updateContractRate, deleteContractRate, ContractRateNotFoundError,
} from '../modules/rate-engine/contract-rate-admin.js';

const MEMBERSHIP_ROLES = new Set([
  'analyst', 'lead', 'account_viewer', 'account_admin',
  // 86e3a76bz (migration 0084): Client- and Vendor-level roles. NOT a
  // reuse of the client_viewer/client_admin literals migration 0083 freed --
  // see that migration's own header comment for why reuse was rejected.
  'client_scope_viewer', 'client_scope_admin', 'vendor_scope_viewer', 'vendor_scope_admin',
]);
// 86e3a76bz: role sets accepted at each NEW scope level's own membership-assignment
// endpoint -- narrower than the full MEMBERSHIP_ROLES set above (which stays the
// account-level endpoint's own validation, unchanged) so a Client-scoped invite can't
// be handed an account_admin or vendor_scope_* role that means something else entirely.
const CLIENT_SCOPE_MEMBERSHIP_ROLES = new Set(['analyst', 'lead', 'client_scope_viewer', 'client_scope_admin']);
const VENDOR_SCOPE_MEMBERSHIP_ROLES = new Set(['analyst', 'lead', 'vendor_scope_viewer', 'vendor_scope_admin']);
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

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

      const detail = await withTenantTx(request.tenantContext!, (client) => getAccountDetail(client, id));
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
      const createValidationError = validateBrandingFields(body);
      if (createValidationError) {
        await reply.code(400).send({ error: createValidationError });
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
      const updateValidationError = validateBrandingFields(body);
      if (updateValidationError) {
        await reply.code(400).send({ error: updateValidationError });
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

    adminRoutes.patch('/api/internal/tenants/:id/members/:membershipId', async (request, reply) => {
      const { id, membershipId } = request.params as { id: string; membershipId: string };
      if (!isUuid(id) || !isUuid(membershipId)) {
        await reply.code(400).send({ error: 'invalid id: must be a well-formed UUID' });
        return;
      }

      const body = request.body as { role?: unknown; isActive?: unknown };
      if (body.role !== undefined && (typeof body.role !== 'string' || !MEMBERSHIP_ROLES.has(body.role))) {
        await reply.code(400).send({ error: `invalid role: must be one of ${[...MEMBERSHIP_ROLES].join(', ')}` });
        return;
      }
      if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
        await reply.code(400).send({ error: 'invalid isActive: must be a boolean' });
        return;
      }
      if (body.role === undefined && body.isActive === undefined) {
        await reply.code(400).send({ error: 'at least one of role or isActive must be provided' });
        return;
      }

      const result = await withTenantTx(request.tenantContext!, (client) =>
        updateTenantMembership(
          client,
          id,
          membershipId,
          { role: body.role as string | undefined, isActive: body.isActive as boolean | undefined },
          request.actorUserId,
        ),
      );
      if (!result.found) {
        await reply.code(404).send({ error: 'membership not found' });
        return;
      }
      return { id: result.id, role: result.role, isActive: result.isActive };
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

    // 86e3a76bz: Client (middle-tier) CRUD, replacing
    // web/src/lib/in-memory-hierarchy-store.ts's session-lifetime stand-in
    // -- see that module's header comment and this PR's description for the
    // migration plan swapping its call sites over to these endpoints.
    adminRoutes.post('/api/internal/tenants/:id/clients', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) {
        await reply.code(400).send({ error: 'invalid tenant id: must be a well-formed UUID' });
        return;
      }
      const body = request.body as { name?: unknown };
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        await reply.code(400).send({ error: 'invalid name: must be a non-empty string' });
        return;
      }

      try {
        const created = await withTenantTx(request.tenantContext!, (client) =>
          createTenantClient(client, { accountId: id, name: body.name as string }),
        );
        await reply.code(201).send({ id: created.id, accountId: id, name: body.name, isActive: true });
      } catch (err) {
        if (isUniqueViolation(err)) {
          await reply.code(409).send({ error: 'a client with this name already exists for this tenant' });
          return;
        }
        throw err;
      }
    });

    adminRoutes.get('/api/internal/tenants/:id/clients', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) {
        await reply.code(400).send({ error: 'invalid tenant id: must be a well-formed UUID' });
        return;
      }
      const clients = await withTenantTx(request.tenantContext!, (client) => listTenantClients(client, id));
      return { clients };
    });

    adminRoutes.patch('/api/internal/tenants/:id/clients/:clientId', async (request, reply) => {
      const { id, clientId } = request.params as { id: string; clientId: string };
      if (!isUuid(id) || !isUuid(clientId)) {
        await reply.code(400).send({ error: 'invalid id: must be a well-formed UUID' });
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
        updateTenantClient(client, id, clientId, { name: body.name as string | undefined, isActive: body.isActive as boolean | undefined }),
      );
      if (!updated) {
        await reply.code(404).send({ error: 'client not found' });
        return;
      }
      return updated;
    });

    // 86e3a76bz: Client-scoped membership assignment -- same
    // idempotent-insert-then-409-on-conflict pattern as the account-level
    // POST .../members above, scoped one level down.
    adminRoutes.post('/api/internal/tenants/:id/clients/:clientId/members', async (request, reply) => {
      const { id, clientId } = request.params as { id: string; clientId: string };
      if (!isUuid(id) || !isUuid(clientId)) {
        await reply.code(400).send({ error: 'invalid id: must be a well-formed UUID' });
        return;
      }
      const body = request.body as { email?: unknown; fullName?: unknown; role?: unknown };
      if (typeof body.email !== 'string' || body.email.trim() === '') {
        await reply.code(400).send({ error: 'invalid email: must be a non-empty string' });
        return;
      }
      if (typeof body.role !== 'string' || !CLIENT_SCOPE_MEMBERSHIP_ROLES.has(body.role)) {
        await reply.code(400).send({ error: `invalid role: must be one of ${[...CLIENT_SCOPE_MEMBERSHIP_ROLES].join(', ')}` });
        return;
      }
      if (body.fullName !== undefined && body.fullName !== null && typeof body.fullName !== 'string') {
        await reply.code(400).send({ error: 'invalid fullName: must be a string' });
        return;
      }

      const result = await withTenantTx(request.tenantContext!, async (client) => {
        // 86e3a76bz Review fix: `id` (account) and `clientId` are two independent
        // URL path params -- verify the ancestor chain before inserting a
        // membership row that would otherwise carry a mismatched pair.
        if (!(await clientBelongsToAccount(client, id, clientId))) {
          return { parentNotFound: true as const };
        }
        return { parentNotFound: false as const, ...(await createMembership(client, {
          clientId: id,
          scopeClientId: clientId,
          email: body.email as string,
          fullName: (body.fullName as string | null | undefined) ?? null,
          role: body.role as string,
        })) };
      });

      if (result.parentNotFound) {
        await reply.code(404).send({ error: 'client not found for this tenant' });
        return;
      }
      if (!result.created) {
        await reply.code(409).send({ error: 'this user is already a member at this scope' });
        return;
      }
      await reply.code(201).send({ membershipId: result.membershipId, userId: result.userId, isNewUser: result.isNewUser, role: body.role });
    });

    // 86e3a76bz: Vendor (bottom-tier) CRUD, nested under its owning Client.
    adminRoutes.post('/api/internal/tenants/:id/clients/:clientId/vendors', async (request, reply) => {
      const { id, clientId } = request.params as { id: string; clientId: string };
      if (!isUuid(id) || !isUuid(clientId)) {
        await reply.code(400).send({ error: 'invalid id: must be a well-formed UUID' });
        return;
      }
      const body = request.body as { name?: unknown; contactInfo?: unknown };
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        await reply.code(400).send({ error: 'invalid name: must be a non-empty string' });
        return;
      }
      if (body.contactInfo !== undefined && body.contactInfo !== null && typeof body.contactInfo !== 'string') {
        await reply.code(400).send({ error: 'invalid contactInfo: must be a string' });
        return;
      }

      try {
        const created = await withTenantTx(request.tenantContext!, (client) =>
          createTenantVendor(client, { accountId: id, clientId, name: body.name as string, contactInfo: (body.contactInfo as string | null | undefined) ?? null }),
        );
        await reply.code(201).send({ id: created.id, accountId: id, clientId, name: body.name, contactInfo: body.contactInfo ?? null, isActive: true });
      } catch (err) {
        if (err instanceof TenantVendorParentNotFoundError) {
          await reply.code(404).send({ error: 'client not found for this tenant' });
          return;
        }
        if (isUniqueViolation(err)) {
          await reply.code(409).send({ error: 'a vendor with this name already exists for this client' });
          return;
        }
        throw err;
      }
    });

    adminRoutes.get('/api/internal/tenants/:id/clients/:clientId/vendors', async (request, reply) => {
      const { id, clientId } = request.params as { id: string; clientId: string };
      if (!isUuid(id) || !isUuid(clientId)) {
        await reply.code(400).send({ error: 'invalid id: must be a well-formed UUID' });
        return;
      }
      const vendors = await withTenantTx(request.tenantContext!, (client) => listTenantVendors(client, id, clientId));
      return { vendors };
    });

    adminRoutes.patch('/api/internal/tenants/:id/clients/:clientId/vendors/:vendorId', async (request, reply) => {
      const { id, clientId, vendorId } = request.params as { id: string; clientId: string; vendorId: string };
      if (!isUuid(id) || !isUuid(clientId) || !isUuid(vendorId)) {
        await reply.code(400).send({ error: 'invalid id: must be a well-formed UUID' });
        return;
      }
      const body = request.body as { name?: unknown; contactInfo?: unknown; isActive?: unknown };
      if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
        await reply.code(400).send({ error: 'invalid name: must be a non-empty string' });
        return;
      }
      if (body.contactInfo !== undefined && body.contactInfo !== null && typeof body.contactInfo !== 'string') {
        await reply.code(400).send({ error: 'invalid contactInfo: must be a string' });
        return;
      }
      if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
        await reply.code(400).send({ error: 'invalid isActive: must be a boolean' });
        return;
      }

      const updated = await withTenantTx(request.tenantContext!, (client) =>
        updateTenantVendor(client, id, clientId, vendorId, {
          name: body.name as string | undefined,
          contactInfo: body.contactInfo as string | null | undefined,
          isActive: body.isActive as boolean | undefined,
        }),
      );
      if (!updated) {
        await reply.code(404).send({ error: 'vendor not found' });
        return;
      }
      return updated;
    });

    // 86e3a76bz: Vendor-scoped membership assignment -- same pattern as the
    // Client-scoped endpoint above, one level deeper.
    adminRoutes.post('/api/internal/tenants/:id/clients/:clientId/vendors/:vendorId/members', async (request, reply) => {
      const { id, clientId, vendorId } = request.params as { id: string; clientId: string; vendorId: string };
      if (!isUuid(id) || !isUuid(clientId) || !isUuid(vendorId)) {
        await reply.code(400).send({ error: 'invalid id: must be a well-formed UUID' });
        return;
      }
      const body = request.body as { email?: unknown; fullName?: unknown; role?: unknown };
      if (typeof body.email !== 'string' || body.email.trim() === '') {
        await reply.code(400).send({ error: 'invalid email: must be a non-empty string' });
        return;
      }
      if (typeof body.role !== 'string' || !VENDOR_SCOPE_MEMBERSHIP_ROLES.has(body.role)) {
        await reply.code(400).send({ error: `invalid role: must be one of ${[...VENDOR_SCOPE_MEMBERSHIP_ROLES].join(', ')}` });
        return;
      }
      if (body.fullName !== undefined && body.fullName !== null && typeof body.fullName !== 'string') {
        await reply.code(400).send({ error: 'invalid fullName: must be a string' });
        return;
      }

      const result = await withTenantTx(request.tenantContext!, async (client) => {
        // 86e3a76bz Review fix: verify the FULL ancestor chain (client belongs
        // to account, vendor belongs to client) before inserting a membership
        // row -- three independent URL path params, nothing else ties them
        // together. See createTenantVendor's own comment for the full rationale.
        if (!(await clientBelongsToAccount(client, id, clientId)) || !(await vendorBelongsToClient(client, clientId, vendorId))) {
          return { parentNotFound: true as const };
        }
        return { parentNotFound: false as const, ...(await createMembership(client, {
          clientId: id,
          scopeClientId: clientId,
          scopeVendorId: vendorId,
          email: body.email as string,
          fullName: (body.fullName as string | null | undefined) ?? null,
          role: body.role as string,
        })) };
      });

      if (result.parentNotFound) {
        await reply.code(404).send({ error: 'client or vendor not found for this tenant' });
        return;
      }
      if (!result.created) {
        await reply.code(409).send({ error: 'this user is already a member at this scope' });
        return;
      }
      await reply.code(201).send({ membershipId: result.membershipId, userId: result.userId, isNewUser: result.isNewUser, role: body.role });
    });

    // 86e3a6rg1 Rates tab: contract-version picker for the create-rate form.
    adminRoutes.get('/api/internal/tenants/:id/contract-versions', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) {
        await reply.code(400).send({ error: 'invalid tenant id: must be a well-formed UUID' });
        return;
      }
      const contractVersions = await withTenantTx(request.tenantContext!, (client) => listContractVersionsForTenant(client, id));
      return { contractVersions };
    });

    adminRoutes.get('/api/internal/tenants/:id/rates', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) {
        await reply.code(400).send({ error: 'invalid tenant id: must be a well-formed UUID' });
        return;
      }
      const rates = await withTenantTx(request.tenantContext!, (client) => listContractRates(client, id));
      return { rates };
    });

    adminRoutes.post('/api/internal/tenants/:id/rates', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) {
        await reply.code(400).send({ error: 'invalid tenant id: must be a well-formed UUID' });
        return;
      }
      const body = request.body as { contractVersionId?: unknown; category?: unknown; amount?: unknown; currency?: unknown; clauseId?: unknown };
      if (typeof body.contractVersionId !== 'string' || !isUuid(body.contractVersionId)) {
        await reply.code(400).send({ error: 'invalid contractVersionId: must be a well-formed UUID' });
        return;
      }
      if (typeof body.category !== 'string' || body.category.trim() === '') {
        await reply.code(400).send({ error: 'invalid category: must be a non-empty string' });
        return;
      }
      if (typeof body.amount !== 'string' || !/^\d+(\.\d{1,4})?$/.test(body.amount)) {
        await reply.code(400).send({ error: 'invalid amount: must be a decimal string (up to 4dp)' });
        return;
      }
      if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) {
        await reply.code(400).send({ error: 'invalid currency: must be a 3-letter ISO code' });
        return;
      }
      if (body.clauseId !== undefined && body.clauseId !== null && (typeof body.clauseId !== 'string' || !isUuid(body.clauseId))) {
        await reply.code(400).send({ error: 'invalid clauseId: must be a well-formed UUID' });
        return;
      }

      try {
        const created = await withTenantTx(request.tenantContext!, (client) => createContractRate(client, id, {
          contractVersionId: body.contractVersionId as string,
          category: body.category as string,
          amount: body.amount as string,
          currency: body.currency as string,
          clauseId: (body.clauseId as string | null | undefined) ?? null,
        }));
        await reply.code(201).send(created);
      } catch (err) {
        if (err instanceof ContractRateNotFoundError) {
          await reply.code(404).send({ error: 'contract version not found for this tenant' });
          return;
        }
        throw err;
      }
    });

    adminRoutes.patch('/api/internal/tenants/:id/rates/:rateId', async (request, reply) => {
      const { id, rateId } = request.params as { id: string; rateId: string };
      if (!isUuid(id) || !isUuid(rateId)) {
        await reply.code(400).send({ error: 'invalid id: must be a well-formed UUID' });
        return;
      }
      const body = request.body as { category?: unknown; amount?: unknown; currency?: unknown; clauseId?: unknown };
      if (body.category !== undefined && (typeof body.category !== 'string' || body.category.trim() === '')) {
        await reply.code(400).send({ error: 'invalid category: must be a non-empty string' });
        return;
      }
      if (body.amount !== undefined && (typeof body.amount !== 'string' || !/^\d+(\.\d{1,4})?$/.test(body.amount))) {
        await reply.code(400).send({ error: 'invalid amount: must be a decimal string (up to 4dp)' });
        return;
      }
      if (body.currency !== undefined && (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency))) {
        await reply.code(400).send({ error: 'invalid currency: must be a 3-letter ISO code' });
        return;
      }
      if (body.clauseId !== undefined && body.clauseId !== null && (typeof body.clauseId !== 'string' || !isUuid(body.clauseId))) {
        await reply.code(400).send({ error: 'invalid clauseId: must be a well-formed UUID' });
        return;
      }

      const patch: { category?: string; amount?: string; currency?: string; clauseId?: string | null } = {
        category: body.category as string | undefined,
        amount: body.amount as string | undefined,
        currency: body.currency as string | undefined,
      };
      if ('clauseId' in body) patch.clauseId = (body.clauseId as string | null) ?? null;

      const found = await withTenantTx(request.tenantContext!, (client) => updateContractRate(client, id, rateId, patch));
      if (!found) {
        await reply.code(404).send({ error: 'rate not found' });
        return;
      }
      await reply.code(204).send();
    });

    adminRoutes.delete('/api/internal/tenants/:id/rates/:rateId', async (request, reply) => {
      const { id, rateId } = request.params as { id: string; rateId: string };
      if (!isUuid(id) || !isUuid(rateId)) {
        await reply.code(400).send({ error: 'invalid id: must be a well-formed UUID' });
        return;
      }
      const found = await withTenantTx(request.tenantContext!, (client) => deleteContractRate(client, id, rateId));
      if (!found) {
        await reply.code(404).send({ error: 'rate not found' });
        return;
      }
      await reply.code(204).send();
    });

    // 86e3a75mf: cross-tenant paginated members view, replacing
    // fetchAllUsers()'s client-side per-tenant fan-out (see
    // list-all-tenant-members.ts). Same limit/cursor/offset validation as
    // GET /api/internal/tenants above.
    adminRoutes.get('/api/internal/members', async (request, reply) => {
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
        listAllTenantMembers(client, { limit: effectiveLimit + 1, offset: cursor ? undefined : offset, cursor }),
      );
      const { page, nextCursor } = paginateKeyset(rows, effectiveLimit, (r) => ({ v: r.createdAt.toISOString(), id: r.id }));
      return { members: page, nextCursor };
    });
  });
}
