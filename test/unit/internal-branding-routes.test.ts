import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_USER_ID = '22222222-2222-4222-8222-222222222222';

function mockAuth(role: string = 'analyst') {
  vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
    registerTenantAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
        request.tenantContext = { clientIds: [CLIENT_ID] };
        request.actorUserId = ACTOR_USER_ID;
        request.actorRole = role;
      });
    },
    registerAnalystOnlyPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.actorRole !== 'analyst' && request.actorRole !== 'lead') {
          await reply.code(403).send({ error: 'internal analyst role required' });
        }
      });
    },
  }));
}

const VALID_BODY = { logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233', secondaryColor: '#445566' };

/**
 * 86e37r2t4: this item's own task body originally named
 * registerInternalAnalystAuthPreHandler for this route -- the same
 * cross-tenant-leaking resolver 86e37r2rt's first attempt (PR #372) shipped
 * for the sibling Invoices item. This suite proves the fix: a portal
 * (client_viewer/client_admin) session is rejected, an analyst/lead session
 * is scoped to its own tenant via registerTenantAuthPreHandler, and an
 * unauthenticated request 401s.
 */
describe('PATCH /api/internal/branding', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
    vi.doUnmock('../../src/modules/identity/update-customer-branding.js');
    vi.doUnmock('../../src/db/tenant-context.js');
  });

  it('requires authentication', async () => {
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();
    const response = await app.inject({ method: 'PATCH', url: '/api/internal/branding', payload: VALID_BODY });
    expect(response.statusCode).toBe(401);
  });

  it.each(['client_viewer', 'client_admin'])('rejects %s (portal session) with 403', async (role) => {
    mockAuth(role);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerInternalBrandingRoutes } = await import('../../src/server/internal-branding-routes.js');
    app = Fastify();
    await app.register(registerInternalBrandingRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PATCH', url: '/api/internal/branding', payload: VALID_BODY });
    expect(response.statusCode).toBe(403);
  });

  it('AC1: an analyst updates their own tenant\'s branding, scoped via the tenant context', async () => {
    mockAuth('analyst');
    const updateCustomerBranding = vi.fn().mockResolvedValue({
      found: true,
      branding: { logoUrl: VALID_BODY.logoUrl, primaryColor: VALID_BODY.primaryColor, secondaryColor: VALID_BODY.secondaryColor },
    });
    vi.doMock('../../src/modules/identity/update-customer-branding.js', () => ({ updateCustomerBranding }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerInternalBrandingRoutes } = await import('../../src/server/internal-branding-routes.js');
    app = Fastify();
    await app.register(registerInternalBrandingRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PATCH', url: '/api/internal/branding', payload: VALID_BODY });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      logoUrl: VALID_BODY.logoUrl, primaryColor: VALID_BODY.primaryColor, secondaryColor: VALID_BODY.secondaryColor,
    });
    expect(updateCustomerBranding).toHaveBeenCalledWith({}, CLIENT_ID, {
      logoUrl: VALID_BODY.logoUrl, primaryColor: VALID_BODY.primaryColor, secondaryColor: VALID_BODY.secondaryColor,
    });
  });

  it('a lead is also allowed through', async () => {
    mockAuth('lead');
    const updateCustomerBranding = vi.fn().mockResolvedValue({
      found: true,
      branding: { logoUrl: VALID_BODY.logoUrl, primaryColor: VALID_BODY.primaryColor, secondaryColor: null },
    });
    vi.doMock('../../src/modules/identity/update-customer-branding.js', () => ({ updateCustomerBranding }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerInternalBrandingRoutes } = await import('../../src/server/internal-branding-routes.js');
    app = Fastify();
    await app.register(registerInternalBrandingRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PATCH', url: '/api/internal/branding', payload: { logoUrl: VALID_BODY.logoUrl, primaryColor: VALID_BODY.primaryColor } });
    expect(response.statusCode).toBe(200);
  });

  it('treats an omitted secondaryColor as null', async () => {
    mockAuth('analyst');
    const updateCustomerBranding = vi.fn().mockResolvedValue({
      found: true,
      branding: { logoUrl: VALID_BODY.logoUrl, primaryColor: VALID_BODY.primaryColor, secondaryColor: null },
    });
    vi.doMock('../../src/modules/identity/update-customer-branding.js', () => ({ updateCustomerBranding }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerInternalBrandingRoutes } = await import('../../src/server/internal-branding-routes.js');
    app = Fastify();
    await app.register(registerInternalBrandingRoutes);
    await app.ready();

    await app.inject({ method: 'PATCH', url: '/api/internal/branding', payload: { logoUrl: VALID_BODY.logoUrl, primaryColor: VALID_BODY.primaryColor } });
    expect(updateCustomerBranding).toHaveBeenCalledWith({}, CLIENT_ID, {
      logoUrl: VALID_BODY.logoUrl, primaryColor: VALID_BODY.primaryColor, secondaryColor: null,
    });
  });

  it('returns 404 when the tenant has no branding row yet', async () => {
    mockAuth('analyst');
    const updateCustomerBranding = vi.fn().mockResolvedValue({ found: false });
    vi.doMock('../../src/modules/identity/update-customer-branding.js', () => ({ updateCustomerBranding }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerInternalBrandingRoutes } = await import('../../src/server/internal-branding-routes.js');
    app = Fastify();
    await app.register(registerInternalBrandingRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PATCH', url: '/api/internal/branding', payload: VALID_BODY });
    expect(response.statusCode).toBe(404);
  });

  it.each([
    ['missing logoUrl', { primaryColor: '#112233' }],
    ['non-URL logoUrl', { logoUrl: 'not-a-url', primaryColor: '#112233' }],
    ['ftp logoUrl (not http/https)', { logoUrl: 'ftp://example.com/logo.png', primaryColor: '#112233' }],
    ['missing primaryColor', { logoUrl: 'https://cdn.example.com/logo.png' }],
    ['invalid primaryColor (not hex)', { logoUrl: 'https://cdn.example.com/logo.png', primaryColor: 'red' }],
    ['invalid primaryColor (3-digit hex)', { logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#123' }],
    ['invalid secondaryColor', { logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233', secondaryColor: 'blue' }],
  ])('rejects with 400: %s', async (_label, payload) => {
    mockAuth('analyst');
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerInternalBrandingRoutes } = await import('../../src/server/internal-branding-routes.js');
    app = Fastify();
    await app.register(registerInternalBrandingRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PATCH', url: '/api/internal/branding', payload });
    expect(response.statusCode).toBe(400);
  });

  it('accepts an explicit null secondaryColor', async () => {
    mockAuth('analyst');
    const updateCustomerBranding = vi.fn().mockResolvedValue({
      found: true,
      branding: { logoUrl: VALID_BODY.logoUrl, primaryColor: VALID_BODY.primaryColor, secondaryColor: null },
    });
    vi.doMock('../../src/modules/identity/update-customer-branding.js', () => ({ updateCustomerBranding }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerInternalBrandingRoutes } = await import('../../src/server/internal-branding-routes.js');
    app = Fastify();
    await app.register(registerInternalBrandingRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'PATCH', url: '/api/internal/branding',
      payload: { logoUrl: VALID_BODY.logoUrl, primaryColor: VALID_BODY.primaryColor, secondaryColor: null },
    });
    expect(response.statusCode).toBe(200);
  });
});
