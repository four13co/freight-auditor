import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

const INTERNAL_USER_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_ID = '44444444-4444-4444-8444-444444444444';
const INVALID_ID = 'not-a-uuid';

function mockAuth(isInternal: boolean) {
  vi.doMock('../../src/modules/identity/tenant-admin-auth.js', () => ({
    registerTenantAdminAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!isInternal) {
          await reply.code(403).send({ error: 'internal analyst role required' });
          return;
        }
        request.actorUserId = INTERNAL_USER_ID;
        request.tenantContext = { internal: true };
      });
    },
  }));
}

function mockUnauthenticated() {
  vi.doMock('../../src/modules/identity/tenant-admin-auth.js', () => ({
    registerTenantAdminAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (_request: FastifyRequest, reply: FastifyReply) => {
        await reply.code(401).send({ error: 'unauthorized' });
      });
    },
  }));
}

function mockTx() {
  vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
}

/**
 * 86e38rdnm: AC5 -- a client_viewer/client_admin (portal) session gets 403,
 * an unauthenticated request gets 401, and an internal analyst is admitted.
 * This item's own body originally named registerTenantAuthPreHandler +
 * registerAnalystOnlyPreHandler; tenant-admin-auth.ts's own header comment
 * explains why that pairing can't work for a cross-client create-tenant
 * flow, and why AC5's 403 (not 401) requires this route's own resolver.
 */
