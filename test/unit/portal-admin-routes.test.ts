import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { encodeCursor } from '../../src/shared/cursor-pagination.js';

/**
 * Request-level unit coverage of GET /api/portal/members and PATCH
 * /api/portal/members/:id/role via Fastify's .inject(), with db/tenant-
 * context AND both auth modules mocked so this runs with no live Postgres --
 * same pattern as claim-recovery-endpoint.test.ts. Complements
 * test/db/portal-admin-routes.db.test.ts, which covers the same routes
 * against a real DB (RLS isolation, the internal-role exclusion proof).
 *
 * client-admin-auth.test.ts/client-viewer-auth.test.ts already prove each
 * resolver's own role logic exhaustively; this file assumes that and only
 * proves how THIS route registration composes/consumes them -- the
 * composite read preHandler, and that a real write route sits under the
 * admin-only preHandler (round-39's own lesson: a 403/401 proof is only
 * meaningful when a route actually exists to be rejected from).
 *
 * client-viewer-auth.js's mock also stubs registerClientViewerAuthPreHandler
 * (unused by this file's own routes) because buildApp() registers
 * portal-content-routes.ts (P6.B.1) alongside portal-admin-routes.ts in the
 * same app, and that module's registration-time import needs the export to
 * exist on the mocked module -- same no-op-when-unreached shape
 * portal-content-routes.test.ts uses for its own mock.
 */
function mockAuth(admin: unknown, viewer: unknown) {
  vi.doMock('../../src/modules/identity/client-admin-auth.js', () => ({
    resolveClientAdminContext: vi.fn().mockResolvedValue(admin),
    registerClientAdminAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request, reply) => {
        if (!admin) {
          await reply.code(401).send({ error: 'unauthorized' });
          return;
        }
        request.tenantContext = admin as never;
        const userId = request.headers['x-user-id'];
        request.actorUserId = Array.isArray(userId) ? userId[0] : userId;
      });
    },
  }));
  vi.doMock('../../src/modules/identity/client-viewer-auth.js', () => ({
    resolveClientViewerContext: vi.fn().mockResolvedValue(viewer),
    registerClientViewerAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request, reply) => {
        if (!viewer) {
          await reply.code(401).send({ error: 'unauthorized' });
          return;
        }
        request.tenantContext = viewer as never;
      });
    },
  }));
}

const CLIENT_ID = 'client-abc';

