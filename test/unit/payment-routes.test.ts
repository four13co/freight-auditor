import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_USER_ID = '22222222-2222-4222-8222-222222222222';
const AUDIT_RUN_ID = '90000000-0000-4000-8000-000000000001';

function mockAuth(role: string = 'analyst') {
  vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
    registerTenantAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
        request.tenantContext = { clientIds: [CLIENT_ID] };
        request.actorUserId = ACTOR_USER_ID;
        request.actorRole = role;
      });
    },
    registerAnalystOnlyPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.actorRole !== 'analyst' && request.actorRole !== 'lead') {
          await reply.code(403).send({ error: 'internal analyst role required' });
        }
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

/**
 * 86e36beq2 + 86e367r9x: a client_viewer/client_admin membership legitimately
 * satisfies registerTenantAuthPreHandler (the read-side check), but must not
 * be able to self-approve/hold their own audit run's payment, nor reconfigure
 * the policy governing it -- both routes now sit behind the same
 * registerAnalystOnlyPreHandler nested scope PR #336 established.
 */
describe('86e36beq2 + 86e367r9x: analyst-only gate on payment-authorization and payment-policy', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
    vi.doUnmock('../../src/modules/payments/authorize-payment.js');
    vi.doUnmock('../../src/modules/payments/upsert-payment-policy.js');
    vi.doUnmock('../../src/db/tenant-context.js');
  });

  it.each(['client_viewer', 'client_admin'])(
    'rejects %s with 403 on POST /api/audit-runs/:id/payment-authorization',
    async (role) => {
      mockAuth(role);
      vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
      const { registerPaymentRoutes } = await import('../../src/server/payment-routes.js');
      app = Fastify();
      await app.register(registerPaymentRoutes);
      await app.ready();

      const response = await app.inject({
        method: 'POST', url: `/api/audit-runs/${AUDIT_RUN_ID}/payment-authorization`,
        payload: { action: 'approve' },
      });

      expect(response.statusCode).toBe(403);
    },
  );

  it.each(['client_viewer', 'client_admin'])('rejects %s with 403 on PUT /api/payment-policy', async (role) => {
    mockAuth(role);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerPaymentRoutes } = await import('../../src/server/payment-routes.js');
    app = Fastify();
    await app.register(registerPaymentRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PUT', url: '/api/payment-policy', payload: {} });

    expect(response.statusCode).toBe(403);
  });

  it('still allows an analyst through to authorize a payment', async () => {
    mockAuth('analyst');
    const authorizePayment = vi.fn().mockResolvedValue({ created: true, action: 'approve', decisionId: 'd1' });
    vi.doMock('../../src/modules/payments/authorize-payment.js', () => ({
      authorizePayment,
      AuthorizePaymentError: class extends Error {},
    }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerPaymentRoutes } = await import('../../src/server/payment-routes.js');
    app = Fastify();
    await app.register(registerPaymentRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST', url: `/api/audit-runs/${AUDIT_RUN_ID}/payment-authorization`,
      payload: { action: 'approve' },
    });

    expect(response.statusCode).toBe(201);
    expect(authorizePayment).toHaveBeenCalled();
  });

  it('still allows a lead through to upsert the payment policy', async () => {
    mockAuth('lead');
    const upsertPaymentPolicy = vi.fn().mockResolvedValue({ clientId: CLIENT_ID, holdThenApprove: true });
    vi.doMock('../../src/modules/payments/upsert-payment-policy.js', () => ({ upsertPaymentPolicy }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const { registerPaymentRoutes } = await import('../../src/server/payment-routes.js');
    app = Fastify();
    await app.register(registerPaymentRoutes);
    await app.ready();

    const response = await app.inject({ method: 'PUT', url: '/api/payment-policy', payload: { holdThenApprove: true } });

    expect(response.statusCode).toBe(200);
    expect(upsertPaymentPolicy).toHaveBeenCalled();
  });
});
