import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { closePool, getPool } from '../../src/db/pool.js';
import { rerunDiscoveryForAmendment } from '../../src/modules/contracts/rerun-discovery-for-amendment.js';

/**
 * P3.D.8: an amendment that changes a clause deprecates/replaces the ACTIVE
 * rule version tied to it (via retireAmendedRules, P2-era, unchanged here)
 * and re-runs the P3.D discovery detectors against every audit run whose
 * findings cited that now-superseded rule version.
 */
describe('rerunDiscoveryForAmendment (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let carrierId: string;
  let ruleId: string;
  let ruleVersionId: string;
  let contractId: string;
  let oldVersionId: string;
  let newVersionId: string;
  let amendmentId: string;
  let auditRunId: string;
  const tag = `rerun-discovery-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    clientId = (await pool.query(`INSERT INTO client (name, slug) VALUES ('Rerun', $1) RETURNING id`, [tag])).rows[0].id;
    carrierId = (await pool.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`])).rows[0].id;

    contractId = (await pool.query(
      `INSERT INTO contract (client_id, carrier_id, name) VALUES ($1, $2, 'Rerun Contract') RETURNING id`,
      [clientId, carrierId],
    )).rows[0].id;
    oldVersionId = (await pool.query(
      `INSERT INTO contract_version (client_id, contract_id, valid_from, valid_to) VALUES ($1, $2, '2026-01-01', '2026-06-01') RETURNING id`,
      [clientId, contractId],
    )).rows[0].id;
    newVersionId = (await pool.query(
      `INSERT INTO contract_version (client_id, contract_id, valid_from) VALUES ($1, $2, '2026-06-01') RETURNING id`,
      [clientId, contractId],
    )).rows[0].id;

    const oldClauseId = (await pool.query(
      `INSERT INTO contract_clause (client_id, contract_version_id, clause_ref, text_excerpt) VALUES ($1, $2, '4.2', 'old fuel text') RETURNING id`,
      [clientId, oldVersionId],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO contract_clause (client_id, contract_version_id, clause_ref, text_excerpt) VALUES ($1, $2, '4.2', 'new fuel text')`,
      [clientId, newVersionId],
    );

    ruleId = (await pool.query(`INSERT INTO rule (slug, rule_type) VALUES ($1, 'STRUCTURAL') RETURNING id`, [`rule-${tag}`])).rows[0].id;
    ruleVersionId = (await pool.query(
      `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits, clause_id, valid_from)
       VALUES ($1, 'AI_DOCS', 'ACTIVE', '{}', $2, 'PASS_FAIL', $3, '2026-01-01') RETURNING id`,
      [ruleId, `hash-${tag}`, oldClauseId],
    )).rows[0].id;

    amendmentId = (await pool.query(
      `INSERT INTO contract_amendment (client_id, contract_id, supersedes_version_id, new_version_id, effective_date)
       VALUES ($1, $2, $3, $4, '2026-06-01') RETURNING id`,
      [clientId, contractId, oldVersionId, newVersionId],
    )).rows[0].id;

    const invoiceId = (await pool.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [clientId, carrierId, `INV-${tag}`],
    )).rows[0].id;
    auditRunId = (await pool.query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [clientId, invoiceId],
    )).rows[0].id;
    // A finding citing the soon-to-be-deprecated rule version -- this is what makes the run "affected".
    const criterionId = (await pool.query(
      `INSERT INTO criterion (criterion_key, kind) VALUES ($1, 'SCORING') RETURNING id`,
      [`criterion-${tag}`],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO charge_finding (client_id, audit_run_id, criterion_id, rule_version_id, result) VALUES ($1, $2, $3, $4, 'CONFORMED')`,
      [clientId, auditRunId, criterionId, ruleVersionId],
    );
    // An unknown-charge-code condition on the same invoice -- deterministically gives detectUnknownChargeCodeTriggers something to find.
    await pool.query(
      `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency) VALUES ($1, $2, 'XYZ', NULL, 10, 'USD')`,
      [clientId, invoiceId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM unknown_charge_code_trigger WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM promotion_event WHERE rule_version_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [ruleId]);
    await pool.query(`DELETE FROM charge_finding WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM criterion WHERE criterion_key = $1`, [`criterion-${tag}`]);
    await pool.query(`DELETE FROM contract_amendment WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM rule_version WHERE rule_id = $1`, [ruleId]);
    await pool.query(`DELETE FROM rule WHERE id = $1`, [ruleId]);
    await pool.query(`DELETE FROM contract_clause WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM contract_version WHERE contract_id = $1`, [contractId]);
    await pool.query(`DELETE FROM contract WHERE id = $1`, [contractId]);
    await pool.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
    await pool.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  it('deprecates the affected rule version, finds the citing audit run, and creates a real discovery trigger', async () => {
    const owner = await pool.connect();
    try {
      const result = await rerunDiscoveryForAmendment(owner, { clientId, amendmentId });

      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0]?.oldRuleVersionId).toBe(ruleVersionId);
      expect(result.transitions[0]?.replacementRuleVersionId).not.toBeNull();
      expect(result.affectedAuditRunIds).toEqual([auditRunId]);
      expect(result.triggersCreated).toBeGreaterThanOrEqual(1);

      const trigger = await owner.query(
        `SELECT 1 FROM unknown_charge_code_trigger WHERE client_id = $1 AND audit_run_id = $2`,
        [clientId, auditRunId],
      );
      expect(trigger.rowCount).toBe(1);

      const original = await owner.query(`SELECT lifecycle_state FROM rule_version WHERE id = $1`, [ruleVersionId]);
      expect(original.rows[0].lifecycle_state).toBe('ACTIVE');
      const deprecated = await owner.query(
        `SELECT lifecycle_state FROM rule_version WHERE predecessor_rule_version_id = $1 AND lifecycle_state = 'DEPRECATED'`,
        [ruleVersionId],
      );
      expect(deprecated.rowCount).toBe(1);
    } finally {
      owner.release();
    }
  });

  it('is idempotent: a retry creates no duplicate transitions, rule versions, or triggers', async () => {
    const owner = await pool.connect();
    try {
      const first = await rerunDiscoveryForAmendment(owner, { clientId, amendmentId });
      const retry = await rerunDiscoveryForAmendment(owner, { clientId, amendmentId });

      expect(retry.transitions).toEqual(first.transitions);
      expect(retry.affectedAuditRunIds).toEqual(first.affectedAuditRunIds);
      expect(retry.triggersCreated).toBe(0);

      const deprecatedCount = await owner.query(
        `SELECT count(*)::int AS n FROM rule_version WHERE predecessor_rule_version_id = $1`,
        [ruleVersionId],
      );
      expect(deprecatedCount.rows[0].n).toBe(1);
      const triggerCount = await owner.query(
        `SELECT count(*)::int AS n FROM unknown_charge_code_trigger WHERE client_id = $1 AND audit_run_id = $2`,
        [clientId, auditRunId],
      );
      expect(triggerCount.rows[0].n).toBe(1);
    } finally {
      owner.release();
    }
  });
});
