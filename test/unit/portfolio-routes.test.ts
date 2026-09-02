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

describe('portfolio routes', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
  });

  it('requires internal-analyst authorization before returning the portfolio report', async () => {
    app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/portfolio/cross-client-recovery' });
    expect(response.statusCode).toBe(401);
  });

  it('does not grant access via the shared tenant-auth preHandler -- a single-client context alone is not internal', async () => {
    // The real (unmocked) app wires registerInternalAnalystAuthPreHandler, not
    // registerTenantAuthPreHandler, onto this route -- so even a request shaped
    // like a valid single-tenant dev-header request (which the shared resolver
    // WOULD accept on every other route) must still be rejected here.
    app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/portfolio/cross-client-recovery',
      headers: { 'x-client-id': '11111111-1111-4111-8111-111111111111', 'x-user-id': '22222222-2222-4222-8222-222222222222' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns the cross-client portfolio buckets on success', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const buckets = [
      { clientId: 'c1', clientName: 'Client A', currency: 'USD', claimed: '500.0000', recovered: '200.0000', outstanding: '300.0000', writtenOff: '0.0000', denied: '0.0000', nullCurrencyRecovered: '0.0000', mismatchedCurrencyRecovered: '0.0000', reconciles: true },
    ];
    const getCrossClientPortfolio = vi.fn().mockResolvedValue(buckets);
    vi.doMock('../../src/modules/claims/get-cross-client-portfolio.js', () => ({ getCrossClientPortfolio }));
    const { registerPortfolioRoutes } = await import('../../src/server/portfolio-routes.js');
    app = Fastify();
    await app.register(registerPortfolioRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/portfolio/cross-client-recovery' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ buckets });
    expect(getCrossClientPortfolio).toHaveBeenCalledWith({});
  });

  it('returns an empty buckets array when there are no claims anywhere', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const getCrossClientPortfolio = vi.fn().mockResolvedValue([]);
    vi.doMock('../../src/modules/claims/get-cross-client-portfolio.js', () => ({ getCrossClientPortfolio }));
    const { registerPortfolioRoutes } = await import('../../src/server/portfolio-routes.js');
    app = Fastify();
    await app.register(registerPortfolioRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/portfolio/cross-client-recovery' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ buckets: [] });
  });
});
