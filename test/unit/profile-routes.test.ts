import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_USER_ID = '22222222-2222-4222-8222-222222222222';

function mockAuth(role: string = 'client_viewer') {
  vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
    registerTenantAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
        request.tenantContext = { clientIds: [CLIENT_ID] };
        request.actorUserId = ACTOR_USER_ID;
        request.actorRole = role;
      });
    },
  }));
}

/**
 * 86e38pz8e: PATCH /api/profile. Unlike internal-branding-routes.test.ts's
 * sibling suite, there is no role-rejection case to prove here -- this
 * route is deliberately reachable by any membership role (client_viewer,
 * client_admin, analyst, lead) editing their OWN row, so the interesting
 * boundary is "which row" (always request.actorUserId, never anything from
 * the body), not "which role."
 */
describe('PATCH /api/profile', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
    vi.doUnmock('../../src/modules/identity/update-user-profile.js');
    vi.doUnmock('../../src/db/tenant-context.js');
  });

  it('requires authentication', async () => {
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();
    const response = await app.inject({ method: 'PATCH', url: '/api/profile', payload: { name: 'New Name' } });
    expect(response.statusCode).toBe(401);
  });

  it.each(['client_viewer', 'client_admin', 'analyst', 'lead'])(
    'AC3: a %s updates their own display name, scoped to actorUserId',
    async (role) => {
      mockAuth(role);
      const updateUserProfile = vi.fn().mockResolvedValue({ id: ACTOR_USER_ID, name: 'New Name', email: 'a@example.com', image: null });
      vi.doMock('../../src/modules/identity/update-user-profile.js', () => ({ updateUserProfile }));
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const { registerProfileRoutes } = await import('../../src/server/profile-routes.js');
      app = Fastify();
      await app.register(registerProfileRoutes);
      await app.ready();

      const response = await app.inject({ method: 'PATCH', url: '/api/profile', payload: { name: 'New Name' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ name: 'New Name', email: 'a@example.com', image: null });
      expect(updateUserProfile).toHaveBeenCalledWith({}, ACTOR_USER_ID, { name: 'New Name', image: undefined });
    },
  );

  it('updates the avatar image', async () => {
    mockAuth();
    const updateUserProfile = vi.fn().mockResolvedValue({ id: ACTOR_USER_ID, name: 'Dana', email: 'a@example.com', image: 'https://cdn.example.com/avatar.png' });
    vi.doMock('../../src/modules/identity/update-user-profile.js', () => ({ updateUserProfile }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerProfileRoutes } = await import('../../src/server/profile-routes.js');
    app = Fastify();
    await app.register(registerProfileRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PATCH', url: '/api/profile', payload: { image: 'https://cdn.example.com/avatar.png' } });
    expect(response.statusCode).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith({}, ACTOR_USER_ID, { name: undefined, image: 'https://cdn.example.com/avatar.png' });
  });

  it('clears the avatar image with an explicit null', async () => {
    mockAuth();
    const updateUserProfile = vi.fn().mockResolvedValue({ id: ACTOR_USER_ID, name: 'Dana', email: 'a@example.com', image: null });
    vi.doMock('../../src/modules/identity/update-user-profile.js', () => ({ updateUserProfile }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerProfileRoutes } = await import('../../src/server/profile-routes.js');
    app = Fastify();
    await app.register(registerProfileRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PATCH', url: '/api/profile', payload: { image: null } });
    expect(response.statusCode).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith({}, ACTOR_USER_ID, { name: undefined, image: null });
  });

  it.each(['role', 'clientId', 'client_id', 'tenantId', 'tenant_id', 'isInternal', 'is_internal', 'email'])(
    'AC6: rejects a body containing "%s" with 400, never calling updateUserProfile',
    async (field) => {
      mockAuth();
      const updateUserProfile = vi.fn();
      vi.doMock('../../src/modules/identity/update-user-profile.js', () => ({ updateUserProfile }));
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const { registerProfileRoutes } = await import('../../src/server/profile-routes.js');
      app = Fastify();
      await app.register(registerProfileRoutes);
      await app.ready();

      const response = await app.inject({ method: 'PATCH', url: '/api/profile', payload: { name: 'New Name', [field]: 'anything' } });
      expect(response.statusCode).toBe(400);
      expect(updateUserProfile).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['blank name', { name: '   ' }],
    ['non-string name', { name: 42 }],
    ['non-URL image', { image: 'not-a-url' }],
    ['ftp image (not http/https)', { image: 'ftp://example.com/a.png' }],
    ['empty body', {}],
  ])('rejects with 400: %s', async (_label, payload) => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerProfileRoutes } = await import('../../src/server/profile-routes.js');
    app = Fastify();
    await app.register(registerProfileRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PATCH', url: '/api/profile', payload });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 when the underlying row is gone', async () => {
    mockAuth();
    const updateUserProfile = vi.fn().mockResolvedValue(null);
    vi.doMock('../../src/modules/identity/update-user-profile.js', () => ({ updateUserProfile }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerProfileRoutes } = await import('../../src/server/profile-routes.js');
    app = Fastify();
    await app.register(registerProfileRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PATCH', url: '/api/profile', payload: { name: 'New Name' } });
    expect(response.statusCode).toBe(404);
  });
});
