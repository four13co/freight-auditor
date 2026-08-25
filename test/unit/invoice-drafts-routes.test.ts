import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('invoice-drafts request validation', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
  });

  async function buildAuthorizedApp(withTenantTx = vi.fn()) {
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
      registerTenantAuthPreHandler: async (routes: FastifyInstance) => {
        routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
          request.tenantContext = { clientIds: ['11111111-1111-1111-1111-111111111111'], internal: false };
        });
      },
    }));
    const { registerInvoiceDraftsRoutes } = await import('../../src/server/invoice-drafts-routes.js');
    app = Fastify();
    await app.register(registerInvoiceDraftsRoutes);
    await app.ready();
    return withTenantTx;
  }

  it('rejects malformed contractVersionId before opening a tenant transaction', async () => {
    const withTenantTx = await buildAuthorizedApp();
    const response = await app!.inject({
      method: 'POST',
      url: '/api/invoice-drafts/22222222-2222-2222-2222-222222222222/confirm',
      payload: { contractVersionId: 'not-a-uuid' },
    });
    expect(response.statusCode).toBe(400);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects a forged parserVersion in correctedPayload before persistence', async () => {
    const withTenantTx = await buildAuthorizedApp();
    const response = await app!.inject({
      method: 'POST',
      url: '/api/invoice-drafts/22222222-2222-2222-2222-222222222222/confirm',
      payload: {
        correctedPayload: {
          transactionSet: 'PDF',
          parserVersion: 'forged-client-version',
          charges: [{ quarantined: false, amount: '10.00', currency: 'USD' }],
          quarantinedCodes: [],
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects a malformed charge shape before persistence', async () => {
    const withTenantTx = await buildAuthorizedApp();
    const response = await app!.inject({
      method: 'POST',
      url: '/api/invoice-drafts/22222222-2222-2222-2222-222222222222/confirm',
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
});
