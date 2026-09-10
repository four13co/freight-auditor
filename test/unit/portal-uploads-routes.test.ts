import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Request-level unit coverage of /api/portal/invoice-drafts* via Fastify's
 * .inject(), with db/tenant-context AND client-admin-auth mocked so this
 * runs with no live Postgres -- same pattern as invoice-drafts-routes.test.ts
 * (validation) and portal-admin-routes.test.ts (auth-gating). Complements
 * test/db/portal-uploads-routes.db.test.ts, which covers the same routes
 * against a real DB (real createInvoiceDraft/confirmInvoiceDraft/
 * rejectInvoiceDraft, real carrier matching, the client_viewer-403... -> 401
 * proof against the actual registered preHandler).
 *
 * client-admin-auth.test.ts already proves resolveClientAdminContext's own
 * role logic exhaustively; this file assumes that and only proves how THIS
 * route registration composes/consumes it, plus its own request validation.
 */
describe('portal-uploads-routes (unit, mocked withTenantTx + auth)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/identity/client-admin-auth.js');
  });

  async function buildAuthorizedApp(withTenantTx = vi.fn()) {
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    vi.doMock('../../src/modules/identity/client-admin-auth.js', () => ({
      registerClientAdminAuthPreHandler: async (routes: FastifyInstance) => {
        routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
          request.tenantContext = { clientIds: ['11111111-1111-1111-1111-111111111111'], internal: false };
        });
      },
    }));
    const { registerPortalUploadsRoutes } = await import('../../src/server/portal-uploads-routes.js');
    app = Fastify();
    await app.register(registerPortalUploadsRoutes());
    await app.ready();
    return withTenantTx;
  }

  function mockDenied() {
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    vi.doMock('../../src/modules/identity/client-admin-auth.js', () => ({
      registerClientAdminAuthPreHandler: async (routes: FastifyInstance) => {
        routes.addHook('preHandler', async (_request: FastifyRequest, reply: FastifyReply) => {
          await reply.code(401).send({ error: 'unauthorized' });
        });
      },
    }));
  }

  it('rejects a non-client_admin caller (e.g. client_viewer) with 401, never reaching the handler', async () => {
    mockDenied();
    const { registerPortalUploadsRoutes } = await import('../../src/server/portal-uploads-routes.js');
    app = Fastify();
    await app.register(registerPortalUploadsRoutes());
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/portal/invoice-drafts',
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-1.4 not a real pdf'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an empty body with 400 before opening a tenant transaction', async () => {
    const withTenantTx = await buildAuthorizedApp();
    const res = await app!.inject({
      method: 'POST',
      url: '/api/portal/invoice-drafts',
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.alloc(0),
    });
    expect(res.statusCode).toBe(400);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects malformed contractVersionId on confirm before opening a tenant transaction', async () => {
    const withTenantTx = await buildAuthorizedApp();
    const response = await app!.inject({
      method: 'POST',
      url: '/api/portal/invoice-drafts/22222222-2222-2222-2222-222222222222/confirm',
      payload: { contractVersionId: 'not-a-uuid' },
    });
    expect(response.statusCode).toBe(400);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects a malformed charge shape on confirm before persistence', async () => {
    const withTenantTx = await buildAuthorizedApp();
    const response = await app!.inject({
      method: 'POST',
      url: '/api/portal/invoice-drafts/22222222-2222-2222-2222-222222222222/confirm',
      payload: {
        correctedPayload: {
          transactionSet: 'PDF',
          parserVersion: 'pdf-llm-v1',
          charges: [{ amount: { dollars: 10 }, currency: 'USD' }],
          quarantinedCodes: [],
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects an invalid draft id on reject with 400', async () => {
    const withTenantTx = await buildAuthorizedApp();
    const response = await app!.inject({ method: 'POST', url: '/api/portal/invoice-drafts/not-a-uuid/reject' });
    expect(response.statusCode).toBe(400);
    expect(withTenantTx).not.toHaveBeenCalled();
  });
});
