import type pg from 'pg';

/**
 * One row of the client portal's findings list (P6.B.2) -- same join shape
 * as the internal listFindings (../findings/list-findings.ts), with an
 * added explicit `client_id` predicate (86e31a9ch/#216 precedent: on top
 * of RLS, not a replacement for it). `clientIds` (list-findings.ts's own
 * API-symmetry-only, unused-as-a-filter field) is deliberately dropped from
 * this options shape -- the client scope here is bound structurally by the
 * caller's resolved clientId param, never by a caller-supplied filter.
 */
export interface ClientFindingRow {
  id: string;
  auditRunId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  carrierName: string | null;
  billed: string | null;
  expected: string | null;
  varianceAmount: string | null;
  direction: string | null;
  status: string;
  createdAt: Date;
  ruleDescription: string | null;
}

export type ClientFindingsSortKey = 'variance' | 'age';
export type ClientFindingsSortDir = 'asc' | 'desc';

export interface ListClientFindingsOptions {
  carrier?: string;
  status?: string;
  minAmount?: string;
  limit?: number;
  offset?: number;
  sort?: ClientFindingsSortKey;
  sortDir?: ClientFindingsSortDir;
}

const DEFAULT_LIMIT = 50;

// Mirrors list-findings.ts's own ORDER_COLUMNS allowlist exactly -- the same
// injection-boundary reasoning applies (sort/sortDir feed an ORDER BY, which
// can't be parameter-bound).
const ORDER_COLUMNS: Record<ClientFindingsSortKey, string> = {
  variance: 'variance_finding.variance_amount',
  age: 'variance_finding.created_at',
};

/**
 * List variance_finding rows for the given client, joined to their
 * billed/expected amounts and carrier -- same query shape as
 * listFindings, plus an explicit `variance_finding.client_id = $1`
 * predicate so a caller resolving a broader-than-intended scope still
 * can't leak another tenant's findings through this function.
 */
export async function listClientFindings(
  client: pg.PoolClient,
  clientId: string,
  options: ListClientFindingsOptions = {},
): Promise<ClientFindingRow[]> {
  const conditions: string[] = ['variance_finding.client_id = $1'];
  const params: unknown[] = [clientId];

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

  const where = `WHERE ${conditions.join(' AND ')}`;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;

  const sortColumn = options.sort ? ORDER_COLUMNS[options.sort] : 'variance_finding.created_at';
  const sortDir = options.sortDir === 'asc' ? 'ASC' : 'DESC';
  const orderBy = options.sort === 'variance'
    ? `ORDER BY ${sortColumn} ${sortDir} NULLS LAST`
    : `ORDER BY ${sortColumn} ${sortDir}`;

  params.push(limit, offset);


  const result = await client.query<{
    id: string;
    audit_run_id: string;
    invoice_id: string;
    invoice_number: string | null;
    carrier_name: string | null;
    billed: string | null;
    expected: string | null;
    variance_amount: string | null;
    direction: string | null;
    status: string;
    created_at: Date;
    rule_description: string | null;
  }>(
    `SELECT
       variance_finding.id,
       variance_finding.audit_run_id,
       invoice.id AS invoice_id,
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
     LEFT JOIN charge_fact ON charge_fact.id = variance_finding.charge_fact_id
     JOIN audit_run ON audit_run.id = variance_finding.audit_run_id
     JOIN invoice ON invoice.id = COALESCE(charge_fact.invoice_id, audit_run.invoice_id)
     LEFT JOIN carrier ON carrier.id = invoice.carrier_id
     LEFT JOIN LATERAL (
       SELECT expected_amount
       FROM expected_charge
       WHERE expected_charge.charge_fact_id = charge_fact.id
       ORDER BY expected_charge.created_at DESC
       LIMIT 1
     ) expected_charge ON true
     LEFT JOIN LATERAL (
       SELECT description
       FROM criterion_version
       WHERE criterion_version.criterion_id = variance_finding.criterion_id
       ORDER BY criterion_version.recorded_at DESC
       LIMIT 1
     ) criterion_version ON true
     ${where}
     ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    auditRunId: row.audit_run_id,
    invoiceId: row.invoice_id,
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
