import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { buildApp } from '../../src/server/app.js';

const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '22222222-2222-4222-8222-222222222222';

function mockAuthAs(clientId: string) {
  vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
    registerTenantAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
        request.tenantContext = { clientIds: [clientId] };
      });
    },
  }));
}

describe('portal routes', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
  });

  async function setup(clientId: string, overviewByClientId: Record<string, { clientName: string } | null>) {
    mockAuthAs(clientId);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const getPortalOverview = vi.fn(async (_client: unknown, id: string) => overviewByClientId[id] ?? null);
    vi.doMock('../../src/modules/portal/get-portal-overview.js', () => ({ getPortalOverview }));
    const { registerPortalRoutes } = await import('../../src/server/portal-routes.js');
    app = Fastify();
    await app.register(registerPortalRoutes);
    await app.ready();
    return { getPortalOverview };
  }

  it('requires authentication before returning the portal overview', async () => {
    app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/portal/overview' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the tenant-scoped overview', async () => {
    await setup(CLIENT_A, { [CLIENT_A]: { clientName: 'Acme Bank' } });
    const response = await app!.inject({ method: 'GET', url: '/api/portal/overview' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ clientName: 'Acme Bank' });
  });

  it('returns 404 when the resolved client has no matching row', async () => {
    await setup(CLIENT_A, {});
    const response = await app!.inject({ method: 'GET', url: '/api/portal/overview' });
    expect(response.statusCode).toBe(404);
  });

  const OVERVIEWS = { [CLIENT_A]: { clientName: 'Acme Bank' }, [CLIENT_B]: { clientName: 'Other Bank' } };

  it('resolves client A to only its own overview -- the route accepts no client-suppliable id parameter', async () => {
    await setup(CLIENT_A, OVERVIEWS);
    const response = await app!.inject({ method: 'GET', url: '/api/portal/overview' });
    expect(response.json()).toEqual({ clientName: 'Acme Bank' });
  });

  it('resolves client B to only its own overview, never client A\'s', async () => {
    await setup(CLIENT_B, OVERVIEWS);
    const response = await app!.inject({ method: 'GET', url: '/api/portal/overview' });
    expect(response.json()).toEqual({ clientName: 'Other Bank' });
  });
});
