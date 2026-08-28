import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const schema = z.object({ clientId: z.uuid(), claimId: z.uuid() }).strict();

export const CLAIM_FOLLOW_UP_EVENT = 'claim.follow_up_sent';

export class GenerateClaimFollowUpError extends Error {
  constructor(readonly code: 'CLAIM_NOT_FOUND' | 'DEADLINE_NOT_SET' | 'DEADLINE_NOT_PASSED' | 'CLAIM_TERMINAL') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'GenerateClaimFollowUpError';
  }
}

export interface GenerateClaimFollowUpResult {
  claimId: string;
  created: boolean;
}

const TERMINAL_STATUSES = new Set(['recovered', 'denied', 'written_off']);

/**
 * Generates a follow-up marker for a claim whose aging_deadline_at
 * (P5.B.1/#178) has passed (P5.B.2). Records a claim.follow_up_sent
 * audit_event; does NOT send any outbound communication itself -- what a
 * "follow-up" actually delivers (an email, a dispute_comm row) is a later
 * item's boundary (P4.C.8's inbound/outbound communications log, not yet
 * built). This is the trigger/marker layer only.
 *
 * Idempotent per claim: checks for an existing claim.follow_up_sent
 * audit_event before writing a new one. A retry (the same claim job fired
 * twice, e.g. by an at-least-once queue) finds the existing marker and
 * returns created: false rather than writing a duplicate.
 *
 * Refuses a claim already in a terminal status (recovered/denied/
 * written_off, P5.A.4/#174's vocabulary) -- following up on a claim that
 * is already resolved would be meaningless, and this must fail rather than
 * silently proceed.
 */
export async function generateClaimFollowUp(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<GenerateClaimFollowUpResult> {
  const input = schema.parse(untrusted);

  const { rows: claimRows } = await client.query<{ status: string; aging_deadline_at: string | null }>(
    `SELECT status, aging_deadline_at FROM claim WHERE client_id = $1 AND id = $2`,
    [input.clientId, input.claimId],
  );
  const claimRow = claimRows[0];
  if (!claimRow) throw new GenerateClaimFollowUpError('CLAIM_NOT_FOUND');
  if (TERMINAL_STATUSES.has(claimRow.status)) throw new GenerateClaimFollowUpError('CLAIM_TERMINAL');
  if (!claimRow.aging_deadline_at) throw new GenerateClaimFollowUpError('DEADLINE_NOT_SET');
  if (new Date(claimRow.aging_deadline_at).getTime() > Date.now()) {
    throw new GenerateClaimFollowUpError('DEADLINE_NOT_PASSED');
  }

  const { rows: existing } = await client.query<{ id: string }>(
    `SELECT id FROM audit_event WHERE client_id = $1 AND entity = 'claim' AND entity_id = $2 AND event = $3`,
    [input.clientId, input.claimId, CLAIM_FOLLOW_UP_EVENT],
  );
  if (existing[0]) {
    return { claimId: input.claimId, created: false };
  }

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.claimId, CLAIM_FOLLOW_UP_EVENT),
    clientId: input.clientId,
    entity: 'claim',
    entityId: input.claimId,
    event: CLAIM_FOLLOW_UP_EVENT,
    actorKind: 'system',
    detail: { agingDeadlineAt: claimRow.aging_deadline_at },
  });

  return { claimId: input.claimId, created: true };
}
