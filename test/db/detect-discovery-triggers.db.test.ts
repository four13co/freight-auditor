import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import { persistAuditRun } from '../../src/modules/evaluator/persist.js';
import { GOLDEN_210, testCategorize } from '../fixtures/edi-golden.js';
import {
  detectUnknownChargeCodeTriggers,
  DiscoveryTriggerError as ChargeCodeError,
} from '../../src/modules/discovery/detect-unknown-charge-code-triggers.js';
import {
  detectExtractionQualityTriggers,
  DiscoveryTriggerError as ExtractionError,
} from '../../src/modules/discovery/detect-extraction-quality-triggers.js';
import {
  detectSuspiciousPassTriggers,
  DiscoveryTriggerError as SuspiciousPassError,
} from '../../src/modules/discovery/detect-suspicious-pass-triggers.js';

// GOLDEN_210 with an L1 charge code (999) the STUB_CROSSWALK has never seen,
// swapped in for GOLDEN_210's FUEL line. Still foots (1000.00 + 250.00 =
// 1250.00 = declared total) so the invoice reaches SCORED and charge_fact
// rows are persisted for both lines -- one with category NULL.
const GOLDEN_210_UNKNOWN_CODE = GOLDEN_210.replace(
  'L1*2***250.00****405****Fuel Surcharge~',
  'L1*2***250.00****999****Mystery Accessorial~',
);

/**
 * P3.D.2/D.3/D.4: three independently-detected discovery triggers, each
 * republishing evidence that already exists elsewhere in the ledger
 * (charge_fact.category, extraction_field.confidence/ai_value,
 * coverage_marker) into the shared discovery_trigger surface from 0044/0045.
 * None of these perform an AI call, propose a rule, or touch payment —
 * matching P3.D.1's detect-unassessable-triggers precedent exactly.
 */
