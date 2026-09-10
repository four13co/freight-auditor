import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DualControlRequiredError } from '../../src/modules/rule-engine/promote-shadow-rule.js';
import { RuleActivationBacktestRegressionError, activationCasesSchema } from '../../src/modules/rule-engine/rule-activation-backtest.js';

/**
 * 86e32tfvq: POST /api/rules/:id/ratify and /activate act on the GLOBAL
 * rule/rule_version tables (no client_id, outside RLS) but were gated only
 * by the generic any-tenant-membership preHandler -- any client-member
 * could un-quarantine or promote a rule affecting every tenant. This file
 * proves the swap to registerInternalAnalystAuthPreHandler took effect (a
 * valid single-client membership context, which the shared tenant-auth
 * preHandler WOULD accept, must still be rejected here -- same shape as
 * portfolio-routes.test.ts's own regression proof for the same preHandler)
 * and that a successful call now writes an attributed audit_event.
 *
 * Both mocked auth modules reply 401 on no valid context -- the existing,
 * uniform convention every consumer of either shared preHandler already
 * follows (portfolio-routes.test.ts, findings-routes.ts). The task's own
 * acceptance-criteria text names 403; reusing the unmodified preHandler
 * (the task's own solution sketch) is judged the more important
 * constraint, so 401 was kept and this deviation is noted in the PR body.
 */
function mockAuth(internalCtx: unknown) {
  vi.doMock('../../src/modules/findings/internal-analyst-auth.js', () => ({
    registerInternalAnalystAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request, reply) => {
        if (!internalCtx) {
          await reply.code(401).send({ error: 'unauthorized' });
          return;
        }
        request.tenantContext = internalCtx as never;
        const userId = request.headers['x-user-id'];
        request.actorUserId = Array.isArray(userId) ? userId[0] : userId;
      });
    },
  }));
}

/**
 * Simulates exactly the vulnerable shape from the task: a caller who holds a
 * valid membership row for ONE client, which registerTenantAuthPreHandler
 * grants unconditionally here (no cookie/dev-header plumbing needed). The
 * real registerInternalAnalystAuthPreHandler is left UNMOCKED, so its own
 * (unrelated to this caller) identity resolution runs for real and rejects
 * for lack of any session/dev-header -- exactly what a genuine single-client
 * member hitting this route in production would also get. Deliberately does
 * NOT stub internal-analyst-auth.js, so the two "rejects" tests below prove
 * the route is no longer reachable via the tenant-membership grant at all --
 * against the OLD code (single shared registerTenantAuthPreHandler over the
 * whole file), this same mock makes ratify/activate succeed (201), which is
 * exactly the vulnerability this item fixes.
 */
function mockTenantMembershipGrant() {
  vi.doMock('../../src/modules/findings/tenant-auth.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    registerTenantAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request) => {
        request.tenantContext = { clientIds: ['11111111-1111-4111-8111-111111111111'], internal: false };
      });
    },
  }));
}

const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const RULE_VERSION_ID = '33333333-3333-4333-8333-333333333333';

