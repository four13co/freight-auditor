import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Request-level unit coverage of GET /api/claims and GET /api/claims/:id
 * via Fastify's .inject(), with db/tenant-context AND the tenant-auth
 * preHandler mocked so this runs with no live Postgres -- same pattern as
 * findings-endpoint.test.ts. Complements
 * test/db/claim-recovery-endpoint.db.test.ts, which covers the same routes
 * against a real DB.
 */
function mockTenantAuth(resolvedContext: unknown) {
  vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
    resolveAuthorizedTenantContext: vi.fn().mockResolvedValue(resolvedContext),
    registerTenantAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!resolvedContext) {
          await reply.code(401).send({ error: 'unauthorized' });
          return;
        }
        request.tenantContext = resolvedContext as FastifyRequest['tenantContext'];
      });
    },
  }));
}

describe('claim + recovery APIs (unit, mocked withTenantTx + tenant-auth)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
  });

  function mockAuthorized() {
    mockTenantAuth({ clientIds: ['client-abc'], internal: false });
  }

  it('returns { claims } for an authorized list request', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/claims/list-claims.js', () => ({
      listClaims: vi.fn().mockResolvedValue([{ id: 'c1', status: 'open' }]),
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/claims', headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ claims: [{ id: 'c1', status: 'open' }] });
  });

  it('rejects an unauthenticated list request with 401', async () => {
    mockTenantAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/claims' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects limit above the max with 400 without calling listClaims', async () => {
    mockAuthorized();
    const listClaims = vi.fn();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/claims/list-claims.js', () => ({ listClaims }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/claims?limit=9999', headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' } });
    expect(res.statusCode).toBe(400);
    expect(listClaims).not.toHaveBeenCalled();
  });

  it('rejects a negative offset with 400', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/claims/list-claims.js', () => ({ listClaims: vi.fn() }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/claims?offset=-1', headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns claim detail for a valid id', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/claims/get-claim-detail.js', () => ({
      getClaimDetail: vi.fn().mockResolvedValue({ id: '10000000-0000-4000-8000-000000000001', recoveryEvents: [] }),
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'GET', url: '/api/claims/10000000-0000-4000-8000-000000000001',
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('10000000-0000-4000-8000-000000000001');
  });

  it('rejects a malformed claim id with 400', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/claims/not-a-uuid', headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when getClaimDetail resolves null', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/claims/get-claim-detail.js', () => ({
      getClaimDetail: vi.fn().mockResolvedValue(null),
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'GET', url: '/api/claims/10000000-0000-4000-8000-000000000001',
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
    });
    expect(res.statusCode).toBe(404);
  });
});
