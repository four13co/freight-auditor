import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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

const FINDING_ID = '11111111-2222-3333-4444-555555555555';
const CRITERION_ID = '20000000-0000-4000-8000-000000000002';
const RULE_VERSION_ID = '30000000-0000-4000-8000-000000000003';

/**
 * P6.C.8: request-level coverage of the new POST /api/findings/:id/reverse
 * route, mocked at the outermost boundary (withTenantTx's client + the
 * recordHumanOverrideReversal module), per this task's own No-go on mock
 * depth. Complements record-human-override-reversal.test.ts (the module's
 * own logic) and the reintroduced quarantine-on-reversal.test.ts.
 */
describe('POST /api/findings/:id/reverse (unit, mocked withTenantTx + tenant-auth + recordHumanOverrideReversal)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
    vi.doUnmock('../../src/modules/rule-engine/record-human-override-reversal.js');
  });

  function mockAuthorized() {
    mockTenantAuth({ clientIds: ['client-abc'], internal: false });
  }

  function mockTx(findingRows: unknown[], ruleRows: unknown[]) {
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => {
        const query = vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM variance_finding')) return Promise.resolve({ rows: findingRows });
          if (sql.includes('FROM rule_version WHERE id')) return Promise.resolve({ rows: ruleRows });
          throw new Error(`unexpected query: ${sql}`);
        });
        return fn({ query });
      }),
    }));
  }

  it('returns 201 with the reversal result for a FIRM_RULE finding', async () => {
    mockAuthorized();
    mockTx([{ criterion_id: CRITERION_ID, rule_version_id: RULE_VERSION_ID }], [{ hardness: 'FIRM_RULE' }]);
    const recordHumanOverrideReversal = vi.fn().mockResolvedValue({ humanOverrideId: 'override-1', quarantined: false, ruleVersionId: RULE_VERSION_ID });
    vi.doMock('../../src/modules/rule-engine/record-human-override-reversal.js', () => ({
      recordHumanOverrideReversal,
      InvalidReversalRequestError: class InvalidReversalRequestError extends Error { code = 'X'; },
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'POST', url: `/api/findings/${FINDING_ID}/reverse`,
      payload: { caseFingerprint: 'ocean/fsc', assertedValue: { rate: '1.1' } },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: FINDING_ID, humanOverrideId: 'override-1', quarantined: false, ruleVersionId: RULE_VERSION_ID });
    expect(recordHumanOverrideReversal).toHaveBeenCalledWith(expect.anything(), {
      clientId: 'client-abc', criterionId: CRITERION_ID, ruleVersionId: RULE_VERSION_ID,
      caseFingerprint: 'ocean/fsc', assertedValue: { rate: '1.1' },
    });
  });

  it('returns 404 when the finding does not exist', async () => {
    mockAuthorized();
    mockTx([], []);
    vi.doMock('../../src/modules/rule-engine/record-human-override-reversal.js', () => ({
      recordHumanOverrideReversal: vi.fn(), InvalidReversalRequestError: class extends Error {},
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'POST', url: `/api/findings/${FINDING_ID}/reverse`, payload: { caseFingerprint: 'x', assertedValue: 1 } });
    expect(res.statusCode).toBe(404);
  });

  it('returns 422 when the finding has no criterion/rule_version attribution', async () => {
    mockAuthorized();
    mockTx([{ criterion_id: null, rule_version_id: null }], []);
    vi.doMock('../../src/modules/rule-engine/record-human-override-reversal.js', () => ({
      recordHumanOverrideReversal: vi.fn(), InvalidReversalRequestError: class extends Error {},
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'POST', url: `/api/findings/${FINDING_ID}/reverse`, payload: { caseFingerprint: 'x', assertedValue: 1 } });
    expect(res.statusCode).toBe(422);
  });

  it('returns 409 NOT_A_FIRM_RULE when the finding\'s rule is not FIRM_RULE', async () => {
    mockAuthorized();
    mockTx([{ criterion_id: CRITERION_ID, rule_version_id: RULE_VERSION_ID }], [{ hardness: 'AI_CANON' }]);
    vi.doMock('../../src/modules/rule-engine/record-human-override-reversal.js', () => ({
      recordHumanOverrideReversal: vi.fn(), InvalidReversalRequestError: class extends Error {},
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'POST', url: `/api/findings/${FINDING_ID}/reverse`, payload: { caseFingerprint: 'x', assertedValue: 1 } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'NOT_A_FIRM_RULE' });
  });

  it('returns 400 with the error code when recordHumanOverrideReversal throws InvalidReversalRequestError', async () => {
    mockAuthorized();
    mockTx([{ criterion_id: CRITERION_ID, rule_version_id: RULE_VERSION_ID }], [{ hardness: 'FIRM_RULE' }]);
    class InvalidReversalRequestError extends Error { constructor(readonly code: string, message: string) { super(message); } }
    const recordHumanOverrideReversal = vi.fn().mockRejectedValue(new InvalidReversalRequestError('CLIENT_NOT_FOUND', 'nope'));
    vi.doMock('../../src/modules/rule-engine/record-human-override-reversal.js', () => ({ recordHumanOverrideReversal, InvalidReversalRequestError }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'POST', url: `/api/findings/${FINDING_ID}/reverse`, payload: { caseFingerprint: 'x', assertedValue: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'CLIENT_NOT_FOUND' });
  });

  it('rejects a malformed finding id with 400, without calling recordHumanOverrideReversal', async () => {
    mockAuthorized();
    mockTx([], []);
    const recordHumanOverrideReversal = vi.fn();
    vi.doMock('../../src/modules/rule-engine/record-human-override-reversal.js', () => ({ recordHumanOverrideReversal, InvalidReversalRequestError: class extends Error {} }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/api/findings/not-a-uuid/reverse', payload: { caseFingerprint: 'x', assertedValue: 1 } });
    expect(res.statusCode).toBe(400);
    expect(recordHumanOverrideReversal).not.toHaveBeenCalled();
  });

  it('rejects a missing caseFingerprint with 400', async () => {
    mockAuthorized();
    mockTx([], []);
    vi.doMock('../../src/modules/rule-engine/record-human-override-reversal.js', () => ({ recordHumanOverrideReversal: vi.fn(), InvalidReversalRequestError: class extends Error {} }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'POST', url: `/api/findings/${FINDING_ID}/reverse`, payload: { assertedValue: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unauthenticated request with 401', async () => {
    mockTenantAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    vi.doMock('../../src/modules/rule-engine/record-human-override-reversal.js', () => ({ recordHumanOverrideReversal: vi.fn(), InvalidReversalRequestError: class extends Error {} }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'POST', url: `/api/findings/${FINDING_ID}/reverse`, payload: { caseFingerprint: 'x', assertedValue: 1 } });
    expect(res.statusCode).toBe(401);
  });
});
