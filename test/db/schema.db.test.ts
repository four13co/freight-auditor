import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { makePool, withOwnerTx, withAppTx } from './helpers.js';

/**
 * Canonical data-model contract (ClickUp 86e24cy39). Runs against the ephemeral
 * container Postgres via DATABASE_URL. Proves the non-negotiable invariants:
 * migrations applied, append-only financial boundary, GiST temporal exclusion,
 * the transport-document → variance_finding evidence chain, and money precision.
 */
describe('canonical data model', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = makePool();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('migrations applied: expected core tables exist', async () => {
    await withOwnerTx(pool, async (c) => {
      const { rows } = await c.query(
        `select tablename from pg_tables where schemaname='public'`,
      );
      const names = new Set(rows.map((r) => r.tablename));
      for (const t of [
        'client', 'contract_version', 'rule_version', 'rubric_snapshot',
        'charge_fact', 'variance_finding', 'transport_document', 'audit_event',
      ]) {
        expect(names.has(t), `missing table ${t}`).toBe(true);
      }
    });
  });

  it('financial-boundary tables reject UPDATE for the app role', async () => {
    // rule_version is on the §11 append-only list — only INSERT/SELECT granted.
    await expect(
      withAppTx(pool, { internal: true }, async (c) => {
        await c.query(`UPDATE rule_version SET hardness='FIRM_RULE' WHERE false`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('financial-boundary tables reject DELETE for the app role', async () => {
    await expect(
      withAppTx(pool, { internal: true }, async (c) => {
        await c.query(`DELETE FROM audit_event WHERE false`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('mutable tables allow UPDATE for the app role (control)', async () => {
    // client is not on the append-only list — UPDATE must be permitted (the
    // statement affects 0 rows; we only assert it is not a privilege error).
    await withAppTx(pool, { internal: true }, async (c) => {
      await expect(
        c.query(`UPDATE client SET name=name WHERE false`),
      ).resolves.toBeDefined();
    });
  });

  it('contract_version GiST exclusion rejects overlapping business-time ranges', async () => {
    await expect(
      withOwnerTx(pool, async (c) => {
        const { rows: cl } = await c.query(
          `INSERT INTO client (name, slug) VALUES ('T','t-${Date.now()}') RETURNING id`,
        );
        const clientId = cl[0].id;
        const { rows: ca } = await c.query(
          `INSERT INTO carrier (name) VALUES ('C') RETURNING id`,
        );
        const { rows: co } = await c.query(
          `INSERT INTO contract (client_id, carrier_id, name) VALUES ($1,$2,'K') RETURNING id`,
          [clientId, ca[0].id],
        );
        const contractId = co[0].id;
        await c.query(
          `INSERT INTO contract_version (client_id, contract_id, valid_from, valid_to)
           VALUES ($1,$2,'2026-01-01','2026-06-01')`,
          [clientId, contractId],
        );
        // Overlaps [2026-01-01, 2026-06-01) → must be excluded.
        await c.query(
          `INSERT INTO contract_version (client_id, contract_id, valid_from, valid_to)
           VALUES ($1,$2,'2026-03-01','2026-09-01')`,
          [clientId, contractId],
        );
      }),
    ).rejects.toThrow(/exclusion|conflicting key|overlap/i);
  });

  it('contract_version allows non-overlapping ranges (control)', async () => {
    await withOwnerTx(pool, async (c) => {
      const { rows: cl } = await c.query(
        `INSERT INTO client (name, slug) VALUES ('T','t2-${Date.now()}') RETURNING id`,
      );
      const clientId = cl[0].id;
      const { rows: ca } = await c.query(`INSERT INTO carrier (name) VALUES ('C') RETURNING id`);
      const { rows: co } = await c.query(
        `INSERT INTO contract (client_id, carrier_id, name) VALUES ($1,$2,'K') RETURNING id`,
        [clientId, ca[0].id],
      );
      const contractId = co[0].id;
      await c.query(
        `INSERT INTO contract_version (client_id, contract_id, valid_from, valid_to)
         VALUES ($1,$2,'2026-01-01','2026-06-01')`,
        [clientId, contractId],
      );
      // Abuts, does not overlap [2026-06-01, ...) → allowed.
      await expect(
        c.query(
          `INSERT INTO contract_version (client_id, contract_id, valid_from, valid_to)
           VALUES ($1,$2,'2026-06-01','2026-12-01')`,
          [clientId, contractId],
        ),
      ).resolves.toBeDefined();
    });
  });

  it('transport_document ↔ variance_finding evidence chain round-trips', async () => {
    await withOwnerTx(pool, async (c) => {
      const { rows: cl } = await c.query(
        `INSERT INTO client (name, slug) VALUES ('T','t3-${Date.now()}') RETURNING id`,
      );
      const clientId = cl[0].id;
      const { rows: td } = await c.query(
        `INSERT INTO transport_document
           (client_id, document_number, document_type, transport_mode, document)
         VALUES ($1,'HLCUBSC2603BBTO1','MASTER_BILL_OF_LADING','OCEAN',$2)
         RETURNING id`,
        [clientId, JSON.stringify({ parties: [{ role: 'SHIPPER', company_name: 'ACME' }] })],
      );
      const { rows: inv } = await c.query(
        `INSERT INTO invoice (client_id, transaction_set, parser_version)
         VALUES ($1,'310','v1') RETURNING id`,
        [clientId],
      );
      const { rows: run } = await c.query(
        `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome)
         VALUES ($1,$2,'e1','SCORED') RETURNING id`,
        [clientId, inv[0].id],
      );
      await c.query(
        `INSERT INTO variance_finding
           (client_id, audit_run_id, transport_document_id, criterion_id, rule_version_id, variance_amount, currency, direction, evaluated_expr)
         SELECT $1, $2, $3, c.id, rv.id, 412.1800, 'USD', 'OVERCHARGE', '{}'::jsonb
         FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
         JOIN rule_version rv ON rv.rule_id = r.id
         WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1`,
        [clientId, run[0].id, td[0].id],
      );
      // Resolve the defensibility chain: finding → transport-document evidence.
      const { rows } = await c.query(
        `SELECT vf.variance_amount, td.document_number, td.document->'parties'->0->>'company_name' AS shipper
           FROM variance_finding vf
           JOIN transport_document td ON td.id = vf.transport_document_id
          WHERE vf.client_id = $1`,
        [clientId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].document_number).toBe('HLCUBSC2603BBTO1');
      expect(rows[0].shipper).toBe('ACME');
      expect(rows[0].variance_amount).toBe('412.1800'); // numeric(18,4), exact
    });
  });

  it('money round-trips at numeric(18,4) with no float drift', async () => {
    await withOwnerTx(pool, async (c) => {
      const { rows: cl } = await c.query(
        `INSERT INTO client (name, slug) VALUES ('T','t4-${Date.now()}') RETURNING id`,
      );
      const clientId = cl[0].id;
      const { rows: inv } = await c.query(
        `INSERT INTO invoice (client_id, transaction_set, parser_version)
         VALUES ($1,'210','v1') RETURNING id`,
        [clientId],
      );
      // A value that IEEE float would mangle (0.1+0.2) plus a 4dp boundary.
      const { rows } = await c.query(
        `INSERT INTO charge_fact (client_id, invoice_id, amount, currency)
         VALUES ($1,$2, 0.3000, 'USD')
         RETURNING amount, (amount = 0.3000) AS exact`,
        [clientId, inv[0].id],
      );
      expect(rows[0].amount).toBe('0.3000'); // string form preserves scale
      expect(rows[0].exact).toBe(true);
    });
  });
});
