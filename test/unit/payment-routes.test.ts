import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_USER_ID = '22222222-2222-4222-8222-222222222222';

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

/**
 * 86e367r9x: upsert-payment-policy.ts had no route -- this proves
 * PUT /api/payment-policy is now reachable and correctly threads
 * clientId/configuredBy from the request context rather than the body.
 */
describe('PUT /api/payment-policy', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
    vi.doUnmock('../../src/modules/payments/upsert-payment-policy.js');
    vi.doUnmock('../../src/modules/payments/payment-policy-config.js');
    vi.doUnmock('../../src/db/tenant-context.js');
  });

  it('upserts the policy using the tenant-scoped clientId and actorUserId, ignoring any client/actor in the body', async () => {
    mockAuth();
    const upsertPaymentPolicy = vi.fn().mockResolvedValue({
      clientId: CLIENT_ID, holdThenApprove: false, shortPayEnabled: true, approvalExpiryHours: 48, configuredBy: ACTOR_USER_ID,
    });
    vi.doMock('../../src/modules/payments/upsert-payment-policy.js', () => ({ upsertPaymentPolicy }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerPaymentRoutes } = await import('../../src/server/payment-routes.js');
    app = Fastify();
    await app.register(registerPaymentRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'PUT', url: '/api/payment-policy',
      payload: {
        holdThenApprove: false, shortPayEnabled: true, approvalExpiryHours: 48,
        clientId: 'attacker-supplied-client', configuredBy: 'attacker-supplied-user',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      clientId: CLIENT_ID, holdThenApprove: false, shortPayEnabled: true, approvalExpiryHours: 48, configuredBy: ACTOR_USER_ID,
    });
    expect(upsertPaymentPolicy).toHaveBeenCalledWith({}, expect.objectContaining({
      clientId: CLIENT_ID, configuredBy: ACTOR_USER_ID, holdThenApprove: false, shortPayEnabled: true, approvalExpiryHours: 48,
    }));
  });

  it('returns 400 with the validation issues for an invalid payload', async () => {
    mockAuth();
    class MockPaymentPolicyValidationError extends Error {
      readonly code = 'PAYMENT_POLICY_INVALID';
      constructor(readonly issues: ReadonlyArray<{ path: string; code: string }>) { super('invalid'); }
    }
    const upsertPaymentPolicy = vi.fn().mockRejectedValue(
      new MockPaymentPolicyValidationError([{ path: 'approvalExpiryHours', code: 'too_small' }]),
    );
    vi.doMock('../../src/modules/payments/upsert-payment-policy.js', () => ({ upsertPaymentPolicy }));
    vi.doMock('../../src/modules/payments/payment-policy-config.js', () => ({ PaymentPolicyValidationError: MockPaymentPolicyValidationError }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerPaymentRoutes } = await import('../../src/server/payment-routes.js');
    app = Fastify();
    await app.register(registerPaymentRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PUT', url: '/api/payment-policy', payload: { approvalExpiryHours: -1 } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'PAYMENT_POLICY_INVALID', issues: [{ path: 'approvalExpiryHours', code: 'too_small' }] });
    expect(upsertPaymentPolicy).toHaveBeenCalled();
  });

  it('requires authentication before upserting the policy', async () => {
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();
    const response = await app.inject({ method: 'PUT', url: '/api/payment-policy', payload: {} });
    expect(response.statusCode).toBe(401);
  });
});
