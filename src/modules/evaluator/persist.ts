import type pg from 'pg';
import type { ParsedInvoice } from '../ingestion/charge-fact.js';
import type { AuditResult } from './evaluate-invoice.js';

/**
 * Persist a parsed invoice + its audit result into the canonical schema
 * (Master Spec §6.5–§6.7), inside the caller's tenant transaction (withTenantTx).
 *
 * Writes are additive and append-only where the schema demands it (gate_failure,
 * charge_finding are INSERT-only per migration 0010). The audit_run pins the
 * engine spec + rubric snapshot hash so a finding replays byte-identically.
 *
 * This is the thin DB-facing boundary; all judgment lives in the pure evaluator.
 */

export interface PersistInput {
  clientId: string;
  invoice: ParsedInvoice;
  result: AuditResult;
  /** A rubric_snapshot row id (pre-seeded); pins the run for reproducibility. */
  rubricSnapshotId: string | null;
}

export interface PersistedRun {
  invoiceId: string;
  auditRunId: string;
  gateFailureIds: string[];
  chargeFindingIds: string[];
  scorecardId: string | null;
}

export async function persistAuditRun(
  client: pg.PoolClient,
  input: PersistInput,
): Promise<PersistedRun> {
  const { clientId, invoice, result } = input;

  // 1. invoice + charge_fact rows (the billed side).
  const inv = await client.query<{ id: string }>(
    `INSERT INTO invoice (client_id, transaction_set, invoice_number, currency, parser_version)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [clientId, invoice.transactionSet, invoice.invoiceNumber ?? null, invoice.headerCurrency ?? null, invoice.parserVersion],
  );
  const invoiceId = inv.rows[0]!.id;

  for (const c of invoice.charges) {
    await client.query(
      `INSERT INTO charge_fact
         (client_id, invoice_id, code, x12_element, category, amount, currency, basis, rate, raw_description, source_loop)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        clientId, invoiceId, c.code ?? null, c.x12Element ?? null, c.category ?? null,
        c.amount, c.currency || 'XXX', c.basis ?? null, c.rate ?? null, c.rawDescription ?? null, c.sourceLoop ?? null,
      ],
    );
  }

  // 2. audit_run pinned to the snapshot + engine spec.
  const run = await client.query<{ id: string }>(
    `INSERT INTO audit_run (client_id, invoice_id, rubric_snapshot_id, engine_spec_version, outcome)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [clientId, invoiceId, input.rubricSnapshotId, result.pins.engineSpecVersion, result.outcome],
  );
  const auditRunId = run.rows[0]!.id;

  // 3. gate_failures (the kickback) — append-only.
  const gateFailureIds: string[] = [];
  for (const g of result.gateFailures) {
    const gf = await client.query<{ id: string }>(
      `INSERT INTO gate_failure (client_id, audit_run_id, defect, citation, evaluated_expr)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [clientId, auditRunId, g.defect, g.citation ?? null, JSON.stringify(g.evaluatedExpr)],
    );
    gateFailureIds.push(gf.rows[0]!.id);
  }

  // 4. charge_findings (scoring observations) — append-only. Empty on REJECTED_REWORK.
  const chargeFindingIds: string[] = [];
  for (const f of result.findings) {
    const cf = await client.query<{ id: string }>(
      `INSERT INTO charge_finding (client_id, audit_run_id, result, evaluated_expr)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [clientId, auditRunId, f.result, JSON.stringify(f.evaluatedExpr)],
    );
    chargeFindingIds.push(cf.rows[0]!.id);
  }

  // 5. scorecard rollup (mutable summary) — only on SCORED.
  let scorecardId: string | null = null;
  if (result.scorecard) {
    const sc = await client.query<{ id: string }>(
      `INSERT INTO scorecard
         (client_id, audit_run_id, conformed_count, variance_count, unassessable_count, total_overcharge, total_undercharge, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        clientId, auditRunId, result.scorecard.conformedCount, result.scorecard.varianceCount,
        result.scorecard.unassessableCount, result.scorecard.totalOvercharge, result.scorecard.totalUndercharge,
        invoice.headerCurrency ?? null,
      ],
    );
    scorecardId = sc.rows[0]!.id;
  }

  return { invoiceId, auditRunId, gateFailureIds, chargeFindingIds, scorecardId };
}