describe('rule governance internal routes (unit, mocked withTenantTx + auth)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
    vi.doUnmock('../../src/modules/findings/internal-analyst-auth.js');
    vi.doUnmock('../../src/modules/rule-engine/transition-rule-lifecycle.js');
    vi.doUnmock('../../src/modules/rule-engine/promote-shadow-rule.js');
    vi.doUnmock('../../src/modules/rule-engine/rule-activation-backtest.js');
    vi.doUnmock('../../src/modules/audit-ledger/write-audit-event.js');
  });

  describe('POST /api/rules/:id/ratify', () => {
    it('rejects a caller with only a valid single-client tenant-membership context (not internal)', async () => {
      mockTenantMembershipGrant();
      const transitionRuleLifecycle = vi.fn().mockResolvedValue({ ruleVersionId: 'next-1', created: true });
      vi.doMock('../../src/modules/rule-engine/transition-rule-lifecycle.js', () => ({ transitionRuleLifecycle }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'POST', url: `/api/rules/${RULE_VERSION_ID}/ratify`,
        headers: { 'x-client-id': '11111111-1111-4111-8111-111111111111', 'x-user-id': ACTOR_ID },
        payload: { rationale: 'looks good' },
      });

      expect(res.statusCode).toBe(401);
      expect(transitionRuleLifecycle).not.toHaveBeenCalled();
    });

    it('transitions the rule to SHADOW and writes an attributed audit event for an internal analyst', async () => {
      mockAuth({ internal: true });
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      const transitionRuleLifecycle = vi.fn().mockResolvedValue({ ruleVersionId: 'next-1', created: true });
      vi.doMock('../../src/modules/rule-engine/transition-rule-lifecycle.js', () => ({ transitionRuleLifecycle }));
      const writeAuditEvent = vi.fn().mockResolvedValue({ id: 'evt-1', created: true });
      vi.doMock('../../src/modules/audit-ledger/write-audit-event.js', async (importOriginal) => ({
        ...(await importOriginal<object>()), writeAuditEvent,
      }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'POST', url: `/api/rules/${RULE_VERSION_ID}/ratify`,
        headers: { 'x-user-id': ACTOR_ID },
        payload: { rationale: 'looks good' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ruleVersionId: 'next-1', created: true });
      expect(transitionRuleLifecycle).toHaveBeenCalledWith({}, { ruleVersionId: RULE_VERSION_ID, to: 'SHADOW', rationale: 'looks good' });
      expect(writeAuditEvent).toHaveBeenCalledWith({}, expect.objectContaining({
        clientId: null, entity: 'rule_version', entityId: RULE_VERSION_ID, event: 'promoted_to_shadow',
        actorKind: 'analyst', actorUserId: ACTOR_ID, ruleVersionId: 'next-1',
      }));
    });
  });

  describe('POST /api/rules/:id/activate', () => {
    it('rejects a caller with only a valid single-client tenant-membership context (not internal)', async () => {
      mockTenantMembershipGrant();
      const promoteShadowRule = vi.fn().mockResolvedValue({ ruleVersionId: 'next-2', created: true });
      vi.doMock('../../src/modules/rule-engine/promote-shadow-rule.js', () => ({ promoteShadowRule }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'POST', url: `/api/rules/${RULE_VERSION_ID}/activate`,
        headers: { 'x-client-id': '11111111-1111-4111-8111-111111111111', 'x-user-id': ACTOR_ID },
        payload: { rationale: 'promote it' },
      });

      expect(res.statusCode).toBe(401);
      expect(promoteShadowRule).not.toHaveBeenCalled();
    });

    it('promotes the rule to ACTIVE and writes an attributed audit event for an internal analyst', async () => {
      mockAuth({ internal: true });
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      const promoteShadowRule = vi.fn().mockResolvedValue({ ruleVersionId: 'next-2', created: true });
      vi.doMock('../../src/modules/rule-engine/promote-shadow-rule.js', () => ({ promoteShadowRule }));
      const writeAuditEvent = vi.fn().mockResolvedValue({ id: 'evt-2', created: true });
      vi.doMock('../../src/modules/audit-ledger/write-audit-event.js', async (importOriginal) => ({
        ...(await importOriginal<object>()), writeAuditEvent,
      }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'POST', url: `/api/rules/${RULE_VERSION_ID}/activate`,
        headers: { 'x-user-id': ACTOR_ID },
        payload: { rationale: 'promote it' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ruleVersionId: 'next-2', created: true });
      expect(promoteShadowRule).toHaveBeenCalledWith({}, { ruleVersionId: RULE_VERSION_ID, rationale: 'promote it', actorUserId: ACTOR_ID });
      expect(writeAuditEvent).toHaveBeenCalledWith({}, expect.objectContaining({
        clientId: null, entity: 'rule_version', entityId: RULE_VERSION_ID, event: 'promoted_to_active',
        actorKind: 'analyst', actorUserId: ACTOR_ID, ruleVersionId: 'next-2',
      }));
    });

    // 86e367r9q: promoteShadowRule now rejects same-actor (or no-ratification-
    // event) activation with DualControlRequiredError -- this proves the route
    // surfaces that as a real, catchable 409, not the uncaught 500 an unmapped
    // thrown error would otherwise produce (the same gap the pre-fix
    // BacktestRequiredError had, per this task's own Problem statement).
    it('replies 409 when promoteShadowRule rejects a dual-control violation', async () => {
      mockAuth({ internal: true });
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      const promoteShadowRule = vi.fn().mockRejectedValue(new DualControlRequiredError('same analyst'));
      vi.doMock('../../src/modules/rule-engine/promote-shadow-rule.js', () => ({ promoteShadowRule, DualControlRequiredError }));
      const writeAuditEvent = vi.fn();
      vi.doMock('../../src/modules/audit-ledger/write-audit-event.js', async (importOriginal) => ({
        ...(await importOriginal<object>()), writeAuditEvent,
      }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'POST', url: `/api/rules/${RULE_VERSION_ID}/activate`,
        headers: { 'x-user-id': ACTOR_ID },
        payload: { rationale: 'promote it' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'DUAL_CONTROL_REQUIRED' });
      expect(writeAuditEvent).not.toHaveBeenCalled();
    });

    // 86e36zket AC1: a supplied `cases` array switches the route onto the
    // corpus-backtest evidence path -- promoteShadowRule (dual control) is
    // never invoked for this call, proving the two paths are alternatives.
    it('runs the corpus-backtest path and promotes to ACTIVE via ruleBacktestId when cases pass, without invoking dual control', async () => {
      mockAuth({ internal: true });
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      const runAndPersistRuleActivationBacktest = vi.fn().mockResolvedValue({
        backtestId: 'bt-1', result: { corpusHash: 'h'.repeat(64), passed: true, passCount: 1, regressionCount: 0, cases: [] },
      });
      // Explicit object (not importOriginal) so RuleActivationBacktestRegressionError
      // stays the SAME class reference this file imported statically at the top --
      // importOriginal would re-execute the module fresh post-vi.resetModules() and
      // produce a different class identity, breaking the route's own `instanceof` check.
      vi.doMock('../../src/modules/rule-engine/rule-activation-backtest.js', () => ({
        activationCasesSchema, runAndPersistRuleActivationBacktest, RuleActivationBacktestRegressionError,
      }));
      const promoteShadowRule = vi.fn();
      vi.doMock('../../src/modules/rule-engine/promote-shadow-rule.js', () => ({ promoteShadowRule, DualControlRequiredError }));
      const transitionRuleLifecycle = vi.fn().mockResolvedValue({ ruleVersionId: 'next-3', created: true });
      vi.doMock('../../src/modules/rule-engine/transition-rule-lifecycle.js', () => ({ transitionRuleLifecycle }));
      const writeAuditEvent = vi.fn().mockResolvedValue({ id: 'evt-3', created: true });
      vi.doMock('../../src/modules/audit-ledger/write-audit-event.js', async (importOriginal) => ({
        ...(await importOriginal<object>()), writeAuditEvent,
      }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const cases = [{ id: 'case-1', facts: { amount: 150 }, expectedVerdict: 'PASS' }];
      const res = await app.inject({
        method: 'POST', url: `/api/rules/${RULE_VERSION_ID}/activate`,
        headers: { 'x-user-id': ACTOR_ID },
        payload: { rationale: 'corpus backtest passed', cases },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ruleVersionId: 'next-3', created: true });
      expect(runAndPersistRuleActivationBacktest).toHaveBeenCalledWith({}, { ruleVersionId: RULE_VERSION_ID, cases });
      expect(transitionRuleLifecycle).toHaveBeenCalledWith({}, {
        ruleVersionId: RULE_VERSION_ID, to: 'ACTIVE', rationale: 'corpus backtest passed', ruleBacktestId: 'bt-1',
      });
      expect(promoteShadowRule).not.toHaveBeenCalled();
      expect(writeAuditEvent).toHaveBeenCalledWith({}, expect.objectContaining({
        clientId: null, entity: 'rule_version', entityId: RULE_VERSION_ID, event: 'promoted_to_active',
        actorKind: 'analyst', actorUserId: ACTOR_ID, ruleVersionId: 'next-3',
      }));
    });

    // 86e36zket AC2: a regressing corpus is rejected before anything is
    // promoted or persisted -- no promotion_event row, no audit event.
    it('replies 422 with regression detail when the supplied cases fail evaluation, and promotes nothing', async () => {
      mockAuth({ internal: true });
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      const regression = new RuleActivationBacktestRegressionError({
        corpusHash: 'h'.repeat(64), passed: false, passCount: 0, regressionCount: 1,
        cases: [{ id: 'case-1', passed: false, inputHash: 'a'.repeat(64), expectedHash: 'b'.repeat(64), actualHash: 'c'.repeat(64), actual: 'FAIL' }],
      });
      const runAndPersistRuleActivationBacktest = vi.fn().mockRejectedValue(regression);
      // Explicit object (not importOriginal) so RuleActivationBacktestRegressionError
      // stays the SAME class reference this file imported statically at the top --
      // importOriginal would re-execute the module fresh post-vi.resetModules() and
      // produce a different class identity, breaking the route's own `instanceof` check.
      vi.doMock('../../src/modules/rule-engine/rule-activation-backtest.js', () => ({
        activationCasesSchema, runAndPersistRuleActivationBacktest, RuleActivationBacktestRegressionError,
      }));
      const transitionRuleLifecycle = vi.fn();
      vi.doMock('../../src/modules/rule-engine/transition-rule-lifecycle.js', () => ({ transitionRuleLifecycle }));
      const writeAuditEvent = vi.fn();
      vi.doMock('../../src/modules/audit-ledger/write-audit-event.js', async (importOriginal) => ({
        ...(await importOriginal<object>()), writeAuditEvent,
      }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const cases = [{ id: 'case-1', facts: { amount: 50 }, expectedVerdict: 'PASS' }];
      const res = await app.inject({
        method: 'POST', url: `/api/rules/${RULE_VERSION_ID}/activate`,
        headers: { 'x-user-id': ACTOR_ID },
        payload: { rationale: 'trying a failing corpus', cases },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'RULE_ACTIVATION_BACKTEST_REGRESSION', regressionCount: 1, caseIds: ['case-1'] });
      expect(transitionRuleLifecycle).not.toHaveBeenCalled();
      expect(writeAuditEvent).not.toHaveBeenCalled();
    });

    // 86e36zket AC3: omitting `cases` leaves the dual-control-only path
    // (86e367r9q) completely untouched -- the corpus-backtest machinery is
    // never invoked, proving the two paths are additive, not entangled.
    it('never invokes the corpus-backtest path when cases are omitted', async () => {
      mockAuth({ internal: true });
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      const runAndPersistRuleActivationBacktest = vi.fn();
      // Explicit object (not importOriginal) so RuleActivationBacktestRegressionError
      // stays the SAME class reference this file imported statically at the top --
      // importOriginal would re-execute the module fresh post-vi.resetModules() and
      // produce a different class identity, breaking the route's own `instanceof` check.
      vi.doMock('../../src/modules/rule-engine/rule-activation-backtest.js', () => ({
        activationCasesSchema, runAndPersistRuleActivationBacktest, RuleActivationBacktestRegressionError,
      }));
      const promoteShadowRule = vi.fn().mockResolvedValue({ ruleVersionId: 'next-4', created: true });
      vi.doMock('../../src/modules/rule-engine/promote-shadow-rule.js', () => ({ promoteShadowRule, DualControlRequiredError }));
      const writeAuditEvent = vi.fn().mockResolvedValue({ id: 'evt-4', created: true });
      vi.doMock('../../src/modules/audit-ledger/write-audit-event.js', async (importOriginal) => ({
        ...(await importOriginal<object>()), writeAuditEvent,
      }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'POST', url: `/api/rules/${RULE_VERSION_ID}/activate`,
        headers: { 'x-user-id': ACTOR_ID },
        payload: { rationale: 'dual control path, unchanged' },
      });

      expect(res.statusCode).toBe(201);
      expect(promoteShadowRule).toHaveBeenCalledWith({}, { ruleVersionId: RULE_VERSION_ID, rationale: 'dual control path, unchanged', actorUserId: ACTOR_ID });
      expect(runAndPersistRuleActivationBacktest).not.toHaveBeenCalled();
    });
  });

  describe('existing tenant-scoped routes remain untouched by the internal-analyst split', () => {
    it('GET /api/rules/proposals still works under the shared tenant-auth preHandler', async () => {
      mockTenantMembershipGrant();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) =>
          fn({ query: vi.fn().mockResolvedValue({ rows: [{ id: 'rv-1' }] }) })),
      }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({ method: 'GET', url: '/api/rules/proposals' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ proposals: [{ id: 'rv-1' }] });
    });
  });
});
