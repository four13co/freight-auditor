import type pg from 'pg';
import { z } from 'zod';

/**
 * The terminal audit_event names #186's deriveClaimStatus/CLAIM_TERMINAL_EVENTS
 * (P5.A.5, still open/unmerged) treats as authoritative over claim.status --
 * that PR established status is DERIVED from these events, not read
 * directly off the column, so this queue filters the same way rather than
 * trusting claim.status (which can lag or diverge). Duplicated as string
 * literals rather than imported, same disclosed-duplication treatment
 * #187 (P5.B.3) gave this exact set of names.
 */
const CLAIM_TERMINAL_EVENT_NAMES = ['claim.recovered', 'claim.denied', 'claim.written_off'] as const;

/**
 * The audit_event name #184's generateClaimFollowUp (P5.B.2, still
 * open/unmerged) writes once a claim has been followed up on. Duplicated
 * as a string literal, same treatment #187 gave it as CLAIM_FOLLOW_UP_EVENT.
 */
const CLAIM_FOLLOW_UP_EVENT = 'claim.follow_up_sent';

const schema = z.object({
  clientId: z.uuid(),
  now: z.date().default(() => new Date()),
}).strict();

export interface ClaimAgingQueueEntry {
  claimId: string;
  agingDeadlineAt: string;
}

export interface ClaimEscalationQueueEntry {
  claimId: string;
  followUpSentAt: string;
}

/**
 * Lists claims due for a follow-up job (P5.B.2's generateClaimFollowUp is
 * the per-claim action this enumerates candidates for): not terminal, has
 * an aging_deadline_at that has passed, and has no claim.follow_up_sent
 * event yet. This is the list-form of generateClaimFollowUp's own
 * eligibility gate -- a scheduler calls this to find claimIds, then
 * dispatches generateClaimFollowUp per id.
 */
export async function listClaimsDueForFollowUp(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<ClaimAgingQueueEntry[]> {
  const input = schema.parse(untrusted);

  const result = await client.query<{ id: string; aging_deadline_at: Date }>(
    `SELECT c.id, c.aging_deadline_at
     FROM claim c
     WHERE c.client_id = $1
       AND c.aging_deadline_at IS NOT NULL
       AND c.aging_deadline_at <= $2
       AND NOT EXISTS (
         SELECT 1 FROM audit_event ae
         WHERE ae.client_id = c.client_id AND ae.entity = 'claim' AND ae.entity_id = c.id
           AND ae.event = ANY($3::text[])
       )
     ORDER BY c.aging_deadline_at`,
    [input.clientId, input.now.toISOString(), [...CLAIM_TERMINAL_EVENT_NAMES, CLAIM_FOLLOW_UP_EVENT]],
  );

  return result.rows.map((row) => ({
    claimId: row.id,
    agingDeadlineAt: row.aging_deadline_at.toISOString(),
  }));
}

/**
 * Lists claims due for escalation (P5.B.3's generateClaimEscalation is the
 * per-claim action this enumerates candidates for): has a
 * claim.follow_up_sent event, remains not terminal, and gracePeriodDays
 * have elapsed since that follow-up. This is the list-form of
 * generateClaimEscalation's own eligibility gate.
 */
export async function listClaimsDueForEscalation(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
  gracePeriodDays: number = 7,
): Promise<ClaimEscalationQueueEntry[]> {
  const input = schema.parse(untrusted);

  const result = await client.query<{ id: string; follow_up_sent_at: Date }>(
    `SELECT c.id, fu.recorded_at AS follow_up_sent_at
     FROM claim c
     JOIN LATERAL (
       SELECT ae.recorded_at
       FROM audit_event ae
       WHERE ae.client_id = c.client_id AND ae.entity = 'claim' AND ae.entity_id = c.id
         AND ae.event = $3
       ORDER BY ae.recorded_at DESC
       LIMIT 1
     ) fu ON true
     WHERE c.client_id = $1
       AND fu.recorded_at <= $2::timestamptz - make_interval(days => $4)
       AND NOT EXISTS (
         SELECT 1 FROM audit_event ae2
         WHERE ae2.client_id = c.client_id AND ae2.entity = 'claim' AND ae2.entity_id = c.id
           AND ae2.event = ANY($5::text[])
       )
     ORDER BY fu.recorded_at`,
    [input.clientId, input.now.toISOString(), CLAIM_FOLLOW_UP_EVENT, gracePeriodDays, CLAIM_TERMINAL_EVENT_NAMES],
  );

  return result.rows.map((row) => ({
    claimId: row.id,
    followUpSentAt: row.follow_up_sent_at.toISOString(),
  }));
}
