import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { registerInternalAnalystAuthPreHandler } from '../modules/findings/internal-analyst-auth.js';
import { transitionRuleLifecycle } from '../modules/rule-engine/transition-rule-lifecycle.js';
import { isUuid } from '../shared/request-validation.js';
import { parseLimitOffset } from '../shared/parse-limit-offset.js';
import { promoteShadowRule, DualControlRequiredError } from '../modules/rule-engine/promote-shadow-rule.js';
import {
  activationCasesSchema, runAndPersistRuleActivationBacktest, RuleActivationBacktestRegressionError,
} from '../modules/rule-engine/rule-activation-backtest.js';
import { listContractRuleProposalPreviews } from '../modules/contracts/list-contract-rule-proposal-previews.js';
import { acceptContractRuleProposal, ProposalAcceptanceError } from '../modules/contracts/accept-contract-rule-proposal.js';
import { ratifyContractRuleProposal, ProposalRatificationError } from '../modules/contracts/ratify-contract-rule-proposal.js';
import { deterministicAuditEventId, writeAuditEvent } from '../modules/audit-ledger/write-audit-event.js';
import { listRules, type RuleListSortKey } from '../modules/rule-engine/list-rules.js';
import { getRuleDetail } from '../modules/rule-engine/get-rule-detail.js';

const RULE_LIST_SORT_KEYS = new Set<RuleListSortKey>(['name', 'tier', 'type', 'status', 'lastModified']);
const RULE_TIERS = new Set(['STANDARD', 'CLIENT', 'CONTRACT']);
const RULE_KINDS = new Set(['GATING', 'SCORING']);
const RULE_STATUSES = new Set(['PROPOSED', 'SHADOW', 'ACTIVE', 'DEPRECATED', 'QUARANTINED']);
const MAX_RULE_LIST_LIMIT = 200;
const DEFAULT_RULE_LIST_LIMIT = 50;

