import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { buildApp } from '../../src/server/app.js';

function mockInternalAuth() {
  vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
    registerInternalAnalystAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
        request.tenantContext = { internal: true };
        request.actorUserId = 'analyst-1';
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

  it('requires authentication before returning the cross-client report', async () => {
    app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/portfolio/cross-client-recovery' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the cross-client portfolio buckets for an internal analyst', async () => {
    mockInternalAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const buckets = [
      { clientId: 'c1', clientName: 'Client One', currency: 'USD', claimed: '1000.0000', recovered: '600.0000', outstanding: '400.0000', writtenOff: '0.0000', denied: '0.0000', nullCurrencyRecovered: '0.0000', mismatchedCurrencyRecovered: '0.0000', reconciles: true },
    ];
    const getCrossClientPortfolioReport = vi.fn().mockResolvedValue(buckets);
    vi.doMock('../../src/modules/claims/get-cross-client-portfolio-report.js', () => ({ getCrossClientPortfolioReport }));
    const { registerPortfolioRoutes } = await import('../../src/server/portfolio-routes.js');
    app = Fastify();
    await app.register(registerPortfolioRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/portfolio/cross-client-recovery' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ buckets });
    expect(getCrossClientPortfolioReport).toHaveBeenCalledWith({});
  });

  it('returns an empty buckets array when the portfolio has no claims', async () => {
    mockInternalAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const getCrossClientPortfolioReport = vi.fn().mockResolvedValue([]);
    vi.doMock('../../src/modules/claims/get-cross-client-portfolio-report.js', () => ({ getCrossClientPortfolioReport }));
    const { registerPortfolioRoutes } = await import('../../src/server/portfolio-routes.js');
    app = Fastify();
    await app.register(registerPortfolioRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/portfolio/cross-client-recovery' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ buckets: [] });
  });
});
