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

  describe('P4.C.9: response transitions', () => {
    it('accepts a dispute and returns its new status', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const acceptDispute = vi.fn().mockResolvedValue({ found: true });
      vi.doMock('../../src/modules/disputes/resolve-dispute.js', () => ({
        acceptDispute, rejectDispute: vi.fn(), partiallyAcceptDispute: vi.fn(), closeDispute: vi.fn(),
        DisputeTransitionError: class extends Error { code = 'ACCEPTED_AMOUNT_EXCEEDS_CLAIMED'; },
      }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({ method: 'POST', url: `/api/disputes/${DISPUTE_ID}/accept` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ disputeId: DISPUTE_ID, status: 'accepted' });
      expect(acceptDispute).toHaveBeenCalledWith({}, DISPUTE_ID, ACTOR_USER_ID);
    });

    it('returns 409 accepting a dispute that is not found or not awaiting response', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      vi.doMock('../../src/modules/disputes/resolve-dispute.js', () => ({
        acceptDispute: vi.fn().mockResolvedValue({ found: false }),
        rejectDispute: vi.fn(), partiallyAcceptDispute: vi.fn(), closeDispute: vi.fn(),
        DisputeTransitionError: class extends Error { code = 'ACCEPTED_AMOUNT_EXCEEDS_CLAIMED'; },
      }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({ method: 'POST', url: `/api/disputes/${DISPUTE_ID}/accept` });
      expect(response.statusCode).toBe(409);
    });

    it('rejects an accept request with a malformed dispute id', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({ method: 'POST', url: '/api/disputes/not-a-uuid/accept' });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a dispute and returns its new status', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const rejectDispute = vi.fn().mockResolvedValue({ found: true });
      vi.doMock('../../src/modules/disputes/resolve-dispute.js', () => ({
        rejectDispute, acceptDispute: vi.fn(), partiallyAcceptDispute: vi.fn(), closeDispute: vi.fn(),
        DisputeTransitionError: class extends Error { code = 'ACCEPTED_AMOUNT_EXCEEDS_CLAIMED'; },
      }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({ method: 'POST', url: `/api/disputes/${DISPUTE_ID}/reject` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ disputeId: DISPUTE_ID, status: 'rejected' });
      expect(rejectDispute).toHaveBeenCalledWith({}, DISPUTE_ID, ACTOR_USER_ID);
    });

    it('returns 409 rejecting a dispute that is not found or not awaiting response', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      vi.doMock('../../src/modules/disputes/resolve-dispute.js', () => ({
        rejectDispute: vi.fn().mockResolvedValue({ found: false }),
        acceptDispute: vi.fn(), partiallyAcceptDispute: vi.fn(), closeDispute: vi.fn(),
        DisputeTransitionError: class extends Error { code = 'ACCEPTED_AMOUNT_EXCEEDS_CLAIMED'; },
      }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({ method: 'POST', url: `/api/disputes/${DISPUTE_ID}/reject` });
      expect(response.statusCode).toBe(409);
    });

    it('partially accepts a dispute and returns its new status', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const partiallyAcceptDispute = vi.fn().mockResolvedValue({ found: true });
      vi.doMock('../../src/modules/disputes/resolve-dispute.js', () => ({
        partiallyAcceptDispute, acceptDispute: vi.fn(), rejectDispute: vi.fn(), closeDispute: vi.fn(),
        DisputeTransitionError: class extends Error { code = 'ACCEPTED_AMOUNT_EXCEEDS_CLAIMED'; },
      }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({
        method: 'POST', url: `/api/disputes/${DISPUTE_ID}/partial-accept`, payload: { acceptedAmount: '300.0000' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ disputeId: DISPUTE_ID, status: 'partial' });
      expect(partiallyAcceptDispute).toHaveBeenCalledWith({}, DISPUTE_ID, ACTOR_USER_ID, '300.0000');
    });

    it('rejects a partial-accept request missing acceptedAmount with 400', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({ method: 'POST', url: `/api/disputes/${DISPUTE_ID}/partial-accept`, payload: {} });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a partial-accept request with a malformed acceptedAmount with 400', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({
        method: 'POST', url: `/api/disputes/${DISPUTE_ID}/partial-accept`, payload: { acceptedAmount: 'not-a-number' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 422 when acceptedAmount exceeds the dispute\'s amount_claimed', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      class MockDisputeTransitionError extends Error {
        code = 'ACCEPTED_AMOUNT_EXCEEDS_CLAIMED' as const;
      }
      const partiallyAcceptDispute = vi.fn().mockRejectedValue(new MockDisputeTransitionError('exceeds'));
      vi.doMock('../../src/modules/disputes/resolve-dispute.js', () => ({
        partiallyAcceptDispute, acceptDispute: vi.fn(), rejectDispute: vi.fn(), closeDispute: vi.fn(),
        DisputeTransitionError: MockDisputeTransitionError,
      }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({
        method: 'POST', url: `/api/disputes/${DISPUTE_ID}/partial-accept`, payload: { acceptedAmount: '999999.0000' },
      });
      expect(response.statusCode).toBe(422);
    });

    it('returns 409 partially accepting a dispute that is not found or not awaiting response', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      vi.doMock('../../src/modules/disputes/resolve-dispute.js', () => ({
        partiallyAcceptDispute: vi.fn().mockResolvedValue({ found: false }),
        acceptDispute: vi.fn(), rejectDispute: vi.fn(), closeDispute: vi.fn(),
        DisputeTransitionError: class extends Error { code = 'ACCEPTED_AMOUNT_EXCEEDS_CLAIMED'; },
      }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({
        method: 'POST', url: `/api/disputes/${DISPUTE_ID}/partial-accept`, payload: { acceptedAmount: '100.0000' },
      });
      expect(response.statusCode).toBe(409);
    });

    it('closes a resolved dispute and returns its new status', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const closeDispute = vi.fn().mockResolvedValue({ found: true });
      vi.doMock('../../src/modules/disputes/resolve-dispute.js', () => ({
        closeDispute, acceptDispute: vi.fn(), rejectDispute: vi.fn(), partiallyAcceptDispute: vi.fn(),
        DisputeTransitionError: class extends Error { code = 'ACCEPTED_AMOUNT_EXCEEDS_CLAIMED'; },
      }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({ method: 'POST', url: `/api/disputes/${DISPUTE_ID}/close` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ disputeId: DISPUTE_ID, status: 'closed' });
      expect(closeDispute).toHaveBeenCalledWith({}, DISPUTE_ID, ACTOR_USER_ID);
    });

    it('returns 409 closing a dispute that is not found or not yet resolved', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      vi.doMock('../../src/modules/disputes/resolve-dispute.js', () => ({
        closeDispute: vi.fn().mockResolvedValue({ found: false }),
        acceptDispute: vi.fn(), rejectDispute: vi.fn(), partiallyAcceptDispute: vi.fn(),
        DisputeTransitionError: class extends Error { code = 'ACCEPTED_AMOUNT_EXCEEDS_CLAIMED'; },
      }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({ method: 'POST', url: `/api/disputes/${DISPUTE_ID}/close` });
      expect(response.statusCode).toBe(409);
    });

    it('requires authentication before accepting a dispute', async () => {
      app = buildApp();
      const response = await app.inject({ method: 'POST', url: `/api/disputes/${DISPUTE_ID}/accept` });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('P4.C.8: communications log', () => {
    it('lists communications for an existing dispute', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const getDisputeDetail = vi.fn().mockResolvedValue({ id: DISPUTE_ID, status: 'sent' });
      vi.doMock('../../src/modules/disputes/get-dispute-detail.js', () => ({ getDisputeDetail }));
      const rows = [
        { id: 'c2', direction: 'outbound', body: 'Delivery to carrier initiated.', recordedAt: '2026-09-01T00:00:00.000Z' },
        { id: 'c1', direction: 'inbound', body: 'Carrier acknowledged receipt.', recordedAt: '2026-08-31T00:00:00.000Z' },
      ];
      const listDisputeCommunications = vi.fn().mockResolvedValue(rows);
      vi.doMock('../../src/modules/disputes/list-dispute-communications.js', () => ({ listDisputeCommunications }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({ method: 'GET', url: `/api/disputes/${DISPUTE_ID}/communications` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ communications: rows });
      expect(listDisputeCommunications).toHaveBeenCalledWith({}, DISPUTE_ID);
    });

    it('returns 404 listing communications for a dispute that does not exist', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const getDisputeDetail = vi.fn().mockResolvedValue(null);
      vi.doMock('../../src/modules/disputes/get-dispute-detail.js', () => ({ getDisputeDetail }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({ method: 'GET', url: `/api/disputes/${DISPUTE_ID}/communications` });
      expect(response.statusCode).toBe(404);
    });

    it('rejects a malformed dispute id on the communications list route', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/api/disputes/not-a-uuid/communications' });
      expect(response.statusCode).toBe(400);
    });

    it('records an inbound communication and returns 201 when newly created', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const recordDisputeCommunication = vi.fn().mockResolvedValue({ disputeCommId: 'new-comm-id', created: true });
      vi.doMock('../../src/modules/disputes/record-dispute-communication.js', () => ({
        recordDisputeCommunication,
        RecordDisputeCommunicationError: class extends Error { code = 'DISPUTE_NOT_FOUND'; },
      }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: `/api/disputes/${DISPUTE_ID}/communications`,
        payload: { body: 'Carrier called to dispute the amount.', idempotencyKey: 'call-2026-09-01' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ disputeCommId: 'new-comm-id', created: true });
      expect(recordDisputeCommunication).toHaveBeenCalledWith({}, {
        disputeId: DISPUTE_ID,
        direction: 'inbound',
        body: 'Carrier called to dispute the amount.',
        dedupeKey: `dispute-comm-inbound:${DISPUTE_ID}:call-2026-09-01`,
      });
    });

    it('a retried POST with the same idempotencyKey returns 200 (not created) instead of a duplicate', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const recordDisputeCommunication = vi.fn().mockResolvedValue({ disputeCommId: 'existing-comm-id', created: false });
      vi.doMock('../../src/modules/disputes/record-dispute-communication.js', () => ({
        recordDisputeCommunication,
        RecordDisputeCommunicationError: class extends Error { code = 'DISPUTE_NOT_FOUND'; },
      }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: `/api/disputes/${DISPUTE_ID}/communications`,
        payload: { body: 'Carrier called to dispute the amount.', idempotencyKey: 'call-2026-09-01' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ disputeCommId: 'existing-comm-id', created: false });
    });

    it('rejects a POST missing body with 400', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({ method: 'POST', url: `/api/disputes/${DISPUTE_ID}/communications`, payload: {} });
      expect(response.statusCode).toBe(400);
    });

    it('returns 404 recording a communication for a dispute that does not exist', async () => {
      mockAuth();
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      class MockRecordDisputeCommunicationError extends Error {
        code = 'DISPUTE_NOT_FOUND' as const;
      }
      const recordDisputeCommunication = vi.fn().mockRejectedValue(new MockRecordDisputeCommunicationError('dispute not found'));
      vi.doMock('../../src/modules/disputes/record-dispute-communication.js', () => ({
        recordDisputeCommunication,
        RecordDisputeCommunicationError: MockRecordDisputeCommunicationError,
      }));
      const { registerDisputeReviewRoutes } = await import('../../src/server/dispute-review-routes.js');
      app = Fastify();
      await app.register(registerDisputeReviewRoutes);
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: `/api/disputes/${DISPUTE_ID}/communications`,
        payload: { body: 'Carrier called.' },
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
