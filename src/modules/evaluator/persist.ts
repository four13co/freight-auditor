import type pg from 'pg';
import { Decimal } from 'decimal.js';
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

  // 1. invoice header (always persisted — the audit trail covers rejected
  // invoices too, via gate_failure below).
  const inv = await client.query<{ id: string }>(
    `INSERT INTO invoice (client_id, transaction_set, invoice_number, currency, parser_version)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [clientId, invoice.transactionSet, invoice.invoiceNumber ?? null, invoice.headerCurrency ?? null, invoice.parserVersion],
  );
  const invoiceId = inv.rows[0]!.id;

  // charge_fact rows (the billed side) are only meaningful once the invoice has
  // cleared the gate phase — charge_fact.currency is NOT NULL, and a
  // REJECTED_REWORK invoice can have an unstated/unvalidated per-charge
  // currency (§6: never default). Writing a sentinel here would silently
  // fabricate billed-side data for an invoice the gate explicitly rejected;
  // the gate_failure kickback (step 3) is the canonical record of why. Only
  // persist charge_fact once the invoice is SCORED, i.e. currency is stated.
  // Indexed the same as invoice.charges, so the variance_finding derivation
  // (step 4b) can recover "which charge_fact row did this charge become" —
  // undefined for a charge that wasn't persisted (only possible pre-SCORED,
  // which 4b never reaches).
  const chargeFactIdsByChargeIndex: (string | undefined)[] = [];
  if (result.outcome === 'SCORED') {
    for (const c of invoice.charges) {
      // STD.AMOUNT_STATED gates SCORED, so every charge here must have a
      // parseable amount by construction — this assertion documents that
      // invariant and fails loudly rather than silently writing NULL into
      // the NOT NULL amount column if the gate is ever weakened.
      if (c.amount === undefined) {
        throw new Error(`invariant violated: charge ${c.code ?? '(no code)'} has no amount on a SCORED invoice`);
      }
      const fact = await client.query<{ id: string }>(
        `INSERT INTO charge_fact
           (client_id, invoice_id, code, x12_element, category, amount, currency, basis, rate, raw_description, source_loop)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          clientId, invoiceId, c.code ?? null, c.x12Element ?? null, c.category ?? null,
          c.amount, c.currency, c.basis ?? null, c.rate ?? null, c.rawDescription ?? null, c.sourceLoop ?? null,
        ],
      );
      chargeFactIdsByChargeIndex.push(fact.rows[0]!.id);
    }
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

  // 4b. variance_finding derivation (86e2v17p5): one row per SCORING finding
  // that is VARIANCE or UNASSESSABLE (CONFORMED represents no variance —
  // nothing for an analyst to act on). GET /api/findings reads exclusively
  // from variance_finding, so this is what makes the dashboard show real
  // audited data.
  //
  // charge_fact_id is required (list-findings.ts INNER JOINs charge_fact on
  // it), but not every finding maps to exactly one charge_fact: a
  // CONTRACT.RATE_VARIANCE finding compares a *sum* of same-currency LINEHAUL
  // charges (fact-bundle.ts), and a STANDARD integrity check (e.g.
  // STD.NO_QUARANTINED_CODES) has no associated charge at all. When a
  // finding's contributing set of charge_fact rows isn't exactly one, there
  // is no single owning row to cite — skip the insert rather than write a
  // null charge_fact_id (which the INNER JOIN would make permanently
  // invisible anyway; a row nobody can ever see is worse than no row).
  if (result.outcome === 'SCORED') {
    // Mirrors fact-bundle.ts's own LINEHAUL-charge predicate exactly — a
    // divergence between the two would silently attribute a finding to the
    // wrong charge_fact.
    const linehaulChargeFactIds = invoice.charges
      .map((c, i) => (c.category === 'LINEHAUL' && !c.quarantined && c.amount !== undefined ? chargeFactIdsByChargeIndex[i] : undefined))
      .filter((id): id is string => id !== undefined);

    for (const f of result.findings) {
      if (f.result === 'CONFORMED') continue;

      // Every SCORING criterion implemented so far is the CONTRACT-tier
      // LINEHAUL comparison; a future non-LINEHAUL money criterion would need
      // its own contributing-charge resolution here, not this hardcoded set.
      const contributing = f.criterionKey === 'CONTRACT.RATE_VARIANCE' ? linehaulChargeFactIds : [];
      if (contributing.length !== 1) continue;
      const chargeFactId = contributing[0]!;

      const direction = f.varianceAmount === null
        ? null
        : new Decimal(f.varianceAmount).isPositive() ? 'OVERCHARGE' : 'UNDERCHARGE';
      const classification = f.result === 'UNASSESSABLE' ? 'UNASSESSABLE' : 'VARIANCE';
      const materiality = f.varianceAmount === null ? null : new Decimal(f.varianceAmount).abs().toFixed(4);

      await client.query(
        `INSERT INTO variance_finding
           (client_id, audit_run_id, charge_fact_id, classification, direction, materiality, variance_amount, currency, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open')`,
        [
          clientId, auditRunId, chargeFactId, classification, direction, materiality,
          f.varianceAmount, invoice.headerCurrency ?? null,
        ],
      );
    }
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
