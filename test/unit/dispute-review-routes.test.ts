import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { buildApp } from '../../src/server/app.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_USER_ID = '22222222-2222-4222-8222-222222222222';
const DISPUTE_ID = '70000000-0000-4000-8000-000000000001';

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

describe('dispute review routes', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
  });

  it('requires authentication before returning dispute detail', async () => {
    app = buildApp();
    const response = await app.inject({ method: 'GET', url: `/api/disputes/${DISPUTE_ID}` });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a malformed dispute id with 400', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
    app = Fastify();
    await app.register(registerDisputeReviewRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/disputes/not-a-uuid' });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for a dispute that does not exist', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const getDisputeDetail = vi.fn().mockResolvedValue(null);
    vi.doMock('../../src/modules/disputes/get-dispute-detail.js', () => ({ getDisputeDetail }));
    const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
    app = Fastify();
    await app.register(registerDisputeReviewRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/api/disputes/${DISPUTE_ID}` });
    expect(response.statusCode).toBe(404);
  });

  it('returns the dispute detail on success', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const detail = { id: DISPUTE_ID, carrierId: 'c1', status: 'draft', amountClaimed: '500.0000', currency: 'USD', createdAt: '2026-08-01T00:00:00.000Z', lines: [] };
    const getDisputeDetail = vi.fn().mockResolvedValue(detail);
    vi.doMock('../../src/modules/disputes/get-dispute-detail.js', () => ({ getDisputeDetail }));
    const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
    app = Fastify();
    await app.register(registerDisputeReviewRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `/api/disputes/${DISPUTE_ID}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(detail);
  });

  it('approves a draft dispute and returns its new status', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const approveDispute = vi.fn().mockResolvedValue({ found: true });
    vi.doMock('../../src/modules/disputes/approve-dispute.js', () => ({ approveDispute }));
    const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
    app = Fastify();
    await app.register(registerDisputeReviewRoutes);
    await app.ready();

    const response = await app.inject({ method: 'POST', url: `/api/disputes/${DISPUTE_ID}/approve` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ disputeId: DISPUTE_ID, status: 'sent' });
    expect(approveDispute).toHaveBeenCalledWith({}, DISPUTE_ID, ACTOR_USER_ID);
  });

  it('returns 409 when the dispute is not found or not draft', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const approveDispute = vi.fn().mockResolvedValue({ found: false });
    vi.doMock('../../src/modules/disputes/approve-dispute.js', () => ({ approveDispute }));
    const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
    app = Fastify();
    await app.register(registerDisputeReviewRoutes);
    await app.ready();

    const response = await app.inject({ method: 'POST', url: `/api/disputes/${DISPUTE_ID}/approve` });
    expect(response.statusCode).toBe(409);
  });
});
