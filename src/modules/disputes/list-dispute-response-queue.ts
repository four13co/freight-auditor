import type pg from 'pg';

const RESPONSE_PENDING_STATUSES = ['sent', 'in_progress'];

// No existing config carries a dispute-response-specific SLA (same gap
// compute-claim-aging-deadline.ts's agingDays default documents) -- accepted
// as a caller-overridable parameter with a sane default, matching
// listClaimsDueForEscalation's gracePeriodDays convention, rather than a
// business rule baked into the query itself.
const DEFAULT_THRESHOLD_DAYS = 5;

export interface DisputeResponseQueueEntry {
  disputeId: string;
  lastOutboundAt: string;
}

/**
 * Lists disputes overdue for a carrier response (P4.C.10), mirroring
 * list-claim-aging-queues.ts's shape: a dispute is "response overdue" when
 * its status is 'sent' or 'in_progress' and its most recent dispute_comm row
 * is outbound and older than `thresholdDays`.
 *
 * The INNER LATERAL join to each dispute's latest dispute_comm row (ordered
 * by recorded_at DESC, dispute_comm is indexed on (client_id, dispute_id,
 * recorded_at DESC)) means a dispute with no dispute_comm rows at all
 * (still 'draft', never sent) produces no joined row and is silently
 * excluded -- there is nothing yet to be overdue on.
 *
 * `clientId` is an explicit predicate on top of RLS, not a replacement for
 * it (86e31a9ch/#216 precedent, most recently list-claims.ts).
 */
export async function listDisputesDueForResponse(
  client: pg.PoolClient,
  clientId: string,
  now: Date = new Date(),
  thresholdDays: number = DEFAULT_THRESHOLD_DAYS,
): Promise<DisputeResponseQueueEntry[]> {
  const result = await client.query<{ id: string; recorded_at: Date }>(
    `SELECT d.id, lc.recorded_at
     FROM dispute d
     JOIN LATERAL (
       SELECT direction, recorded_at
       FROM dispute_comm dc
       WHERE dc.client_id = d.client_id AND dc.dispute_id = d.id
       ORDER BY dc.recorded_at DESC
       LIMIT 1
     ) lc ON true
     WHERE d.client_id = $1
       AND d.status = ANY($4::dispute_status[])
       AND lc.direction = 'outbound'
       AND lc.recorded_at <= $2::timestamptz - make_interval(days => $3)
     ORDER BY lc.recorded_at`,
    [clientId, now.toISOString(), thresholdDays, RESPONSE_PENDING_STATUSES],
  );

  return result.rows.map((row) => ({
    disputeId: row.id,
    lastOutboundAt: row.recorded_at.toISOString(),
  }));
}
