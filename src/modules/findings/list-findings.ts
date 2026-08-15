import type pg from 'pg';

/**
 * One row of the findings list (86e2u7j0d). Runs inside the caller's
 * withTenantTx — RLS is FORCE-enabled on variance_finding, so a query issued
 * outside that transaction silently returns zero rows, never an error.
 *
 * Lane/origin-dest is deliberately omitted (see the item's rabbit holes):
 * transport_document.document's jsonb path for it is undocumented.
 */
export interface FindingRow {
  id: string;
  invoiceNumber: string | null;
  carrierName: string | null;
  billed: string;
  expected: string | null;
  varianceAmount: string | null;
  direction: string | null;
  status: string;
  createdAt: Date;
  ruleDescription: string | null;
}

export interface ListFindingsOptions {
  /** Present so a caller can pass its TenantContext straight through if useful; not used to filter — RLS already scopes rows. */
  clientIds?: string[];
  carrier?: string;
  status?: string;
  minAmount?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;

/**
 * List variance_finding rows joined to their billed/expected amounts and
 * carrier, for the tenant scope already bound by the caller's withTenantTx.
 *
 * `clientIds` in `options` is accepted for API symmetry with the tenant
 * context but is NOT used as a WHERE filter — RLS (forced on variance_finding)
 * already restricts visible rows to the transaction's tenant scope. Filtering
 * again here would be redundant and could mask an RLS misconfiguration by
 * appearing to work via the app-level filter instead.
 */
export async function listFindings(
  client: pg.PoolClient,
  options: ListFindingsOptions = {},
): Promise<FindingRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.carrier) {
    params.push(options.carrier);
    conditions.push(`carrier.name = $${params.length}`);
  }
  if (options.status) {
    params.push(options.status);
    conditions.push(`variance_finding.status = $${params.length}::variance_status`);
  }
  if (options.minAmount) {
    params.push(options.minAmount);
    conditions.push(`variance_finding.variance_amount >= $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;
  params.push(limit, offset);

  const result = await client.query<{
    id: string;
    invoice_number: string | null;
    carrier_name: string | null;
    billed: string;
    expected: string | null;
    variance_amount: string | null;
    direction: string | null;
    status: string;
    created_at: Date;
    rule_description: string | null;
  }>(
    `SELECT
       variance_finding.id,
       invoice.invoice_number,
       carrier.name AS carrier_name,
       charge_fact.amount AS billed,
       expected_charge.expected_amount AS expected,
       variance_finding.variance_amount,
       variance_finding.direction,
       variance_finding.status,
       variance_finding.created_at,
       criterion_version.description AS rule_description
     FROM variance_finding
     JOIN charge_fact ON charge_fact.id = variance_finding.charge_fact_id
     JOIN invoice ON invoice.id = charge_fact.invoice_id
     LEFT JOIN carrier ON carrier.id = invoice.carrier_id
     -- expected_charge.charge_fact_id has no uniqueness constraint (migration
     -- 0007), so a plain JOIN can row-multiply a finding if more than one
     -- expected_charge row ever exists for the same charge. LATERAL + LIMIT 1
     -- guarantees at most one expected_charge per finding regardless (86e2u7j0d
     -- Review finding); most-recent by created_at is the deterministic pick.
     LEFT JOIN LATERAL (
       SELECT expected_amount
       FROM expected_charge
       WHERE expected_charge.charge_fact_id = charge_fact.id
       ORDER BY expected_charge.created_at DESC
       LIMIT 1
     ) expected_charge ON true
     -- criterion_version is bitemporal/append-only (migration 0006) -- many
     -- rows can exist per criterion_id. variance_finding.criterion_id
     -- references criterion, not a specific criterion_version, and nothing
     -- in this codebase reads valid_from/valid_to yet, so this takes the
     -- most-recently-recorded description rather than the one "valid at
     -- finding time" (86e2up8c8 -- no existing convention to match, and the
     -- item's own No-gos scope this to surfacing existing metadata, not
     -- building point-in-time resolution).
     LEFT JOIN LATERAL (
       SELECT description
       FROM criterion_version
       WHERE criterion_version.criterion_id = variance_finding.criterion_id
       ORDER BY criterion_version.recorded_at DESC
       LIMIT 1
     ) criterion_version ON true
     ${where}
     ORDER BY variance_finding.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoice_number,
    carrierName: row.carrier_name,
    billed: row.billed,
    expected: row.expected,
    varianceAmount: row.variance_amount,
    direction: row.direction,
    status: row.status,
    createdAt: row.created_at,
    ruleDescription: row.rule_description,
  }));
}
