import type pg from 'pg';

export interface AccountDisputeCommRow {
  id: string;
  direction: string;
  body: string | null;
  recordedAt: Date;
}

/**
 * Client portal (P6.B.3) equivalent of the internal listDisputeCommunications
 * (../disputes/list-dispute-communications.ts): same newest-first shape,
 * with an added explicit `account_id` predicate (86e31a9ch/#216 precedent) --
 * the internal function relies on RLS alone. Matches
 * dispute_comm_dispute_idx's own (account_id, dispute_id, recorded_at DESC)
 * shape, so this is an index-only scan rather than a sort, same as the
 * internal function's own header comment notes.
 *
 * Returns an empty array for a dispute that doesn't exist or isn't visible
 * to this clientId, matching the internal function's own convention -- the
 * caller (the portal route) already 404s on the dispute lookup itself.
 */
export async function listAccountDisputeCommunications(
  client: pg.PoolClient,
  clientId: string,
  disputeId: string,
): Promise<AccountDisputeCommRow[]> {
  const { rows } = await client.query<{ id: string; direction: string; body: string | null; recorded_at: Date }>(
    `SELECT id, direction, body, recorded_at
       FROM dispute_comm WHERE dispute_id = $1 AND account_id = $2 ORDER BY recorded_at DESC`,
    [disputeId, clientId],
  );
  return rows.map((r) => ({ id: r.id, direction: r.direction, body: r.body, recordedAt: r.recorded_at }));
}
