import type pg from 'pg';

export interface UpdateFindingStatusResult {
  /** false when the finding doesn't exist / isn't visible under RLS for this tenant -- caller maps this to 404. */
  found: boolean;
}

/**
 * Transition a variance_finding's status (86e2v1xyr). Runs the UPDATE +
 * finding_status_event INSERT in one statement (a CTE chain) so a caller
 * wrapping this in withTenantTx gets one atomic transition -- the mutable
 * current-state row and its append-only history never diverge.
 *
 * The `old` CTE captures the pre-update status in the same statement as the
 * UPDATE, avoiding both a separate SELECT round trip and any TOCTOU gap a
 * read-then-write pair would have under concurrent transitions.
 *
 * RLS (FORCE-enabled on variance_finding) means the UPDATE affects zero rows
 * for a finding outside the caller's tenant scope -- the same "silently
 * zero, never an error" convention listFindings relies on -- so `found:
 * false` covers both "doesn't exist" and "not yours," and no
 * finding_status_event row is written in that case either (the INSERT CTE
 * only fires for rows the UPDATE actually touched).
 */
export async function updateFindingStatus(
  client: pg.PoolClient,
  findingId: string,
  toStatus: string,
  note?: string,
): Promise<UpdateFindingStatusResult> {
  const result = await client.query<{ id: string; client_id: string; from_status: string }>(
    `WITH old AS (
       SELECT id, client_id, status AS from_status FROM variance_finding WHERE id = $1
     ),
     updated AS (
       UPDATE variance_finding
       SET status = $2::variance_status
       WHERE id = (SELECT id FROM old)
       RETURNING id, client_id
     ),
     logged AS (
       INSERT INTO finding_status_event (client_id, variance_finding_id, from_status, to_status, actor_kind, note)
       SELECT updated.client_id, updated.id, old.from_status, $2::variance_status, 'analyst', $3
       FROM updated JOIN old ON true
       RETURNING variance_finding_id
     )
     SELECT id, client_id, (SELECT from_status FROM old) AS from_status FROM updated`,
    [findingId, toStatus, note ?? null],
  );

  const row = result.rows[0];
  if (!row) return { found: false };
  return { found: true };
}
