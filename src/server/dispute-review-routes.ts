import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { isUuid } from '../shared/request-validation.js';
import { getDisputeDetail } from '../modules/disputes/get-dispute-detail.js';
import { approveDispute } from '../modules/disputes/approve-dispute.js';
import { listDisputeCommunications } from '../modules/disputes/list-dispute-communications.js';
import { recordDisputeCommunication, RecordDisputeCommunicationError } from '../modules/disputes/record-dispute-communication.js';
import {
  acceptDispute,
  rejectDispute,
  partiallyAcceptDispute,
  closeDispute,
  DisputeTransitionError,
} from '../modules/disputes/resolve-dispute.js';

const MONEY_PATTERN = /^\d+(\.\d{1,4})?$/;

/**
 * Dispute review + approval API (P4.C.6): an analyst inspects a draft
 * dispute's lines/amounts and approves it for delivery. Own encapsulation
 * so the tenant-auth preHandler binds ONLY to this plugin, following
 * claim-routes.ts's (P5.A.1, merged) precedent exactly.
 */
export async function registerDisputeReviewRoutes(routes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(routes);

  routes.get('/api/disputes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid dispute id: must be a well-formed UUID' });
      return;
    }
    const detail = await withTenantTx(request.tenantContext!, (client) => getDisputeDetail(client, id));
    if (!detail) {
      await reply.code(404).send({ error: 'dispute not found' });
      return;
    }
    return detail;
  });

  routes.post('/api/disputes/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid dispute id: must be a well-formed UUID' });
      return;
    }
    if (!request.actorUserId) {
      await reply.code(401).send({ error: 'authenticated analyst identity required' });
      return;
    }

    const result = await withTenantTx(request.tenantContext!, (client) =>
      approveDispute(client, id, request.actorUserId!));
    if (!result.found) {
      await reply.code(409).send({ error: 'dispute not found or not in a draft state' });
      return;
    }
    return { disputeId: id, status: 'sent' };
  });

  // P4.C.9: the carrier-response lifecycle after a dispute is sent --
  // accepted/rejected/partial, then closed. Same actorUserId + isUuid
  // guards as /approve above; each resolver in resolve-dispute.ts already
  // enforces its own from-state, so a 409 here means "not found, or not
  // currently in a state this transition accepts from" -- the caller
  // cannot distinguish those two without leaking existence across tenants,
  // matching approve's own 409 semantics.
  routes.post('/api/disputes/:id/accept', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid dispute id: must be a well-formed UUID' });
      return;
    }
    if (!request.actorUserId) {
      await reply.code(401).send({ error: 'authenticated analyst identity required' });
      return;
    }

    const result = await withTenantTx(request.tenantContext!, (client) =>
      acceptDispute(client, id, request.actorUserId!));
    if (!result.found) {
      await reply.code(409).send({ error: 'dispute not found or not currently awaiting a carrier response' });
      return;
    }
    return { disputeId: id, status: 'accepted' };
  });

  routes.post('/api/disputes/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid dispute id: must be a well-formed UUID' });
      return;
    }
    if (!request.actorUserId) {
      await reply.code(401).send({ error: 'authenticated analyst identity required' });
      return;
    }

    const result = await withTenantTx(request.tenantContext!, (client) =>
      rejectDispute(client, id, request.actorUserId!));
    if (!result.found) {
      await reply.code(409).send({ error: 'dispute not found or not currently awaiting a carrier response' });
      return;
    }
    return { disputeId: id, status: 'rejected' };
  });

  routes.post('/api/disputes/:id/partial-accept', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid dispute id: must be a well-formed UUID' });
      return;
    }
    if (!request.actorUserId) {
      await reply.code(401).send({ error: 'authenticated analyst identity required' });
      return;
    }

    const requestBody = request.body as { acceptedAmount?: unknown };
    if (typeof requestBody.acceptedAmount !== 'string' || !MONEY_PATTERN.test(requestBody.acceptedAmount)) {
      await reply.code(400).send({ error: 'acceptedAmount is required and must be a non-negative decimal string' });
      return;
    }

    try {
      const result = await withTenantTx(request.tenantContext!, (client) =>
        partiallyAcceptDispute(client, id, request.actorUserId!, requestBody.acceptedAmount as string));
      if (!result.found) {
        await reply.code(409).send({ error: 'dispute not found or not currently awaiting a carrier response' });
        return;
      }
      return { disputeId: id, status: 'partial' };
    } catch (err) {
      if (err instanceof DisputeTransitionError && err.code === 'ACCEPTED_AMOUNT_EXCEEDS_CLAIMED') {
        await reply.code(422).send({ error: 'acceptedAmount exceeds the dispute\'s amount_claimed' });
        return;
      }
      throw err;
    }
  });

  routes.post('/api/disputes/:id/close', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid dispute id: must be a well-formed UUID' });
      return;
    }
    if (!request.actorUserId) {
      await reply.code(401).send({ error: 'authenticated analyst identity required' });
      return;
    }

    const result = await withTenantTx(request.tenantContext!, (client) =>
      closeDispute(client, id, request.actorUserId!));
    if (!result.found) {
      await reply.code(409).send({ error: 'dispute not found or not currently in a resolved (accepted/rejected/partial) state' });
      return;
    }
    return { disputeId: id, status: 'closed' };
  });

  // P4.C.8: the append-only communications log for a dispute. GET lists
  // both directions (outbound rows are written by
  // deliver-dispute-command-handler.ts's own workflow step, never via a
  // route); POST records an inbound one only -- an analyst logging a
  // carrier's reply, since no automatic inbound channel exists yet (same
  // "no live caller wired in" boundary DISPUTE_DELIVERY_MESSAGE_TYPE's own
  // doc comment names). Outbound is deliberately not postable here: that
  // would let a client bypass the audited workflow_outbox_message path
  // this task's own Exclusions section draws the line at
  // ("no unaudited outbound delivery").
  routes.get('/api/disputes/:id/communications', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid dispute id: must be a well-formed UUID' });
      return;
    }
    const detail = await withTenantTx(request.tenantContext!, (client) => getDisputeDetail(client, id));
    if (!detail) {
      await reply.code(404).send({ error: 'dispute not found' });
      return;
    }
    const communications = await withTenantTx(request.tenantContext!, (client) => listDisputeCommunications(client, id));
    return { communications };
  });

  routes.post('/api/disputes/:id/communications', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid dispute id: must be a well-formed UUID' });
      return;
    }
    if (!request.actorUserId) {
      await reply.code(401).send({ error: 'authenticated analyst identity required' });
      return;
    }

    const requestBody = request.body as { body?: unknown; idempotencyKey?: unknown };
    if (typeof requestBody.body !== 'string' || requestBody.body.trim().length === 0) {
      await reply.code(400).send({ error: 'body is required' });
      return;
    }
    if (requestBody.idempotencyKey !== undefined
      && (typeof requestBody.idempotencyKey !== 'string' || requestBody.idempotencyKey.trim().length === 0)) {
      await reply.code(400).send({ error: 'invalid idempotencyKey: must be a non-empty string' });
      return;
    }
    // A caller-supplied idempotencyKey makes a retried request stable
    // (same dedupe key both times); without one, each POST is its own
    // distinct communication -- the caller opted out of dedup, not an error.
    const dedupeKey = typeof requestBody.idempotencyKey === 'string'
      ? `dispute-comm-inbound:${id}:${requestBody.idempotencyKey}`
      : `dispute-comm-inbound:${id}:${randomUUID()}`;

    try {
      const result = await withTenantTx(request.tenantContext!, (client) =>
        recordDisputeCommunication(client, {
          disputeId: id,
          direction: 'inbound',
          body: requestBody.body as string,
          dedupeKey,
        }));
      await reply.code(result.created ? 201 : 200).send({ disputeCommId: result.disputeCommId, created: result.created });
      return;
    } catch (err) {
      if (err instanceof RecordDisputeCommunicationError && err.code === 'DISPUTE_NOT_FOUND') {
        await reply.code(404).send({ error: 'dispute not found' });
        return;
      }
      throw err;
    }
  });
}
