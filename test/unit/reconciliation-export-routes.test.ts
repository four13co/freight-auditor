import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { buildApp } from '../../src/server/app.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_USER_ID = '22222222-2222-4222-8222-222222222222';
const EXPORT_ID = '70000000-0000-4000-8000-000000000009';

function mockAuth() {
  vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
    registerTenantAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
        request.tenantContext = { clientIds: [CLIENT_ID] };
        request.actorUserId = ACTOR_USER_ID;
      });
    },
  }));
}

describe('reconciliation export routes', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
  });

  it('requires authentication before accepting an export request', async () => {
    app = buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/reconciliation-exports' });
    expect(response.statusCode).toBe(401);
  });

  it('requires authentication before returning export status', async () => {
    app = buildApp();
    const response = await app.inject({ method: 'GET', url: `/api/reconciliation-exports/${EXPORT_ID}` });
    expect(response.statusCode).toBe(401);
  });

  it('creates a fresh export request and returns 202 pending', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const requestReconciliationExport = vi.fn().mockResolvedValue({ exportId: EXPORT_ID, created: true });
    vi.doMock('../../src/modules/claims/reconciliation-export.js', () => ({
      requestReconciliationExport,
      getReconciliationExport: vi.fn(),
    }));
    const { registerReconciliationExportRoutes } = await import('../../src/server/reconciliation-export-routes.js');
    app = Fastify();
    await app.register(registerReconciliationExportRoutes);
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/api/reconciliation-exports' });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ exportId: EXPORT_ID, status: 'pending' });
    expect(requestReconciliationExport).toHaveBeenCalledWith({}, expect.objectContaining({ clientId: CLIENT_ID }));
  });

  it('returns 200 (not 202) when an idempotent retry finds the existing request', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const requestReconciliationExport = vi.fn().mockResolvedValue({ exportId: EXPORT_ID, created: false });
    vi.doMock('../../src/modules/claims/reconciliation-export.js', () => ({
      requestReconciliationExport,
      getReconciliationExport: vi.fn(),
    }));
    const { registerReconciliationExportRoutes } = await import('../../src/server/reconciliation-export-routes.js');
    app = Fastify();
    await app.register(registerReconciliationExportRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reconciliation-exports',
      payload: { idempotencyKey: 'retry-key' },
    });
    expect(response.statusCode).toBe(200);
    expect(requestReconciliationExport).toHaveBeenCalledWith({}, { clientId: CLIENT_ID, idempotencyKey: 'retry-key' });
  });

  it('rejects a non-string idempotencyKey with 400', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerReconciliationExportRoutes } = await import('../../src/server/reconciliation-export-routes.js');
    app = Fastify();
    await app.register(registerReconciliationExportRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reconciliation-exports',
      payload: { idempotencyKey: 12345 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed export id with 400', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerReconciliationExportRoutes } = await import('../../src/server/reconciliation-export-routes.js');
    app = Fastify();
    await app.register(registerReconciliationExportRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/reconciliation-exports/not-a-uuid' });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for an export that does not exist', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const getReconciliationExport = vi.fn().mockResolvedValue(null);
    vi.doMock('../../src/modules/claims/reconciliation-export.js', () => ({
      requestReconciliationExport: vi.fn(),
      getReconciliationExport,
    }));
    const { registerReconciliationExportRoutes } = await import('../../src/server/reconciliation-export-routes.js');
    app = Fastify();
    await app.register(registerReconciliationExportRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/api/reconciliation-exports/${EXPORT_ID}` });
    expect(response.statusCode).toBe(404);
  });

  it('returns a pending export status with no result yet', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const row = { id: EXPORT_ID, status: 'pending', result: null, error: null, requestedAt: '2026-08-01T00:00:00.000Z', completedAt: null };
    const getReconciliationExport = vi.fn().mockResolvedValue(row);
    vi.doMock('../../src/modules/claims/reconciliation-export.js', () => ({
      requestReconciliationExport: vi.fn(),
      getReconciliationExport,
    }));
    const { registerReconciliationExportRoutes } = await import('../../src/server/reconciliation-export-routes.js');
    app = Fastify();
    await app.register(registerReconciliationExportRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/api/reconciliation-exports/${EXPORT_ID}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(row);
  });

  it('returns a completed export status with its result', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const row = {
      id: EXPORT_ID,
      status: 'completed',
      result: [{ currency: 'USD', claimed: '100.0000', recovered: '100.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '0.0000', reconciles: true }],
      error: null,
      requestedAt: '2026-08-01T00:00:00.000Z',
      completedAt: '2026-08-01T00:01:00.000Z',
    };
    const getReconciliationExport = vi.fn().mockResolvedValue(row);
    vi.doMock('../../src/modules/claims/reconciliation-export.js', () => ({
      requestReconciliationExport: vi.fn(),
      getReconciliationExport,
    }));
    const { registerReconciliationExportRoutes } = await import('../../src/server/reconciliation-export-routes.js');
    app = Fastify();
    await app.register(registerReconciliationExportRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/api/reconciliation-exports/${EXPORT_ID}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(row);
  });
});