export async function registerRuleGovernanceRoutes(routes: FastifyInstance): Promise<void> {
  // Tenant-scoped proposal read/accept/ratify -- unchanged, shared preHandler.
  await routes.register(async (tenantRoutes) => {
    await registerTenantAuthPreHandler(tenantRoutes);
    tenantRoutes.get('/api/rules/proposals', async (request) => ({ proposals: await withTenantTx(request.tenantContext!, async (client) =>
      // 86e33t9n0: transitionRuleLifecycle is append-only -- ratifying/
      // activating never mutates the predecessor row's own lifecycle_state,
      // it only INSERTs a new successor row. Without this exclusion, a
      // superseded PROPOSED/SHADOW row stays visible forever as a ghost
      // duplicate alongside its real successor.
      (await client.query(`SELECT rv.id, r.slug, r.rule_type, rv.hardness, rv.lifecycle_state, rv.ast_hash, rv.recorded_at
        FROM rule_version rv JOIN rule r ON r.id=rv.rule_id WHERE rv.lifecycle_state IN ('PROPOSED','SHADOW')
        AND NOT EXISTS (SELECT 1 FROM rule_version successor WHERE successor.predecessor_rule_version_id = rv.id)
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
    // 86e36zket: an optional `cases` body array switches this route onto the
    // corpus-backtest evidence path -- a curated, caller-supplied fixture set
    // evaluated against this rule version's own AST. A fully-passing corpus
    // satisfies the ACTIVE-transition evidence requirement on its own (no
    // dual-control check for this call); a regressing corpus is rejected and
    // nothing is promoted or persisted. Omitting `cases` leaves 86e367r9q's
    // dual-control-only path completely unchanged -- additive, not a replacement.
    internalRoutes.post('/api/rules/:id/activate', async (request, reply) => {
      const { id } = request.params as { id: string }; if (!isUuid(id)) return reply.code(400).send({ error: 'invalid rule version id' });
      const body = request.body as { rationale?: unknown; cases?: unknown };
      if (typeof body.rationale !== 'string' || !body.rationale.trim()) return reply.code(400).send({ error: 'rationale is required' });
      const rationale = body.rationale;
      const actorUserId = request.actorUserId!;
      const recordActivation = async (
        client: pg.PoolClient, promotion: { ruleVersionId: string; created: boolean }, ruleBacktestId?: string,
      ) => {
        await writeAuditEvent(client, {
          id: deterministicAuditEventId(id, promotion.ruleVersionId, 'rule_version.promoted_to_active'),
          clientId: null, entity: 'rule_version', entityId: id, event: 'promoted_to_active',
          actorKind: 'analyst', actorUserId, ruleVersionId: promotion.ruleVersionId,
          detail: { rationale, fromRuleVersionId: id, ...(ruleBacktestId ? { ruleBacktestId } : {}) },
        });
        return promotion;
      };
      try {
        if (body.cases !== undefined) {
          const parsed = activationCasesSchema.safeParse(body.cases);
          if (!parsed.success) return reply.code(400).send({ error: 'invalid cases' });
          const result = await withTenantTx(request.tenantContext!, async (client) => {
            const backtest = await runAndPersistRuleActivationBacktest(client, { ruleVersionId: id, cases: parsed.data });
            const transition = await transitionRuleLifecycle(client, {
              ruleVersionId: id, to: 'ACTIVE', rationale, ruleBacktestId: backtest.backtestId,
            });
            return recordActivation(client, transition, backtest.backtestId);
          });
          return reply.code(201).send(result);
        }
        const result = await withTenantTx(request.tenantContext!, async (client) => {
          const promotion = await promoteShadowRule(client, { ruleVersionId: id, rationale, actorUserId });
          return recordActivation(client, promotion);
        });
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof RuleActivationBacktestRegressionError) {
          return reply.code(422).send({
            error: error.code, regressionCount: error.result.regressionCount,
            caseIds: error.result.cases.filter((c) => !c.passed).map((c) => c.id),
          });
        }
        if (error instanceof DualControlRequiredError) return reply.code(409).send({ error: error.code });
        throw error;
      }
    });

    // 86e3a6rg1: the Rules tab's list -- every rule's CURRENT version (any
    // lifecycle state, not just PROPOSED/SHADOW like /api/rules/proposals
    // above), with server-side filter/sort/pagination. See list-rules.ts's
    // header comment for how tier/type are derived and the deterministic
    // simplification that implies for a rule wired to more than one
    // criterion/rubric.
    internalRoutes.get('/api/rules', async (request, reply) => {
      const query = request.query as {
        tier?: string; kind?: string; status?: string; sortKey?: string; sortDirection?: string;
        limit?: string; offset?: string;
      };
      if (query.tier !== undefined && !RULE_TIERS.has(query.tier)) {
        return reply.code(400).send({ error: `invalid tier: must be one of ${[...RULE_TIERS].join(', ')}` });
      }
      if (query.kind !== undefined && !RULE_KINDS.has(query.kind)) {
        return reply.code(400).send({ error: `invalid kind: must be one of ${[...RULE_KINDS].join(', ')}` });
      }
      if (query.status !== undefined && !RULE_STATUSES.has(query.status)) {
        return reply.code(400).send({ error: `invalid status: must be one of ${[...RULE_STATUSES].join(', ')}` });
      }
      if (query.sortKey !== undefined && !RULE_LIST_SORT_KEYS.has(query.sortKey as RuleListSortKey)) {
        return reply.code(400).send({ error: `invalid sortKey: must be one of ${[...RULE_LIST_SORT_KEYS].join(', ')}` });
      }
      if (query.sortDirection !== undefined && query.sortDirection !== 'asc' && query.sortDirection !== 'desc') {
        return reply.code(400).send({ error: 'invalid sortDirection: must be asc or desc' });
      }
      const parsedLimitOffset = parseLimitOffset(query, { maxLimit: MAX_RULE_LIST_LIMIT });
      if (!parsedLimitOffset.ok) return reply.code(400).send({ error: parsedLimitOffset.error });
      const { limit, offset } = parsedLimitOffset.value;

      const result = await withTenantTx(request.tenantContext!, (client) => listRules(client, {
        tier: query.tier as 'STANDARD' | 'CLIENT' | 'CONTRACT' | undefined,
        kind: query.kind as 'GATING' | 'SCORING' | undefined,
        status: query.status as 'PROPOSED' | 'SHADOW' | 'ACTIVE' | 'DEPRECATED' | 'QUARANTINED' | undefined,
        sortKey: query.sortKey as RuleListSortKey | undefined,
        sortDirection: query.sortDirection as 'asc' | 'desc' | undefined,
        limit: limit ?? DEFAULT_RULE_LIST_LIMIT,
        offset: offset ?? 0,
      }));
      return result;
    });

    internalRoutes.get('/api/rules/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) return reply.code(400).send({ error: 'invalid rule version id' });
      const detail = await withTenantTx(request.tenantContext!, (client) => getRuleDetail(client, id));
      if (!detail) return reply.code(404).send({ error: 'rule version not found' });
      return detail;
    });

    // Deprecate (ACTIVE -> DEPRECATED) and quarantine (PROPOSED/SHADOW/ACTIVE
    // -> QUARANTINED) -- the two remaining rule-lifecycle transitions the
    // task's own Rules tab lists ("Activate, Deprecate, Quarantine") that
    // /ratify and /activate above don't cover. Same shape as /ratify: a bare
    // transitionRuleLifecycle call (no dual-control gate -- that's specific
    // to SHADOW->ACTIVE, see promote-shadow-rule.ts) plus an attributed,
    // global (clientId: null) audit_event.
    internalRoutes.post('/api/rules/:id/deprecate', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) return reply.code(400).send({ error: 'invalid rule version id' });
      const body = request.body as { rationale?: unknown };
      if (typeof body.rationale !== 'string' || !body.rationale.trim()) {
        return reply.code(400).send({ error: 'rationale is required' });
      }
      const actorUserId = request.actorUserId!;
      const result = await withTenantTx(request.tenantContext!, async (client) => {
        const transition = await transitionRuleLifecycle(client, { ruleVersionId: id, to: 'DEPRECATED', rationale: body.rationale as string });
        await writeAuditEvent(client, {
          id: deterministicAuditEventId(id, transition.ruleVersionId, 'rule_version.deprecated'),
          clientId: null, entity: 'rule_version', entityId: id, event: 'deprecated',
          actorKind: 'analyst', actorUserId, ruleVersionId: transition.ruleVersionId,
          detail: { rationale: body.rationale, fromRuleVersionId: id },
        });
        return transition;
      });
      return reply.code(201).send(result);
    });

    internalRoutes.post('/api/rules/:id/quarantine', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isUuid(id)) return reply.code(400).send({ error: 'invalid rule version id' });
      const body = request.body as { rationale?: unknown };
      if (typeof body.rationale !== 'string' || !body.rationale.trim()) {
        return reply.code(400).send({ error: 'rationale is required' });
      }
      const actorUserId = request.actorUserId!;
      const result = await withTenantTx(request.tenantContext!, async (client) => {
        const transition = await transitionRuleLifecycle(client, { ruleVersionId: id, to: 'QUARANTINED', rationale: body.rationale as string });
        await writeAuditEvent(client, {
          id: deterministicAuditEventId(id, transition.ruleVersionId, 'rule_version.quarantined'),
          clientId: null, entity: 'rule_version', entityId: id, event: 'quarantined',
          actorKind: 'analyst', actorUserId, ruleVersionId: transition.ruleVersionId,
          detail: { rationale: body.rationale, fromRuleVersionId: id },
        });
        return transition;
      });
      return reply.code(201).send(result);
    });
  });
}
