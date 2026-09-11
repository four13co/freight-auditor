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

/**
 * 86e37r2rt: requeued after PR #372 (closed on review) used
 * registerInternalAnalystAuthPreHandler -- a resolver deliberately scoped to
 * NO clientIds at all (cross-client by design), which meant every tenant's
 * invoices leaked into every caller regardless of who asked. This suite
 * proves the fix: a portal (client_viewer/client_admin) session is rejected,
 * an analyst/lead session is scoped to its own tenant via
 * registerTenantAuthPreHandler, and an unauthenticated request 401s.
 */
describe('GET /api/invoices', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
    vi.doUnmock('../../src/modules/invoices/list-invoices.js');
    vi.doUnmock('../../src/db/tenant-context.js');
  });

  it('requires authentication', async () => {
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/invoices' });
    expect(response.statusCode).toBe(401);
  });

  it.each(['client_viewer', 'client_admin'])('rejects %s (portal session) with 403', async (role) => {
    mockAuth(role);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerInvoicesRoutes } = await import('../../src/server/invoices-routes.js');
    app = Fastify();
    await app.register(registerInvoicesRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/invoices' });
    expect(response.statusCode).toBe(403);
  });

  it('allows an analyst through, scoped via the tenant context (not a cross-client resolver)', async () => {
    mockAuth('analyst');
    const listInvoices = vi.fn().mockResolvedValue([
      { id: 'inv-1', invoiceNumber: 'INV-1', carrierName: 'Acme', transactionSet: '210', status: 'ingested', currency: 'USD', createdAt: new Date('2026-01-01'), billedTotal: '100.0000' },
    ]);
    vi.doMock('../../src/modules/invoices/list-invoices.js', () => ({ listInvoices }));
    let capturedCtx: unknown;
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantReadTx: vi.fn(async (ctx, fn) => {
        capturedCtx = ctx;
        return fn({});
      }),
    }));
    const { registerInvoicesRoutes } = await import('../../src/server/invoices-routes.js');
    app = Fastify();
    await app.register(registerInvoicesRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/invoices' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      invoices: [
        { id: 'inv-1', invoiceNumber: 'INV-1', carrierName: 'Acme', transactionSet: '210', status: 'ingested', currency: 'USD', createdAt: '2026-01-01T00:00:00.000Z', billedTotal: '100.0000' },
      ],
    });
    expect(capturedCtx).toEqual({ clientIds: [CLIENT_ID] });
    expect(listInvoices).toHaveBeenCalledWith({}, { carrier: undefined, status: undefined, limit: 50, offset: undefined });
  });

  it('a lead is also allowed through', async () => {
    mockAuth('lead');
    const listInvoices = vi.fn().mockResolvedValue([]);
    vi.doMock('../../src/modules/invoices/list-invoices.js', () => ({ listInvoices }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerInvoicesRoutes } = await import('../../src/server/invoices-routes.js');
    app = Fastify();
    await app.register(registerInvoicesRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/invoices' });
    expect(response.statusCode).toBe(200);
  });

  it('passes carrier and status filters through to listInvoices', async () => {
    mockAuth('analyst');
    const listInvoices = vi.fn().mockResolvedValue([]);
    vi.doMock('../../src/modules/invoices/list-invoices.js', () => ({ listInvoices }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerInvoicesRoutes } = await import('../../src/server/invoices-routes.js');
    app = Fastify();
    await app.register(registerInvoicesRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/invoices?carrier=Acme&status=ingested' });
    expect(response.statusCode).toBe(200);
    expect(listInvoices).toHaveBeenCalledWith({}, { carrier: 'Acme', status: 'ingested', limit: 50, offset: undefined });
  });

  it('rejects an invalid limit with 400', async () => {
    mockAuth('analyst');
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerInvoicesRoutes } = await import('../../src/server/invoices-routes.js');
    app = Fastify();
    await app.register(registerInvoicesRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/invoices?limit=0' });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a negative offset with 400', async () => {
    mockAuth('analyst');
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerInvoicesRoutes } = await import('../../src/server/invoices-routes.js');
    app = Fastify();
    await app.register(registerInvoicesRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/invoices?offset=-1' });
    expect(response.statusCode).toBe(400);
  });
});
