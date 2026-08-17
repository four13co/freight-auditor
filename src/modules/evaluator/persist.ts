import type pg from 'pg';
import { Decimal } from 'decimal.js';
import type { ParsedInvoice } from '../ingestion/charge-fact.js';
import type { AuditResult } from './evaluate-invoice.js';
import { resolveCriterionIds } from './resolve-criterion-ids.js';

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
  //
  // Track ids by category (86e2v17p5) -- the variance_finding derivation
  // (step 5) needs to know which charge_fact row(s) fed CONTRACT.RATE_VARIANCE
  // (the LINEHAUL sum in fact-bundle.ts) to decide charge_fact_id attribution.
  const chargeFactIdsByCategory = new Map<string, string[]>();
  if (result.outcome === 'SCORED') {
    for (const c of invoice.charges) {
      // STD.AMOUNT_STATED gates SCORED, so every charge here must have a
      // parseable amount by construction — this assertion documents that
      // invariant and fails loudly rather than silently writing NULL into
      // the NOT NULL amount column if the gate is ever weakened.
      if (c.amount === undefined) {
        throw new Error(`invariant violated: charge ${c.code ?? '(no code)'} has no amount on a SCORED invoice`);
      }
      const cf = await client.query<{ id: string }>(
        `INSERT INTO charge_fact
           (client_id, invoice_id, code, x12_element, category, amount, currency, basis, rate, raw_description, source_loop)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          clientId, invoiceId, c.code ?? null, c.x12Element ?? null, c.category ?? null,
          c.amount, c.currency, c.basis ?? null, c.rate ?? null, c.rawDescription ?? null, c.sourceLoop ?? null,
        ],
      );
      if (c.category !== undefined && !c.quarantined) {
        const ids = chargeFactIdsByCategory.get(c.category) ?? [];
        ids.push(cf.rows[0]!.id);
        chargeFactIdsByCategory.set(c.category, ids);
      }
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
  //
  // 86e2v88u2: resolveCriterionIds (./resolve-criterion-ids.ts) was built and
  // fully tested but never wired into a persist path — criterion_id/
  // rule_version_id shipped NULL on every finding despite both columns
  // existing to record which rule version produced it. Both are nullable
  // (a criterion added after the last seed run must not fail persistence), so
  // resolveCriterionIds' own null-on-miss contract composes directly here —
  // no additional fallback logic needed.
  const chargeFindingIds: string[] = [];
  // Resolved once per distinct criterionKey and reused below in the
  // variance_finding loop (4.5) — both loops iterate the same result.findings
  // and would otherwise issue duplicate resolveCriterionIds queries per key.
  const resolvedIdsByCriterionKey = new Map<string, Awaited<ReturnType<typeof resolveCriterionIds>>>();
  for (const f of result.findings) {
    let resolved = resolvedIdsByCriterionKey.get(f.criterionKey);
    if (resolved === undefined) {
      resolved = await resolveCriterionIds(client, f.criterionKey);
      resolvedIdsByCriterionKey.set(f.criterionKey, resolved);
    }
    const cf = await client.query<{ id: string }>(
      `INSERT INTO charge_finding (client_id, audit_run_id, criterion_id, rule_version_id, result, evaluated_expr)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [clientId, auditRunId, resolved?.criterionId ?? null, resolved?.ruleVersionId ?? null, f.result, JSON.stringify(f.evaluatedExpr)],
    );
    chargeFindingIds.push(cf.rows[0]!.id);
  }

  // 4.5. variance_finding derivation (86e2v17p5) — bridges charge_finding
  // (internal scoring record) to variance_finding (what GET /api/findings
  // reads). Built against Greg's DECISION comment on the task, 2026-08-16:
  // attribute the finding to the INVOICE, not a single charge. Every
  // VARIANCE/UNASSESSABLE finding gets a row (No-go: no materiality floor
  // suppresses the write); CONFORMED gets none. charge_fact_id is populated
  // only when exactly one charge in the criterion's category contributed
  // (the attribution is unambiguous there); NULL when zero or more than one
  // did -- ambiguous attribution, not a guess. Runs in the same transaction
  // as the rest of this function (no second transaction/post-commit step).
  for (const f of result.findings) {
    if (f.result === 'CONFORMED') continue;
    // CONTRACT.RATE_VARIANCE is the only criterion today whose category maps
    // onto a specific charge_fact set (LINEHAUL, per fact-bundle.ts's sum);
    // STANDARD.* criteria are invoice-level predicates with no single-category
    // source, so they correctly get charge_fact_id: NULL (ambiguous by
    // construction, not a special case to detect here).
    const category = f.criterionKey === 'CONTRACT.RATE_VARIANCE' ? 'LINEHAUL' : null;
    const contributingIds = category !== null ? (chargeFactIdsByCategory.get(category) ?? []) : [];
    const chargeFactId = contributingIds.length === 1 ? contributingIds[0]! : null;
    const classification = f.result === 'UNASSESSABLE' ? 'unassessable' : 'variance';
    // 86e2v88u2: same resolution cache populated in the charge_finding loop
    // above — every finding here already had resolveCriterionIds called for
    // its criterionKey once, so this is always a cache hit, never a new query.
    const resolved = resolvedIdsByCriterionKey.get(f.criterionKey) ?? null;
    await client.query(
      `INSERT INTO variance_finding
         (client_id, audit_run_id, criterion_id, rule_version_id, charge_fact_id, direction, materiality, variance_amount, currency, classification, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open')`,
      [
        clientId,
        auditRunId,
        resolved?.criterionId ?? null,
        resolved?.ruleVersionId ?? null,
        chargeFactId,
        f.direction === 'INTEGRITY_ONLY' ? null : f.direction,
        f.varianceAmount === null ? null : new Decimal(f.varianceAmount).abs().toFixed(4),
        f.varianceAmount,
        f.currency,
        classification,
      ],
    );
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
