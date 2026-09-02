import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resetReplayAlertMetricsForTest, renderReplayAlertMetrics } from '../../src/jobs/replay-alert-metrics.js';

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

const WELL_FORMED_UUID = '11111111-2222-3333-4444-555555555555';

/**
 * P6.C.5: the alert-triggering path -- a real ReplayIntegrityError thrown by
 * the (mocked) replay module must increment the process-global counter
 * exposed via GET /metrics, in addition to the pre-existing 409 response
 * audit-runs-endpoint.test.ts already covers. Complements the DB/e2e test
 * that drives a real pin mismatch through the live route and reads the
 * counter back through GET /metrics itself.
 */
describe('POST /api/audit-runs/:id/replay alert-triggering path (unit, mocked withTenantTx + tenant-auth + replayAuditRun)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
    vi.doUnmock('../../src/modules/audit-ledger/replay-audit-run.js');
    resetReplayAlertMetricsForTest();
  });

  it('increments freight_replay_integrity_failures_total when ReplayIntegrityError is thrown', async () => {
    mockTenantAuth({ clientIds: ['client-abc'], internal: false });
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    class ReplayIntegrityError extends Error { readonly code = 'REPLAY_INTEGRITY_FAILED'; }
    vi.doMock('../../src/modules/audit-ledger/replay-audit-run.js', () => ({
      replayAuditRun: vi.fn().mockRejectedValue(new ReplayIntegrityError('replay result is not byte-identical to the pinned result')),
      ReplayIntegrityError,
      ReplayNotFoundError: class ReplayNotFoundError extends Error {},
      ReplayUnavailableError: class ReplayUnavailableError extends Error { readonly code = 'REPLAY_VERSION_UNAVAILABLE'; },
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    expect(renderReplayAlertMetrics()).toContain('freight_replay_integrity_failures_total 0');

    const res = await app.inject({ method: 'POST', url: `/api/audit-runs/${WELL_FORMED_UUID}/replay` });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'REPLAY_INTEGRITY_FAILED' });
    expect(renderReplayAlertMetrics()).toContain('freight_replay_integrity_failures_total 1');
  });

  it('does not increment the counter for a ReplayNotFoundError (404, not an integrity failure)', async () => {
    mockTenantAuth({ clientIds: ['client-abc'], internal: false });
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    class ReplayNotFoundError extends Error {}
    vi.doMock('../../src/modules/audit-ledger/replay-audit-run.js', () => ({
      replayAuditRun: vi.fn().mockRejectedValue(new ReplayNotFoundError('audit replay manifest not found')),
      ReplayIntegrityError: class ReplayIntegrityError extends Error { readonly code = 'REPLAY_INTEGRITY_FAILED'; },
      ReplayNotFoundError,
      ReplayUnavailableError: class ReplayUnavailableError extends Error { readonly code = 'REPLAY_VERSION_UNAVAILABLE'; },
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'POST', url: `/api/audit-runs/${WELL_FORMED_UUID}/replay` });

    expect(res.statusCode).toBe(404);
    expect(renderReplayAlertMetrics()).toContain('freight_replay_integrity_failures_total 0');
  });
});
