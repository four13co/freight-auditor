import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { buildApp } from '../../src/server/app.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

function mockAuth() {
  vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
    registerTenantAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
        request.tenantContext = { clientIds: [CLIENT_ID] };
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

  async function setup(summary: unknown[] = []) {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const getClientRecoverySummary = vi.fn().mockResolvedValue(summary);
    vi.doMock('../../src/modules/claims/get-client-recovery-summary.js', () => ({ getClientRecoverySummary }));
    const { registerRecoveryReportRoutes } = await import('../../src/server/recovery-report-routes.js');
    app = Fastify();
    await app.register(registerRecoveryReportRoutes);
    await app.ready();
    return { getClientRecoverySummary };
  }

  it('requires authentication before returning a recovery report', async () => {
    app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/recovery-report' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the tenant-scoped recovery summary buckets', async () => {
    const buckets = [{ currency: 'USD', claimed: '500.0000', recovered: '200.0000', outstanding: '300.0000', writtenOff: '0.0000', denied: '0.0000', reconciles: true }];
    const { getClientRecoverySummary } = await setup(buckets);

    const response = await app!.inject({ method: 'GET', url: '/api/recovery-report' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ buckets });
    expect(getClientRecoverySummary).toHaveBeenCalledWith({}, CLIENT_ID);
  });

  it('returns an empty buckets array for a tenant with no claims', async () => {
    await setup([]);
    const response = await app!.inject({ method: 'GET', url: '/api/recovery-report' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ buckets: [] });
  });
});
