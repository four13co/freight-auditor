import type pg from 'pg';

/**
 * 86e2xb911: PDF invoice draft's carrier resolution.
 *
 * EDI ingestion (86e2v17u9) never has this problem -- the caller passes an
 * explicit contractVersionId/carrierId (Greg's DECISION, option b), no
 * inference from the document. A PDF has no such explicit param; the LLM
 * extracts a free-text carrier name off the page, which must be resolved to
 * a carrier_id -- exactly the fuzzy/ambiguous matching the item's own Rabbit
 * holes call out as needing "its own resolution flow... not silent
 * best-guessing."
 *
 * Matching is deliberately simple (case-insensitive exact, then substring)
 * rather than a fuzzy-string-distance library: the item's No-gos don't ask
 * for sophisticated matching, only for ambiguity to surface honestly instead
 * of being guessed. A single unambiguous match auto-resolves; anything else
 * (zero matches, or more than one) becomes carrier_candidates for the
 * analyst to pick from in the draft-review step.
 */
export interface CarrierCandidate {
  carrierId: string;
  name: string;
}

export interface CarrierMatchResult {
  /** Set only when exactly one carrier matched unambiguously. */
  carrierId: string | null;
  /** All matches considered (0, 1, or many) -- empty when carrierId is set from an exact single match with nothing else to report. */
  candidates: CarrierCandidate[];
}

/**
 * Resolve a free-text carrier name (as extracted from a PDF) against the
 * `carrier` catalog. Must run inside a tenant transaction (withTenantTx) --
 * relies on RLS to expose only rows this tenant may see.
 */
export async function matchCarrierName(
  client: pg.PoolClient,
  rawName: string,
): Promise<CarrierMatchResult> {
  const trimmed = rawName.trim();
  if (trimmed.length === 0) {
    return { carrierId: null, candidates: [] };
  }

  // Exact case-insensitive match first -- if exactly one, resolve without
  // ambiguity even if a broader substring search would also find it (an
  // exact name match is never ambiguous just because it's also a substring
  // of a different carrier's name).
  const exact = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM carrier WHERE lower(name) = lower($1)`,
    [trimmed],
  );
  if (exact.rowCount === 1) {
    return { carrierId: exact.rows[0]!.id, candidates: [] };
  }
  if (exact.rowCount! > 1) {
    return {
      carrierId: null,
      candidates: exact.rows.map((r) => ({ carrierId: r.id, name: r.name })),
    };
  }

  // No exact match -- fall back to substring, either direction (the PDF
  // text might carry a longer legal name than the catalog, or vice versa).
  const fuzzy = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM carrier
     WHERE lower(name) LIKE '%' || lower($1) || '%'
        OR lower($1) LIKE '%' || lower(name) || '%'`,
    [trimmed],
  );
  if (fuzzy.rowCount === 1) {
    return { carrierId: fuzzy.rows[0]!.id, candidates: [] };
  }
  // Zero or many -- both are "surface for the analyst," never a guess.
  return {
    carrierId: null,
    candidates: fuzzy.rows.map((r) => ({ carrierId: r.id, name: r.name })),
  };
}
