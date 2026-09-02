import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { registerInternalAnalystAuthPreHandler } from '../modules/findings/internal-analyst-auth.js';
import { transitionRuleLifecycle } from '../modules/rule-engine/transition-rule-lifecycle.js';
import { isUuid } from '../shared/request-validation.js';
import { promoteShadowRule } from '../modules/rule-engine/promote-shadow-rule.js';
import { listContractRuleProposalPreviews } from '../modules/contracts/list-contract-rule-proposal-previews.js';
import { acceptContractRuleProposal, ProposalAcceptanceError } from '../modules/contracts/accept-contract-rule-proposal.js';
import { ratifyContractRuleProposal, ProposalRatificationError } from '../modules/contracts/ratify-contract-rule-proposal.js';
import { deterministicAuditEventId, writeAuditEvent } from '../modules/audit-ledger/write-audit-event.js';

export async function registerRuleGovernanceRoutes(routes: FastifyInstance): Promise<void> {
  // Tenant-scoped proposal read/accept/ratify -- unchanged, shared preHandler.
  await routes.register(async (tenantRoutes) => {
    await registerTenantAuthPreHandler(tenantRoutes);
    tenantRoutes.get('/api/rules/proposals', async (request) => ({ proposals: await withTenantTx(request.tenantContext!, async (client) =>
      (await client.query(`SELECT rv.id, r.slug, r.rule_type, rv.hardness, rv.lifecycle_state, rv.ast_hash, rv.recorded_at
        FROM rule_version rv JOIN rule r ON r.id=rv.rule_id WHERE rv.lifecycle_state IN ('PROPOSED','SHADOW')
        ORDER BY rv.recorded_at, rv.id`)).rows) }));
    tenantRoutes.get('/api/contracts/rule-proposal-previews', async (request) => ({ proposals: await withTenantTx(
      request.tenantContext!, (client) => listContractRuleProposalPreviews(client)) }));
    tenantRoutes.post('/api/contracts/rule-proposals/:id/accept', async (request, reply) => {
      const { id } = request.params as { id: string }; if (!isUuid(id)) return reply.code(400).send({ error: 'invalid proposal id' });
      const body = request.body as { backtestId?: unknown; rationale?: unknown };
      if (typeof body.backtestId !== 'string' || !isUuid(body.backtestId)) return reply.code(400).send({ error: 'valid backtestId is required' });
      if (typeof body.rationale !== 'string' || !body.rationale.trim()) return reply.code(400).send({ error: 'rationale is required' });
      try {
        const result = await withTenantTx(request.tenantContext!, (client) => acceptContractRuleProposal(client, {
          clientId: request.tenantContext!.clientIds![0]!, proposalId: id, backtestId: body.backtestId as string,
          actorUserId: request.actorUserId!, rationale: body.rationale as string }));
        return reply.code(result.created ? 201 : 200).send(result);
      } catch (error) {
        if (error instanceof ProposalAcceptanceError) return reply.code(error.code === 'PROPOSAL_NOT_FOUND' ? 404 : 409).send({ error: error.code });
        throw error;
      }
    });
    tenantRoutes.post('/api/contracts/rule-proposal-acceptances/:id/ratify', async (request, reply) => {
      const { id }=request.params as {id:string}; if(!isUuid(id)) return reply.code(400).send({error:'invalid acceptance id'});
      const body=request.body as {rationale?:unknown}; if(typeof body.rationale!=='string'||!body.rationale.trim()) return reply.code(400).send({error:'rationale is required'});
      try { const result=await withTenantTx(request.tenantContext!,client=>ratifyContractRuleProposal(client,{clientId:request.tenantContext!.clientIds![0]!,acceptanceId:id,actorUserId:request.actorUserId!,rationale:body.rationale as string})); return reply.code(result.created?201:200).send(result); }
      catch(error){if(error instanceof ProposalRatificationError)return reply.code(error.code==='ACCEPTANCE_NOT_FOUND'?404:409).send({error:error.code});throw error;}
    });
  });

  // Rule governance mutations (ratify/activate) act on the GLOBAL rule/rule_version
  // tables (no client_id, outside RLS -- migration 0009_rls_policies.sql), so the
  // generic any-role tenant-membership preHandler above is the wrong gate: any
  // caller with a membership row for ANY single client could otherwise
  // un-quarantine or promote a rule affecting every tenant's audit engine (86e32tfvq).
  // Own nested scope + registerInternalAnalystAuthPreHandler, same "global
  // resource, internal analysts only" precedent as portfolio-routes.ts -- no
  // existing route's auth behavior above is touched by this split. Both
  // mutations also write an attributed audit_event (clientId: null, since the
  // resource is global) inside the same transaction as the lifecycle
  // transition, matching the proposal accept/ratify pattern above.
  await routes.register(async (internalRoutes) => {
    await registerInternalAnalystAuthPreHandler(internalRoutes);
    internalRoutes.post('/api/rules/:id/ratify', async (request, reply) => {
      const { id } = request.params as { id: string }; if (!isUuid(id)) return reply.code(400).send({ error: 'invalid rule version id' });
      const body = request.body as { rationale?: unknown };
      if (typeof body.rationale !== 'string' || !body.rationale.trim()) return reply.code(400).send({ error: 'rationale is required' });
      const actorUserId = request.actorUserId!;
      const result = await withTenantTx(request.tenantContext!, async (client) => {
        const transition = await transitionRuleLifecycle(client, { ruleVersionId: id, to: 'SHADOW', rationale: body.rationale as string });
        await writeAuditEvent(client, {
          id: deterministicAuditEventId(id, transition.ruleVersionId, 'rule_version.promoted_to_shadow'),
          clientId: null, entity: 'rule_version', entityId: id, event: 'promoted_to_shadow',
          actorKind: 'analyst', actorUserId, ruleVersionId: transition.ruleVersionId,
          detail: { rationale: body.rationale, fromRuleVersionId: id },
        });
        return transition;
      });
      return reply.code(201).send(result);
    });
    internalRoutes.post('/api/rules/:id/activate', async (request, reply) => {
      const { id } = request.params as { id: string }; if (!isUuid(id)) return reply.code(400).send({ error: 'invalid rule version id' });
      const body = request.body as { rationale?: unknown };
      if (typeof body.rationale !== 'string' || !body.rationale.trim()) return reply.code(400).send({ error: 'rationale is required' });
      const actorUserId = request.actorUserId!;
      const result = await withTenantTx(request.tenantContext!, async (client) => {
        const promotion = await promoteShadowRule(client, { ruleVersionId: id, rationale: body.rationale as string });
        await writeAuditEvent(client, {
          id: deterministicAuditEventId(id, promotion.ruleVersionId, 'rule_version.promoted_to_active'),
          clientId: null, entity: 'rule_version', entityId: id, event: 'promoted_to_active',
          actorKind: 'analyst', actorUserId, ruleVersionId: promotion.ruleVersionId,
          detail: { rationale: body.rationale, fromRuleVersionId: id },
        });
        return promotion;
      });
      return reply.code(201).send(result);
    });
  });
}