describe('tenant-admin-routes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/modules/identity/tenant-admin-auth.js');
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/identity/onboarding.js');
    vi.doUnmock('../../src/modules/identity/list-clients.js');
    vi.doUnmock('../../src/modules/identity/get-client-detail.js');
    vi.doUnmock('../../src/modules/identity/update-client.js');
    vi.doUnmock('../../src/modules/identity/create-customer-branding.js');
    vi.doUnmock('../../src/modules/identity/update-customer-branding.js');
    vi.doUnmock('../../src/modules/identity/create-membership.js');
    vi.doUnmock('../../src/modules/identity/list-tenant-members.js');
    vi.doUnmock('../../src/modules/identity/remove-membership.js');
  });

  it('requires authentication: 401 with no identity at all', async () => {
    mockUnauthenticated();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/internal/tenants' });
    expect(response.statusCode).toBe(401);
  });

  it('AC5: rejects a real (non-internal, e.g. portal) identity with 403', async () => {
    mockAuth(false);
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/internal/tenants' });
    expect(response.statusCode).toBe(403);
  });

  it('AC1: POST /api/internal/tenants creates a tenant and returns 201', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/onboarding.js', () => ({
      createClient: vi.fn(async (_client, input) => ({ id: TENANT_ID, ...input })),
    }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: '/api/internal/tenants', payload: { name: 'Acme', slug: 'acme' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: TENANT_ID, name: 'Acme', slug: 'acme', isActive: true });
  });

  it('rejects tenant creation with 400 on missing name/slug', async () => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/api/internal/tenants', payload: { name: 'Acme' } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects tenant creation with 400 on a missing name', async () => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/api/internal/tenants', payload: { slug: 'acme' } });
    expect(response.statusCode).toBe(400);
  });

  it('GET /api/internal/tenants/:id rejects an invalid id with 400', async () => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/api/internal/tenants/${INVALID_ID}` });
    expect(response.statusCode).toBe(400);
  });

  it('returns 409 when the slug already exists', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/onboarding.js', () => ({
      createClient: vi.fn(async () => {
        const err = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
        throw err;
      }),
    }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: '/api/internal/tenants', payload: { name: 'Acme', slug: 'acme' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('propagates an unexpected (non-unique-violation) tenant creation error', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/onboarding.js', () => ({
      createClient: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: '/api/internal/tenants', payload: { name: 'Acme', slug: 'acme' },
    });
    expect(response.statusCode).toBe(500);
  });

  it.each([
    ['limit too low', { limit: '0' }],
    ['limit not an integer', { limit: 'abc' }],
    ['limit too high', { limit: '9999' }],
    ['offset negative', { offset: '-1' }],
    ['offset not an integer', { offset: 'abc' }],
    ['cursor combined with offset', { cursor: 'abc', offset: '0' }],
    ['invalid cursor', { cursor: 'not-a-valid-cursor' }],
  ])('GET /api/internal/tenants rejects with 400: %s', async (_label, query) => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/internal/tenants', query });
    expect(response.statusCode).toBe(400);
  });

  it('GET /api/internal/tenants lists tenants', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/list-clients.js', () => ({
      listClients: vi.fn(async () => [
        { id: TENANT_ID, name: 'Acme', slug: 'acme', isActive: true, createdAt: new Date('2026-01-01T00:00:00Z') },
      ]),
    }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/internal/tenants' });
    expect(response.statusCode).toBe(200);
    expect(response.json().tenants).toHaveLength(1);
  });

  it('GET /api/internal/tenants/:id returns 404 when not found', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/get-client-detail.js', () => ({ getClientDetail: vi.fn(async () => null) }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/api/internal/tenants/${TENANT_ID}` });
    expect(response.statusCode).toBe(404);
  });

  it('AC1/AC2: GET /api/internal/tenants/:id returns branding: null for a fresh tenant', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/get-client-detail.js', () => ({
      getClientDetail: vi.fn(async () => ({
        id: TENANT_ID, name: 'Acme', slug: 'acme', isActive: true, createdAt: new Date(), branding: null, memberCount: 0,
      })),
    }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/api/internal/tenants/${TENANT_ID}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().branding).toBeNull();
  });

  it('PATCH /api/internal/tenants/:id updates the tenant', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/update-client.js', () => ({
      updateClient: vi.fn(async (_client, id, input) => ({ id, name: input.name ?? 'Acme', slug: 'acme', isActive: input.isActive ?? true })),
    }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'PATCH', url: `/api/internal/tenants/${TENANT_ID}`, payload: { isActive: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().isActive).toBe(false);
  });

  it('PATCH /api/internal/tenants/:id rejects an invalid tenant id with 400', async () => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PATCH', url: `/api/internal/tenants/${INVALID_ID}`, payload: { isActive: false } });
    expect(response.statusCode).toBe(400);
  });

  it.each([
    ['empty name', { name: '' }],
    ['non-boolean isActive', { isActive: 'yes' }],
  ])('PATCH /api/internal/tenants/:id rejects with 400: %s', async (_label, payload) => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PATCH', url: `/api/internal/tenants/${TENANT_ID}`, payload });
    expect(response.statusCode).toBe(400);
  });

  it('PATCH /api/internal/tenants/:id returns 404 when the tenant does not exist', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/update-client.js', () => ({ updateClient: vi.fn(async () => null) }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PATCH', url: `/api/internal/tenants/${TENANT_ID}`, payload: { isActive: false } });
    expect(response.statusCode).toBe(404);
  });

  it('AC2: POST .../branding creates a branding row (201) on a fresh tenant', async () => {
    mockAuth(true);
    mockTx();
    const createCustomerBranding = vi.fn(async (_client, input) => ({
      logoUrl: input.logoUrl, primaryColor: input.primaryColor, secondaryColor: input.secondaryColor,
    }));
    vi.doMock('../../src/modules/identity/create-customer-branding.js', () => ({ createCustomerBranding }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: `/api/internal/tenants/${TENANT_ID}/branding`,
      payload: { domain: 'acme.example.com', logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233' },
    });
    expect(response.statusCode).toBe(201);
    expect(createCustomerBranding).toHaveBeenCalledWith({}, {
      clientId: TENANT_ID, domain: 'acme.example.com',
      logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233', secondaryColor: null,
    });
  });

  it('POST .../branding returns 409 when a row already exists', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/create-customer-branding.js', () => ({
      createCustomerBranding: vi.fn(async () => {
        const err = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
        throw err;
      }),
    }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: `/api/internal/tenants/${TENANT_ID}/branding`,
      payload: { domain: 'acme.example.com', logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('POST .../branding rejects an invalid tenant id with 400', async () => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: `/api/internal/tenants/${INVALID_ID}/branding`,
      payload: { domain: 'acme.example.com', logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST .../branding propagates an unexpected (non-unique-violation) error', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/create-customer-branding.js', () => ({
      createCustomerBranding: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: `/api/internal/tenants/${TENANT_ID}/branding`,
      payload: { domain: 'acme.example.com', logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233' },
    });
    expect(response.statusCode).toBe(500);
  });

  it.each([
    ['missing domain', { logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233' }],
    ['invalid logoUrl', { domain: 'acme.example.com', logoUrl: 'not-a-url', primaryColor: '#112233' }],
    ['invalid primaryColor', { domain: 'acme.example.com', logoUrl: 'https://cdn.example.com/logo.png', primaryColor: 'red' }],
    ['invalid secondaryColor', { domain: 'acme.example.com', logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233', secondaryColor: 'blue' }],
  ])('POST .../branding rejects with 400: %s', async (_label, payload) => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'POST', url: `/api/internal/tenants/${TENANT_ID}/branding`, payload });
    expect(response.statusCode).toBe(400);
  });

  it('AC3: PATCH .../branding updates an existing branding row (200)', async () => {
    mockAuth(true);
    mockTx();
    const updateCustomerBranding = vi.fn(async () => ({
      found: true,
      branding: { logoUrl: 'https://cdn.example.com/new.png', primaryColor: '#445566', secondaryColor: null },
    }));
    vi.doMock('../../src/modules/identity/update-customer-branding.js', () => ({ updateCustomerBranding }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'PATCH', url: `/api/internal/tenants/${TENANT_ID}/branding`,
      payload: { logoUrl: 'https://cdn.example.com/new.png', primaryColor: '#445566' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ logoUrl: 'https://cdn.example.com/new.png', primaryColor: '#445566', secondaryColor: null });
    expect(updateCustomerBranding).toHaveBeenCalledWith({}, TENANT_ID, {
      logoUrl: 'https://cdn.example.com/new.png', primaryColor: '#445566', secondaryColor: null,
    });
  });

  it('PATCH .../branding returns 404 when no branding row exists yet', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/update-customer-branding.js', () => ({
      updateCustomerBranding: vi.fn(async () => ({ found: false })),
    }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'PATCH', url: `/api/internal/tenants/${TENANT_ID}/branding`,
      payload: { logoUrl: 'https://cdn.example.com/new.png', primaryColor: '#445566' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('PATCH .../branding rejects an invalid tenant id with 400', async () => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'PATCH', url: `/api/internal/tenants/${INVALID_ID}/branding`,
      payload: { logoUrl: 'https://cdn.example.com/new.png', primaryColor: '#445566' },
    });
    expect(response.statusCode).toBe(400);
  });

  it.each([
    ['invalid logoUrl', { logoUrl: 'not-a-url', primaryColor: '#445566' }],
    ['invalid primaryColor', { logoUrl: 'https://cdn.example.com/new.png', primaryColor: 'red' }],
    ['invalid secondaryColor', { logoUrl: 'https://cdn.example.com/new.png', primaryColor: '#445566', secondaryColor: 'blue' }],
  ])('PATCH .../branding rejects with 400: %s', async (_label, payload) => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PATCH', url: `/api/internal/tenants/${TENANT_ID}/branding`, payload });
    expect(response.statusCode).toBe(400);
  });

  it('GET .../members rejects an invalid tenant id with 400', async () => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/api/internal/tenants/${INVALID_ID}/members` });
    expect(response.statusCode).toBe(400);
  });

  it('AC4: POST .../members creates a membership and returns 201', async () => {
    mockAuth(true);
    mockTx();
    const createMembership = vi.fn(async () => ({ created: true, membershipId: MEMBERSHIP_ID, userId: 'user-1', isNewUser: true }));
    vi.doMock('../../src/modules/identity/create-membership.js', () => ({ createMembership }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: `/api/internal/tenants/${TENANT_ID}/members`,
      payload: { email: 'new@example.com', role: 'client_admin' },
    });
    expect(response.statusCode).toBe(201);
    expect(createMembership).toHaveBeenCalledWith({}, { clientId: TENANT_ID, email: 'new@example.com', fullName: null, role: 'client_admin' });
  });

  it('POST .../members returns 409 when already a member', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/create-membership.js', () => ({
      createMembership: vi.fn(async () => ({ created: false, reason: 'already_member' })),
    }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: `/api/internal/tenants/${TENANT_ID}/members`,
      payload: { email: 'existing@example.com', role: 'analyst' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('POST .../members rejects an invalid role with 400', async () => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: `/api/internal/tenants/${TENANT_ID}/members`,
      payload: { email: 'new@example.com', role: 'superadmin' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST .../members rejects an invalid tenant id with 400', async () => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: `/api/internal/tenants/${INVALID_ID}/members`,
      payload: { email: 'new@example.com', role: 'analyst' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST .../members rejects a missing email with 400', async () => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: `/api/internal/tenants/${TENANT_ID}/members`,
      payload: { role: 'analyst' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST .../members rejects a non-string fullName with 400', async () => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: `/api/internal/tenants/${TENANT_ID}/members`,
      payload: { email: 'new@example.com', role: 'analyst', fullName: 123 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('GET .../members lists members', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/list-tenant-members.js', () => ({
      listTenantMembers: vi.fn(async () => [
        { id: MEMBERSHIP_ID, userId: 'user-1', email: 'a@example.com', fullName: null, role: 'analyst', createdAt: new Date() },
      ]),
    }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/api/internal/tenants/${TENANT_ID}/members` });
    expect(response.statusCode).toBe(200);
    expect(response.json().members).toHaveLength(1);
  });

  it('DELETE .../members/:membershipId removes a member (204)', async () => {
    mockAuth(true);
    mockTx();
    const removeMembership = vi.fn(async () => ({ found: true }));
    vi.doMock('../../src/modules/identity/remove-membership.js', () => ({ removeMembership }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'DELETE', url: `/api/internal/tenants/${TENANT_ID}/members/${MEMBERSHIP_ID}` });
    expect(response.statusCode).toBe(204);
    expect(removeMembership).toHaveBeenCalledWith({}, TENANT_ID, MEMBERSHIP_ID);
  });

  it('DELETE .../members/:membershipId rejects an invalid id with 400', async () => {
    mockAuth(true);
    mockTx();
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'DELETE', url: `/api/internal/tenants/${INVALID_ID}/members/${MEMBERSHIP_ID}` });
    expect(response.statusCode).toBe(400);
  });

  it('DELETE .../members/:membershipId returns 404 when not found', async () => {
    mockAuth(true);
    mockTx();
    vi.doMock('../../src/modules/identity/remove-membership.js', () => ({ removeMembership: vi.fn(async () => ({ found: false })) }));
    const { registerTenantAdminRoutes } = await import('../../src/server/tenant-admin-routes.js');
    app = Fastify();
    await app.register(registerTenantAdminRoutes);
    await app.ready();

    const response = await app.inject({ method: 'DELETE', url: `/api/internal/tenants/${TENANT_ID}/members/${MEMBERSHIP_ID}` });
    expect(response.statusCode).toBe(404);
  });
});
