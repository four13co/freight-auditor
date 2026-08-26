import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { transitionRuleLifecycle } from '../modules/rule-engine/transition-rule-lifecycle.js';
import { isUuid } from '../shared/request-validation.js';
import { promoteShadowRule } from '../modules/rule-engine/promote-shadow-rule.js';

export async function registerRuleGovernanceRoutes(routes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(routes);
  routes.get('/api/rules/proposals', async (request) => ({ proposals: await withTenantTx(request.tenantContext!, async (client) =>
    (await client.query(`SELECT rv.id, r.slug, r.rule_type, rv.hardness, rv.lifecycle_state, rv.ast_hash, rv.recorded_at
      FROM rule_version rv JOIN rule r ON r.id=rv.rule_id WHERE rv.lifecycle_state IN ('PROPOSED','SHADOW')
      ORDER BY rv.recorded_at, rv.id`)).rows) }));
  routes.post('/api/rules/:id/ratify', async (request, reply) => {
    const { id } = request.params as { id: string }; if (!isUuid(id)) return reply.code(400).send({ error: 'invalid rule version id' });
    const body = request.body as { rationale?: unknown };
    if (typeof body.rationale !== 'string' || !body.rationale.trim()) return reply.code(400).send({ error: 'rationale is required' });
    const result = await withTenantTx(request.tenantContext!, (client) => transitionRuleLifecycle(client, {
      ruleVersionId: id, to: 'SHADOW', rationale: body.rationale as string }));
    return reply.code(201).send(result);
  });
  routes.post('/api/rules/:id/activate', async (request, reply) => {
    const { id } = request.params as { id: string }; if (!isUuid(id)) return reply.code(400).send({ error: 'invalid rule version id' });
    const body = request.body as { rationale?: unknown };
    if (typeof body.rationale !== 'string' || !body.rationale.trim()) return reply.code(400).send({ error: 'rationale is required' });
    const result = await withTenantTx(request.tenantContext!, (client) => promoteShadowRule(client, { ruleVersionId: id, rationale: body.rationale as string }));
    return reply.code(201).send(result);
  });
}
