import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { buildApp } from '../../src/server/app.js';

function mockAuth(clientId: string) {
  vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
    registerTenantAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
        request.tenantContext = { clientIds: [clientId], internal: false };
      });
    },
  }));
}

describe('recovery report routes', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
  });

  it('requires tenant authorization before returning the recovery report', async () => {
    app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/portfolio/recovery-report' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the tenant-scoped reconciliation buckets on success', async () => {
    const clientId = '11111111-1111-4111-8111-111111111111';
    mockAuth(clientId);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const buckets = [
      { currency: 'USD', claimed: '500.0000', recovered: '200.0000', outstanding: '300.0000', writtenOff: '0.0000', denied: '0.0000', nullCurrencyRecovered: '0.0000', mismatchedCurrencyRecovered: '0.0000', reconciles: true },
    ];
    const getPortfolioReconciliation = vi.fn().mockResolvedValue(buckets);
    vi.doMock('../../src/modules/claims/get-portfolio-reconciliation.js', () => ({ getPortfolioReconciliation }));
    const { registerRecoveryReportRoutes } = await import('../../src/server/recovery-report-routes.js');
    app = Fastify();
    await app.register(registerRecoveryReportRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/portfolio/recovery-report' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ buckets });
    expect(getPortfolioReconciliation).toHaveBeenCalledWith({}, { clientId });
  });

  it('returns an empty buckets array when the tenant has no claims', async () => {
    const clientId = '22222222-2222-4222-8222-222222222222';
    mockAuth(clientId);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const getPortfolioReconciliation = vi.fn().mockResolvedValue([]);
    vi.doMock('../../src/modules/claims/get-portfolio-reconciliation.js', () => ({ getPortfolioReconciliation }));
    const { registerRecoveryReportRoutes } = await import('../../src/server/recovery-report-routes.js');
    app = Fastify();
    await app.register(registerRecoveryReportRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/portfolio/recovery-report' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ buckets: [] });
  });
});
