import type pg from 'pg';

export class DuplicateFindingInclusionError extends Error {
  constructor(readonly conflictingFindingIds: string[]) {
    super('one or more variance findings are already included on another dispute');
    this.name = 'DuplicateFindingInclusionError';
  }
}

/**
 * Prevents the same variance_finding from being included on more than one
 * dispute_line (P4.C.2, 86e2zfhj6).
 *
 * createDisputeFromFindings already filters candidate findings to
 * status='accepted' at fetch time, which covers the common case (a finding
 * already queued/disputed is no longer 'accepted'). That filter alone isn't
 * structural: two concurrent calls can both read the same finding as
 * accepted before either commits its updateFindingStatus transition, and
 * any future path that moves a finding back to 'accepted' (e.g. a
 * rejected-dispute rework flow -- not yet built) would silently reopen it
 * for double inclusion. This query-time check plus the partial unique index
 * on dispute_line(client_id, variance_finding_id) (migration 0051) together
 * close both gaps -- the index is the race backstop, this is the readable
 * pre-insert error.
 *
 * Distinct from P5.A.2 (detect-duplicate-claimed-finding.ts, 86e2zfj4w):
 * that guard fires at claim-CREATION time (the same finding's dollars being
 * claimed twice across two disputes); this one fires at dispute-CREATION
 * time (the same finding entering two disputes at all, claimed or not).
 *
 * Called directly from createDisputeFromFindings (not shipped as a
 * standalone, unwired module) -- the #166 lesson: a guard that nothing
 * calls prevents nothing in practice.
 */
export async function detectDuplicateFindingInclusion(
  client: pg.PoolClient,
  clientId: string,
  findingIds: readonly string[],
): Promise<void> {
  if (findingIds.length === 0) return;
  const { rows } = await client.query<{ variance_finding_id: string }>(
    `SELECT DISTINCT variance_finding_id
       FROM dispute_line
      WHERE client_id = $1
        AND variance_finding_id = ANY($2::uuid[])`,
    [clientId, findingIds],
  );

  if (rows.length > 0) {
    throw new DuplicateFindingInclusionError(rows.map((row) => row.variance_finding_id));
  }
}
