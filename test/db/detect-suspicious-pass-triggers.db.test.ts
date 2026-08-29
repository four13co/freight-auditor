import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { detectSuspiciousPassTriggers } from '../../src/modules/discovery/detect-suspicious-pass-triggers.js';

/**
 * P3.D.4: a coverage_marker (0019) row -- a "suspicious-pass"/"missing-data"
 * gap on a charge that otherwise passed structural validation -- surfaces as
 * a discovery trigger, scoped to the audit run, idempotent on re-run.
 */
describe('detectSuspiciousPassTriggers (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let carrierId: string;
  const tag = `spt-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('SPT', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      carrierId = carrier.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM suspicious_pass_trigger WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM coverage_marker WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedAuditRunWithMarkers(
    client: pg.PoolClient,
    markers: Array<{ chargeIndex: number; markerCode: string; missingFields: string[] }>,
  ): Promise<{ auditRunId: string }> {
    const inv = await client.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [clientId, carrierId, `INV-${tag}-${Math.random().toString(36).slice(2)}`],
    );
    const invoiceId = inv.rows[0].id;

    const run = await client.query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome)
       VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [clientId, invoiceId],
    );
    const auditRunId = run.rows[0].id;

    for (const marker of markers) {
      await client.query(
        `INSERT INTO coverage_marker (client_id, audit_run_id, charge_index, marker_code, missing_fields)
         VALUES ($1, $2, $3, $4, $5)`,
        [clientId, auditRunId, marker.chargeIndex, marker.markerCode, marker.missingFields],
      );
    }
    return { auditRunId };
  }

  it('creates a trigger for each coverage_marker row and is idempotent on re-run', async () => {
    const owner = await pool.connect();
    try {
      const { auditRunId } = await seedAuditRunWithMarkers(owner, [
        { chargeIndex: 0, markerCode: 'INCOMPLETE_RATE_BASIS', missingFields: ['basis'] },
        { chargeIndex: 2, markerCode: 'MISSING_CHARGE_IDENTITY', missingFields: ['code', 'rawDescription'] },
      ]);

      const first = await detectSuspiciousPassTriggers(owner, { clientId, auditRunId });
      expect(first.createdCount).toBe(2);
      expect(first.triggerIds).toHaveLength(2);

      const second = await detectSuspiciousPassTriggers(owner, { clientId, auditRunId });
      expect(second.createdCount).toBe(0);
      expect(second.triggerIds).toEqual(first.triggerIds);

      const rows = await owner.query(
        `SELECT marker_code FROM suspicious_pass_trigger WHERE client_id = $1 AND audit_run_id = $2 ORDER BY marker_code`,
        [clientId, auditRunId],
      );
      expect(rows.rows).toEqual([{ marker_code: 'INCOMPLETE_RATE_BASIS' }, { marker_code: 'MISSING_CHARGE_IDENTITY' }]);
    } finally {
      owner.release();
    }
  });

  it('creates no triggers when the audit run has no coverage markers', async () => {
    const owner = await pool.connect();
    try {
      const { auditRunId } = await seedAuditRunWithMarkers(owner, []);
      const result = await detectSuspiciousPassTriggers(owner, { clientId, auditRunId });
      expect(result.createdCount).toBe(0);
      expect(result.triggerIds).toEqual([]);
    } finally {
      owner.release();
    }
  });

  it('throws AUDIT_RUN_NOT_FOUND for an audit run outside the tenant', async () => {
    const owner = await pool.connect();
    try {
      await expect(
        detectSuspiciousPassTriggers(owner, { clientId, auditRunId: '99999999-9999-4999-8999-999999999999' }),
      ).rejects.toMatchObject({ code: 'AUDIT_RUN_NOT_FOUND' });
    } finally {
      owner.release();
    }
  });
});
