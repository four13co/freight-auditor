import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Request-level unit coverage of POST /api/disputes/:id/claim via
 * Fastify's .inject(), with db/tenant-context AND the tenant-auth
 * preHandler mocked so this runs with no live Postgres -- same pattern as
 * claim-recovery-endpoint.test.ts (P5.B.4/#181). Complements
 * test/db/claim-endpoint.db.test.ts, which covers the same route against a
 * real DB.
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
        request.actorUserId = 'user-1';
      });
    },
  }));
}

const DISPUTE_ID = '10000000-0000-4000-8000-000000000001';

describe('POST /api/disputes/:id/claim (unit, mocked withTenantTx + tenant-auth)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
    vi.doUnmock('../../src/modules/claims/create-claim-from-dispute.js');
  });

  function mockAuthorized() {
    mockTenantAuth({ clientIds: ['client-abc'], internal: false });
  }

  it('returns 201 with the claim body for a newly created claim', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/claims/create-claim-from-dispute.js', () => ({
      createClaimFromDispute: vi.fn().mockResolvedValue({
        claimId: 'claim-1', disputeId: DISPUTE_ID, amountClaimed: '500.0000', currency: 'USD', created: true,
      }),
      DisputeNotFoundError: class DisputeNotFoundError extends Error {},
    }));
    vi.doMock('../../src/modules/claims/validate-claimable-dispute.js', () => ({
      ClaimableDisputeError: class ClaimableDisputeError extends Error {},
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'POST', url: `/api/disputes/${DISPUTE_ID}/claim`,
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ claimId: 'claim-1', disputeId: DISPUTE_ID, amountClaimed: '500.0000', currency: 'USD' });
  });

  it('returns 200 for an idempotent retry (created: false)', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/claims/create-claim-from-dispute.js', () => ({
      createClaimFromDispute: vi.fn().mockResolvedValue({
        claimId: 'claim-1', disputeId: DISPUTE_ID, amountClaimed: '500.0000', currency: 'USD', created: false,
      }),
      DisputeNotFoundError: class DisputeNotFoundError extends Error {},
    }));
    vi.doMock('../../src/modules/claims/validate-claimable-dispute.js', () => ({
      ClaimableDisputeError: class ClaimableDisputeError extends Error {},
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'POST', url: `/api/disputes/${DISPUTE_ID}/claim`,
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a malformed dispute id with 400 without touching the database', async () => {
    mockAuthorized();
    const withTenantTx = vi.fn();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'POST', url: '/api/disputes/not-a-uuid/claim',
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
    });
    expect(res.statusCode).toBe(400);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request with 401', async () => {
    mockTenantAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'POST', url: `/api/disputes/${DISPUTE_ID}/claim` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when the dispute is not found', async () => {
    mockAuthorized();
    class DisputeNotFoundError extends Error {}
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/claims/create-claim-from-dispute.js', () => ({
      createClaimFromDispute: vi.fn().mockRejectedValue(new DisputeNotFoundError()),
      DisputeNotFoundError,
    }));
    vi.doMock('../../src/modules/claims/validate-claimable-dispute.js', () => ({
      ClaimableDisputeError: class ClaimableDisputeError extends Error {},
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'POST', url: `/api/disputes/${DISPUTE_ID}/claim`,
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when the dispute is not claimable', async () => {
    mockAuthorized();
    class DisputeNotFoundError extends Error {}
    class ClaimableDisputeError extends Error {}
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/claims/create-claim-from-dispute.js', () => ({
      createClaimFromDispute: vi.fn().mockRejectedValue(new ClaimableDisputeError('not accepted')),
      DisputeNotFoundError,
    }));
    vi.doMock('../../src/modules/claims/validate-claimable-dispute.js', () => ({ ClaimableDisputeError }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'POST', url: `/api/disputes/${DISPUTE_ID}/claim`,
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
    });
    expect(res.statusCode).toBe(409);
  });
});
