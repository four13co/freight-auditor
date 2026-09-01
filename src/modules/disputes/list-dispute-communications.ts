import type pg from 'pg';

export interface DisputeCommRow {
  id: string;
  direction: string;
  body: string | null;
  recordedAt: Date;
}

/**
 * Tenant-scoped read of a dispute's append-only communications log
 * (P4.C.8), newest first -- mirrors dispute_comm_dispute_idx's own
 * (client_id, dispute_id, recorded_at DESC) shape, so this is an index-only
 * scan rather than a sort.
 *
 * Returns an empty array for a dispute that doesn't exist or isn't visible
 * under RLS for this tenant, matching get-dispute-detail.ts's sibling
 * dispute_line query (also a plain empty-array-on-no-match, not a
 * dispute-existence check of its own) rather than throwing -- the caller
 * (the /:id route) already 404s on the dispute lookup itself.
 */
export async function listDisputeCommunications(client: pg.PoolClient, disputeId: string): Promise<DisputeCommRow[]> {
  const { rows } = await client.query<{ id: string; direction: string; body: string | null; recorded_at: Date }>(
    `SELECT id, direction, body, recorded_at FROM dispute_comm WHERE dispute_id = $1 ORDER BY recorded_at DESC`,
    [disputeId],
  );
  return rows.map((r) => ({ id: r.id, direction: r.direction, body: r.body, recordedAt: r.recorded_at }));
}