describe('portal-admin routes (unit, mocked withTenantTx + auth)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/identity/client-admin-auth.js');
    vi.doUnmock('../../src/modules/identity/client-viewer-auth.js');
    vi.doUnmock('../../src/modules/identity/list-portal-members.js');
    vi.doUnmock('../../src/modules/identity/update-portal-member-role.js');
    vi.doUnmock('../../src/modules/identity/create-membership.js');
    vi.doUnmock('../../src/modules/identity/remove-portal-member.js');
  });

  describe('GET /api/portal/members', () => {
    it('lists members for an authorized client_admin caller', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      const listPortalMembers = vi.fn().mockResolvedValue([{ id: 'm1', role: 'client_viewer' }]);
      vi.doMock('../../src/modules/identity/list-portal-members.js', () => ({ listPortalMembers }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({ method: 'GET', url: '/api/portal/members', headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1' } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ members: [{ id: 'm1', role: 'client_viewer' }], nextCursor: null });
      expect(listPortalMembers).toHaveBeenCalledWith({}, CLIENT_ID, { limit: 51, offset: undefined, cursor: undefined });
    });

    it('lists members for an authorized client_viewer caller (falls through when client_admin does not resolve)', async () => {
      mockAuth(null, { clientIds: [CLIENT_ID], internal: false });
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      const listPortalMembers = vi.fn().mockResolvedValue([]);
      vi.doMock('../../src/modules/identity/list-portal-members.js', () => ({ listPortalMembers }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({ method: 'GET', url: '/api/portal/members', headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1' } });

      expect(res.statusCode).toBe(200);
      expect(listPortalMembers).toHaveBeenCalled();
    });

    it('rejects an unauthenticated request with 401, without calling listPortalMembers', async () => {
      mockAuth(null, null);
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
      const listPortalMembers = vi.fn();
      vi.doMock('../../src/modules/identity/list-portal-members.js', () => ({ listPortalMembers }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({ method: 'GET', url: '/api/portal/members' });
      expect(res.statusCode).toBe(401);
      expect(listPortalMembers).not.toHaveBeenCalled();
    });

    it('rejects limit above the max with 400 without calling listPortalMembers', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      const listPortalMembers = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/identity/list-portal-members.js', () => ({ listPortalMembers }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({ method: 'GET', url: '/api/portal/members?limit=9999', headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1' } });
      expect(res.statusCode).toBe(400);
      expect(listPortalMembers).not.toHaveBeenCalled();
    });

    it('rejects a negative offset with 400', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/identity/list-portal-members.js', () => ({ listPortalMembers: vi.fn() }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({ method: 'GET', url: '/api/portal/members?offset=-1', headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1' } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects combining cursor with offset, without calling listPortalMembers', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      const listPortalMembers = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/identity/list-portal-members.js', () => ({ listPortalMembers }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const cursor = encodeCursor({ v: '2026-01-01T00:00:00.000Z', id: '10000000-0000-4000-8000-000000000001' });
      const res = await app.inject({
        method: 'GET', url: `/api/portal/members?cursor=${cursor}&offset=10`,
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1' },
      });
      expect(res.statusCode).toBe(400);
      expect(listPortalMembers).not.toHaveBeenCalled();
    });

    it('rejects a malformed cursor with 400, without calling listPortalMembers', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      const listPortalMembers = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/identity/list-portal-members.js', () => ({ listPortalMembers }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'GET', url: '/api/portal/members?cursor=not-a-valid-cursor',
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1' },
      });
      expect(res.statusCode).toBe(400);
      expect(listPortalMembers).not.toHaveBeenCalled();
    });

    it('trims the overflow row and returns a nextCursor when more rows exist than the page limit', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      const rows = [
        { id: 'm3', role: 'client_viewer', createdAt: new Date('2026-01-03T00:00:00.000Z') },
        { id: 'm2', role: 'client_viewer', createdAt: new Date('2026-01-02T00:00:00.000Z') },
        { id: 'm1', role: 'client_admin', createdAt: new Date('2026-01-01T00:00:00.000Z') },
      ];
      const listPortalMembers = vi.fn().mockResolvedValue(rows);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/identity/list-portal-members.js', () => ({ listPortalMembers }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({ method: 'GET', url: '/api/portal/members?limit=2', headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1' } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.members).toEqual([
        { id: 'm3', role: 'client_viewer', createdAt: '2026-01-03T00:00:00.000Z' },
        { id: 'm2', role: 'client_viewer', createdAt: '2026-01-02T00:00:00.000Z' },
      ]);
      expect(body.nextCursor).not.toBeNull();
    });
  });

  describe('PATCH /api/portal/members/:id/role', () => {
    const membershipId = '10000000-0000-4000-8000-000000000001';

    it('updates the role for an authorized client_admin caller', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      const updatePortalMemberRole = vi.fn().mockResolvedValue({ found: true });
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole, PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH', url: `/api/portal/members/${membershipId}/role`,
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { role: 'client_admin' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: membershipId, role: 'client_admin' });
      expect(updatePortalMemberRole).toHaveBeenCalledWith({}, CLIENT_ID, membershipId, 'client_admin', 'user-1');
    });

    it('rejects an authorized-but-non-admin (client_viewer) caller with 401, never reaching the handler -- a real write route sits under the admin-only preHandler here', async () => {
      // admin resolves null (not client_admin); registerClientAdminAuthPreHandler's own mock replies 401 exactly as it does when auth fails.
      mockAuth(null, { clientIds: [CLIENT_ID], internal: false });
      const updatePortalMemberRole = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole, PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH', url: `/api/portal/members/${membershipId}/role`,
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { role: 'client_admin' },
      });

      expect(res.statusCode).toBe(401);
      expect(updatePortalMemberRole).not.toHaveBeenCalled();
    });

    it('rejects an unauthenticated request with 401', async () => {
      mockAuth(null, null);
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole: vi.fn(), PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH', url: `/api/portal/members/${membershipId}/role`,
        headers: { 'content-type': 'application/json' }, payload: { role: 'client_admin' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a malformed membership id with 400', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      const updatePortalMemberRole = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole, PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH', url: '/api/portal/members/not-a-uuid/role',
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { role: 'client_admin' },
      });
      expect(res.statusCode).toBe(400);
      expect(updatePortalMemberRole).not.toHaveBeenCalled();
    });

    it('rejects an invalid role value with 400, without calling updatePortalMemberRole', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      const updatePortalMemberRole = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole, PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH', url: `/api/portal/members/${membershipId}/role`,
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { role: 'analyst' },
      });
      expect(res.statusCode).toBe(400);
      expect(updatePortalMemberRole).not.toHaveBeenCalled();
    });

    it('returns 404 when updatePortalMemberRole resolves found: false', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({
        updatePortalMemberRole: vi.fn().mockResolvedValue({ found: false }), PORTAL_ROLES: ['client_viewer', 'client_admin'],
      }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH', url: `/api/portal/members/${membershipId}/role`,
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { role: 'client_admin' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/portal/members', () => {
    it('invites a new portal member for an authorized client_admin caller', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      const createMembership = vi.fn().mockResolvedValue({ created: true, membershipId: 'm9', userId: 'u9', isNewUser: true });
      vi.doMock('../../src/modules/identity/create-membership.js', () => ({ createMembership }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole: vi.fn(), PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'POST', url: '/api/portal/members',
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { email: 'new@example.com', role: 'client_viewer' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ membershipId: 'm9', userId: 'u9', isNewUser: true, role: 'client_viewer' });
      expect(createMembership).toHaveBeenCalledWith({}, { clientId: CLIENT_ID, email: 'new@example.com', fullName: null, role: 'client_viewer' });
    });

    it('rejects an authorized-but-non-admin (client_viewer) caller with 401, never reaching the handler', async () => {
      mockAuth(null, { clientIds: [CLIENT_ID], internal: false });
      const createMembership = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
      vi.doMock('../../src/modules/identity/create-membership.js', () => ({ createMembership }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole: vi.fn(), PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'POST', url: '/api/portal/members',
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { email: 'new@example.com', role: 'client_viewer' },
      });

      expect(res.statusCode).toBe(401);
      expect(createMembership).not.toHaveBeenCalled();
    });

    it('rejects a role outside PORTAL_ROLES (e.g. analyst) with 400, so a client_admin can never self-assign an internal role', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      const createMembership = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/identity/create-membership.js', () => ({ createMembership }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole: vi.fn(), PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'POST', url: '/api/portal/members',
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { email: 'new@example.com', role: 'analyst' },
      });

      expect(res.statusCode).toBe(400);
      expect(createMembership).not.toHaveBeenCalled();
    });

    it('rejects a missing/empty email with 400', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      const createMembership = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/identity/create-membership.js', () => ({ createMembership }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole: vi.fn(), PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'POST', url: '/api/portal/members',
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { email: '', role: 'client_viewer' },
      });

      expect(res.statusCode).toBe(400);
      expect(createMembership).not.toHaveBeenCalled();
    });

    it('returns 409 when createMembership resolves created: false (already a member)', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/identity/create-membership.js', () => ({
        createMembership: vi.fn().mockResolvedValue({ created: false, reason: 'already_member' }),
      }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole: vi.fn(), PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'POST', url: '/api/portal/members',
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { email: 'dup@example.com', role: 'client_viewer' },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe('DELETE /api/portal/members/:id', () => {
    const membershipId = '10000000-0000-4000-8000-000000000001';

    it('removes a member for an authorized client_admin caller', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      const removeMembership = vi.fn().mockResolvedValue({ found: true });
      vi.doMock('../../src/modules/identity/remove-portal-member.js', () => ({ removePortalMember: removeMembership }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole: vi.fn(), PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'DELETE', url: `/api/portal/members/${membershipId}`,
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1' },
      });

      expect(res.statusCode).toBe(204);
      expect(removeMembership).toHaveBeenCalledWith({}, CLIENT_ID, membershipId);
    });

    it('rejects an authorized-but-non-admin (client_viewer) caller with 401, never reaching the handler', async () => {
      mockAuth(null, { clientIds: [CLIENT_ID], internal: false });
      const removeMembership = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
      vi.doMock('../../src/modules/identity/remove-portal-member.js', () => ({ removePortalMember: removeMembership }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole: vi.fn(), PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'DELETE', url: `/api/portal/members/${membershipId}`,
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1' },
      });

      expect(res.statusCode).toBe(401);
      expect(removeMembership).not.toHaveBeenCalled();
    });

    it('rejects a malformed membership id with 400', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      const removeMembership = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/identity/remove-portal-member.js', () => ({ removePortalMember: removeMembership }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole: vi.fn(), PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'DELETE', url: '/api/portal/members/not-a-uuid',
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1' },
      });

      expect(res.statusCode).toBe(400);
      expect(removeMembership).not.toHaveBeenCalled();
    });

    it('returns 404 when removeMembership resolves found: false', async () => {
      mockAuth({ clientIds: [CLIENT_ID], internal: false }, null);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/identity/remove-portal-member.js', () => ({ removePortalMember: vi.fn().mockResolvedValue({ found: false }) }));
      vi.doMock('../../src/modules/identity/update-portal-member-role.js', () => ({ updatePortalMemberRole: vi.fn(), PORTAL_ROLES: ['client_viewer', 'client_admin'] }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'DELETE', url: `/api/portal/members/${membershipId}`,
        headers: { 'x-client-id': CLIENT_ID, 'x-user-id': 'user-1' },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