describe('discovery trigger detectors (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `dtrig-${Date.now()}`;
  const auditRunIds: string[] = [];
  let sourceDocumentId: string;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('DTrig', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const doc = await owner.query(
        `INSERT INTO source_document (client_id, sha256, storage_uri) VALUES ($1,$2,$3) RETURNING id`,
        [clientId, tag.padEnd(64, '0').slice(0, 64), `local://${tag}`],
      );
      sourceDocumentId = doc.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM discovery_trigger WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_replay_manifest WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM scorecard WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM gate_failure WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM coverage_marker WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM extraction_field WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM source_document WHERE id = $1`, [sourceDocumentId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('detectUnknownChargeCodeTriggers: an unmapped L1-08 code becomes an UNKNOWN_CHARGE_CODE trigger, idempotently', async () => {
    const inv = parse210(GOLDEN_210_UNKNOWN_CODE, testCategorize);
    const result = evaluateInvoice(inv);
    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      auditRunIds.push(p.auditRunId);
      const facts = await c.query(
        `SELECT id, code, category FROM charge_fact WHERE invoice_id = $1 ORDER BY code`,
        [p.invoiceId],
      );
      const first = await detectUnknownChargeCodeTriggers(c, { clientId, auditRunId: p.auditRunId });
      const retry = await detectUnknownChargeCodeTriggers(c, { clientId, auditRunId: p.auditRunId });
      const triggers = await c.query(
        `SELECT trigger_type, source_kind, charge_fact_id, detail FROM discovery_trigger WHERE client_id = $1 AND charge_fact_id = ANY($2)`,
        [clientId, facts.rows.map((f) => f.id)],
      );
      return { facts: facts.rows, first, retry, triggers: triggers.rows };
    });

    expect(row.facts).toHaveLength(2);
    const unknownFact = row.facts.find((f) => f.code === '999');
    expect(unknownFact?.category).toBeNull();
    expect(row.first.createdCount).toBe(1);
    expect(row.retry).toEqual({ triggerIds: row.first.triggerIds, createdCount: 0 });
    expect(row.triggers).toHaveLength(1);
    expect(row.triggers[0]).toMatchObject({
      trigger_type: 'UNKNOWN_CHARGE_CODE',
      source_kind: 'CHARGE_FACT',
      charge_fact_id: unknownFact!.id,
      detail: { code: '999', rawDescription: 'Mystery Accessorial' },
    });
  });

  it('detectUnknownChargeCodeTriggers: unknown audit_run_id fails closed', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      await expect(
        detectUnknownChargeCodeTriggers(c, { clientId, auditRunId: '00000000-0000-0000-0000-000000000000' }),
      ).rejects.toThrow(ChargeCodeError);
    });
  });

  it('detectSuspiciousPassTriggers: a FUEL charge with no rate/basis becomes a SUSPICIOUS_PASS_MISSING_DATA trigger, idempotently', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv);
    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      auditRunIds.push(p.auditRunId);
      expect(p.coverageMarkerIds.length).toBeGreaterThan(0);
      const first = await detectSuspiciousPassTriggers(c, { clientId, auditRunId: p.auditRunId });
      const retry = await detectSuspiciousPassTriggers(c, { clientId, auditRunId: p.auditRunId });
      const triggers = await c.query(
        `SELECT trigger_type, source_kind, coverage_marker_id, detail FROM discovery_trigger WHERE client_id = $1 AND audit_run_id = $2`,
        [clientId, p.auditRunId],
      );
      return { first, retry, triggers: triggers.rows, coverageMarkerIds: p.coverageMarkerIds };
    });

    expect(row.first.createdCount).toBe(row.coverageMarkerIds.length);
    expect(row.retry).toEqual({ triggerIds: row.first.triggerIds, createdCount: 0 });
    expect(row.triggers.length).toBe(row.coverageMarkerIds.length);
    expect(row.triggers.every((t) => t.trigger_type === 'SUSPICIOUS_PASS_MISSING_DATA' && t.source_kind === 'COVERAGE_MARKER')).toBe(true);
    expect(row.triggers.some((t) => (t.detail as { markerCode: string }).markerCode === 'FUEL_WITHOUT_RATE_BASIS')).toBe(true);
  });

  it('detectSuspiciousPassTriggers: unknown audit_run_id fails closed', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      await expect(
        detectSuspiciousPassTriggers(c, { clientId, auditRunId: '00000000-0000-0000-0000-000000000000' }),
      ).rejects.toThrow(SuspiciousPassError);
    });
  });

  it('detectExtractionQualityTriggers: a null ai_value becomes STRUCTURAL_ANOMALY, a low-confidence unresolved value becomes LOW_CONFIDENCE, a resolved or high-confidence value triggers neither', async () => {
    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const fields = await c.query<{ id: string }>(
        `INSERT INTO extraction_field (client_id, source_document_id, field_path, ai_value, human_value, confidence)
         VALUES
           ($1,$2,'clause.rate',NULL,NULL,NULL),
           ($1,$2,'clause.fuel_surcharge','"12%"',NULL,0.2),
           ($1,$2,'clause.effective_date','"2026-01-01"',NULL,0.1),
           ($1,$2,'clause.term','"12 months"','"12 months"',0.95)
         RETURNING id`,
        [clientId, sourceDocumentId],
      );
      const [structural, lowConfUnresolved, lowConfResolvedLater, highConf] = fields.rows;
      // human_value arrives after the field was already flagged low-confidence --
      // detector must not re-flag it (query filters human_value IS NULL).
      await c.query(`UPDATE extraction_field SET human_value = '"2026-02-01"'::jsonb WHERE id = $1`, [
        lowConfResolvedLater!.id,
      ]);

      const first = await detectExtractionQualityTriggers(c, { clientId, sourceDocumentId });
      const retry = await detectExtractionQualityTriggers(c, { clientId, sourceDocumentId });
      const triggers = await c.query(
        `SELECT trigger_type, extraction_field_id FROM discovery_trigger WHERE client_id = $1 AND source_document_id = $2`,
        [clientId, sourceDocumentId],
      );
      return {
        first,
        retry,
        triggers: triggers.rows,
        structuralId: structural!.id,
        lowConfId: lowConfUnresolved!.id,
        resolvedId: lowConfResolvedLater!.id,
        highConfId: highConf!.id,
      };
    });

    expect(row.first.createdCount).toBe(2);
    expect(row.retry).toEqual({ triggerIds: row.first.triggerIds, createdCount: 0 });
    const byField = new Map(row.triggers.map((t) => [t.extraction_field_id, t.trigger_type]));
    expect(byField.get(row.structuralId)).toBe('STRUCTURAL_ANOMALY');
    expect(byField.get(row.lowConfId)).toBe('LOW_CONFIDENCE');
    expect(byField.has(row.resolvedId)).toBe(false);
    expect(byField.has(row.highConfId)).toBe(false);
  });

  it('detectExtractionQualityTriggers: unknown source_document_id fails closed', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      await expect(
        detectExtractionQualityTriggers(c, { clientId, sourceDocumentId: '00000000-0000-0000-0000-000000000000' }),
      ).rejects.toThrow(ExtractionError);
    });
  });
});
