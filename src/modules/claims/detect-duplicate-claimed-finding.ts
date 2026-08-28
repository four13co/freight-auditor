import type pg from 'pg';

export class DuplicateClaimedFindingError extends Error {
  constructor(readonly conflictingFindingIds: string[]) {
    super('one or more variance findings backing this dispute are already claimed by another dispute');
    this.name = 'DuplicateClaimedFindingError';
  }
}

/**
 * Prevents the same variance_finding's recovered dollars from being claimed
 * twice through two DIFFERENT disputes (P5.A.2, 86e2zfj4w).
 *
 * No single-table constraint can express this -- the rule spans
 * claim -> dispute -> dispute_line -> variance_finding, and dispute_line
 * carries no unique index on variance_finding_id (a finding can legitimately
 * appear on more than one dispute's line before either is claimed; the
 * violation only exists once a SECOND dispute sharing a finding is also
 * claimed). So this is a query-time check, not a migration.
 *
 * Distinct from P4.C.2 (detect-duplicate-finding-inclusion.ts, 86e2zfhj6):
 * that guard fires at dispute-CREATION time (the same finding entering two
 * disputes); this one fires at claim-CREATION time (the same finding's
 * dollars being claimed twice). Both are needed -- a finding can enter two
 * disputes without either ever being claimed, which is not yet a problem.
 *
 * Called directly from createClaimFromDispute (not shipped as a standalone,
 * unwired module) -- #166's review closure this session found a guard that
 * prevented nothing in practice because nothing called it.
 */
export async function detectDuplicateClaimedFinding(
  client: pg.PoolClient,
  clientId: string,
  disputeId: string,
): Promise<void> {
  const { rows } = await client.query<{ variance_finding_id: string }>(
    `SELECT DISTINCT dl.variance_finding_id
       FROM dispute_line dl
       JOIN dispute_line other_dl
         ON other_dl.client_id = dl.client_id
        AND other_dl.variance_finding_id = dl.variance_finding_id
        AND other_dl.dispute_id != dl.dispute_id
       JOIN claim c
         ON c.client_id = other_dl.client_id
        AND c.dispute_id = other_dl.dispute_id
      WHERE dl.client_id = $1
        AND dl.dispute_id = $2
        AND dl.variance_finding_id IS NOT NULL`,
    [clientId, disputeId],
  );

  if (rows.length > 0) {
    throw new DuplicateClaimedFindingError(rows.map((row) => row.variance_finding_id));
  }
}
