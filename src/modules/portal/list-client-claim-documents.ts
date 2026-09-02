import type pg from 'pg';

export interface ClaimDocumentRef {
  id: string;
  sha256: string;
  storageUri: string;
}

/**
 * Resolves the distinct source-document references backing a claim's
 * evidence (P6.B.4), via claim -> claim.dispute_id -> dispute_line ->
 * variance_finding -> source_document.
 *
 * Deliberately a direct join rather than buildEvidencePacket
 * (../disputes/build-evidence-packet.ts): that function throws
 * INCOMPLETE_EVIDENCE when ANY dispute_line on the dispute lacks a
 * variance_finding_id, which would report zero documents for a claim whose
 * dispute has even one findingless line alongside otherwise-good ones. A
 * direct join drops a findingless (or document-less) line via the JOIN
 * instead of failing the whole request, so the good lines' documents still
 * surface -- also avoids building a full defensibility chain + computation
 * trace per line just to discard everything but sourceDocument.
 *
 * Returns null when the claim doesn't exist / isn't visible to this
 * clientId -- an explicit predicate on the driving claim row, not RLS
 * alone (86e31a9ch/#216 precedent, matching get-claim-detail.ts's own
 * convention). Returns an empty array when the claim has no originating
 * dispute (`c.dispute_id IS NULL` never matches `dl.dispute_id`, so the
 * join naturally yields nothing -- no special-casing needed) or that
 * dispute's lines resolve no source documents yet.
 */
export async function listClientClaimDocuments(
  client: pg.PoolClient,
  clientId: string,
  claimId: string,
): Promise<ClaimDocumentRef[] | null> {
  const claimCheck = await client.query(`SELECT id FROM claim WHERE client_id = $1 AND id = $2`, [clientId, claimId]);
  if (!claimCheck.rowCount) return null;

  const { rows } = await client.query<{ id: string; sha256: string; storage_uri: string }>(
    `SELECT DISTINCT sd.id, sd.sha256, sd.storage_uri
       FROM claim c
       JOIN dispute_line dl ON dl.client_id = c.client_id AND dl.dispute_id = c.dispute_id
       JOIN variance_finding vf ON vf.client_id = c.client_id AND vf.id = dl.variance_finding_id
       JOIN source_document sd ON sd.id = vf.source_document_id
      WHERE c.client_id = $1 AND c.id = $2
      ORDER BY sd.id`,
    [clientId, claimId],
  );
  return rows.map((r) => ({ id: r.id, sha256: r.sha256, storageUri: r.storage_uri }));
}
