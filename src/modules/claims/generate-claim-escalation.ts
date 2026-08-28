import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const schema = z.object({
  clientId: z.uuid(),
  claimId: z.uuid(),
  escalationGraceDays: z.number().int().positive().max(365).default(7),
}).strict();

export const CLAIM_ESCALATION_EVENT = 'claim.escalated';

/**
 * Duplicates the string literal from generate-claim-follow-up.ts's
 * CLAIM_FOLLOW_UP_EVENT (P5.B.2/#179, still open/unmerged) rather than
 * importing it, same string-literal-coupling treatment as
 * derive-claim-status.ts's CLAIM_TERMINAL_EVENTS (P5.A.5/#175) against
 * resolve-claim.ts (#174). Once #179 merges, this should import
 * CLAIM_FOLLOW_UP_EVENT rather than keep its own literal.
 */
const CLAIM_FOLLOW_UP_EVENT = 'claim.follow_up_sent';

export class GenerateClaimEscalationError extends Error {
  constructor(
    readonly code:
      | 'CLAIM_NOT_FOUND'
      | 'CLAIM_TERMINAL'
      | 'NO_FOLLOW_UP_SENT'
      | 'GRACE_PERIOD_NOT_ELAPSED',
  ) {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'GenerateClaimEscalationError';
  }
}

export interface GenerateClaimEscalationResult {
  claimId: string;
  created: boolean;
}

const TERMINAL_STATUSES = new Set(['recovered', 'denied', 'written_off']);

/**
 * Generates an escalation marker for a claim that already had a follow-up
 * sent (P5.B.2/#179) and remains open past a grace period since that
 * follow-up (P5.B.3). Escalation is a SECOND-stage action, not a
 * replacement for the deadline check that gates follow-up itself
 * (P5.B.1/#178) -- this function does not re-check aging_deadline_at
 * directly; it trusts that a claim.follow_up_sent event could only exist
 * because that check already passed once.
 *
 * escalationGraceDays defaults to 7 -- how long to wait after a follow-up
 * before escalating, same "accept as a parameter with a sane default"
 * treatment this session used for holdThenApprove/shortPayEnabled/
 * agingDays, since no per-client config for this exists yet.
 *
 * Idempotent per claim: checks for an existing claim.escalated audit_event
 * before writing a new one, same pattern as generateClaimFollowUp.
 *
 * Refuses a claim already in a terminal status, and a claim with no
 * follow-up event yet (escalation cannot skip the follow-up stage).
 */
export async function generateClaimEscalation(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<GenerateClaimEscalationResult> {
  const input = schema.parse(untrusted);

  const { rows: claimRows } = await client.query<{ status: string }>(
    `SELECT status FROM claim WHERE client_id = $1 AND id = $2`,
    [input.clientId, input.claimId],
  );
  const claimRow = claimRows[0];
  if (!claimRow) throw new GenerateClaimEscalationError('CLAIM_NOT_FOUND');
  if (TERMINAL_STATUSES.has(claimRow.status)) throw new GenerateClaimEscalationError('CLAIM_TERMINAL');

  const { rows: followUpRows } = await client.query<{ recorded_at: string }>(
    `SELECT recorded_at FROM audit_event
      WHERE client_id = $1 AND entity = 'claim' AND entity_id = $2 AND event = $3
      ORDER BY recorded_at ASC LIMIT 1`,
    [input.clientId, input.claimId, CLAIM_FOLLOW_UP_EVENT],
  );
  const followUpRow = followUpRows[0];
  if (!followUpRow) throw new GenerateClaimEscalationError('NO_FOLLOW_UP_SENT');

  const graceElapsesAt = new Date(followUpRow.recorded_at);
  graceElapsesAt.setUTCDate(graceElapsesAt.getUTCDate() + input.escalationGraceDays);
  if (graceElapsesAt.getTime() > Date.now()) {
    throw new GenerateClaimEscalationError('GRACE_PERIOD_NOT_ELAPSED');
  }

  const { rows: existing } = await client.query<{ id: string }>(
    `SELECT id FROM audit_event WHERE client_id = $1 AND entity = 'claim' AND entity_id = $2 AND event = $3`,
    [input.clientId, input.claimId, CLAIM_ESCALATION_EVENT],
  );
  if (existing[0]) {
    return { claimId: input.claimId, created: false };
  }

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.claimId, CLAIM_ESCALATION_EVENT),
    clientId: input.clientId,
    entity: 'claim',
    entityId: input.claimId,
    event: CLAIM_ESCALATION_EVENT,
    actorKind: 'system',
    detail: { followUpSentAt: followUpRow.recorded_at, escalationGraceDays: input.escalationGraceDays },
  });

  return { claimId: input.claimId, created: true };
}
