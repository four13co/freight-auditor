import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { buildApp } from '../../src/server/app.js';

function mockAuth() {
  vi.doMock('../../src/modules/findings/internal-analyst-auth.js', () => ({
    registerInternalAnalystAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
        request.tenantContext = { internal: true };
      });
    },
  }));
}

/**
 * 86e37r2rt AC5: GET /api/invoices is gated the same way GET
 * /api/portfolio/cross-client-recovery is (registerInternalAnalystAuthPreHandler,
 * not the shared registerTenantAuthPreHandler) -- a non-internal (portal)
 * session must be rejected, matching portfolio-routes.test.ts's own structure.
 */
describe('invoices routes', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
  });

  it('AC5: requires internal-analyst authorization before returning the invoice list', async () => {
    app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/invoices' });
    expect(response.statusCode).toBe(401);
  });

  it('AC5: does not grant access via the shared tenant-auth preHandler -- a single-client (portal) context alone is not internal', async () => {
    // The real (unmocked) app wires registerInternalAnalystAuthPreHandler, not
    // registerTenantAuthPreHandler, onto this route -- so even a request shaped
    // like a valid single-tenant dev-header request (which the shared resolver
    // would accept on every other tenant-scoped route) must still be rejected.
    app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/invoices',
      headers: { 'x-client-id': '11111111-1111-4111-8111-111111111111', 'x-user-id': '22222222-2222-4222-8222-222222222222' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('AC1: returns { invoices } on success', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const invoices = [
      { id: 'inv-1', invoiceNumber: 'INV-1', carrierName: 'ACME', transactionSet: '210', status: 'ingested', currency: 'USD', createdAt: '2026-01-01T00:00:00Z', billedTotal: '1500.0000' },
    ];
    const listInvoices = vi.fn().mockResolvedValue(invoices);
    vi.doMock('../../src/modules/invoices/list-invoices.js', () => ({ listInvoices }));
    const { registerInvoicesRoutes } = await import('../../src/server/invoices-routes.js');
    app = Fastify();
    await app.register(registerInvoicesRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/invoices' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ invoices });
    expect(listInvoices).toHaveBeenCalledWith({}, { carrier: undefined, status: undefined });
  });

  it('AC2: passes carrier and status query params through to listInvoices', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const listInvoices = vi.fn().mockResolvedValue([]);
    vi.doMock('../../src/modules/invoices/list-invoices.js', () => ({ listInvoices }));
    const { registerInvoicesRoutes } = await import('../../src/server/invoices-routes.js');
    app = Fastify();
    await app.register(registerInvoicesRoutes);
    await app.ready();

    await app.inject({ method: 'GET', url: '/api/invoices?carrier=ACME&status=ingested' });

    expect(listInvoices).toHaveBeenCalledWith({}, { carrier: 'ACME', status: 'ingested' });
  });
});
