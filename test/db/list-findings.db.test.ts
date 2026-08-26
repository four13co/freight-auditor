import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { listFindings } from '../../src/modules/findings/list-findings.js';

/**
 * 86e2u7j0d: GET /api/findings' backing query. Covers the join path
 * (variance_finding -> charge_fact -> invoice -> carrier, + expected_charge),
 * RLS tenant isolation, and status/carrier filters.
 */
describe('listFindings (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  let carrierId: string;
  const tag = `lf-${Date.now()}`;
  const extraCarrierIds: string[] = [];

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('LF-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('LF-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      carrierId = carrier.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM variance_finding WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM expected_charge WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM invoice WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM carrier WHERE id = ANY($1::uuid[])`, [[carrierId, ...extraCarrierIds]]);
      await owner.query(`DELETE FROM criterion_version WHERE criterion_id IN (SELECT id FROM criterion WHERE criterion_key LIKE $1)`, [`${tag}%`]);
      await owner.query(`DELETE FROM criterion WHERE criterion_key LIKE $1`, [`${tag}%`]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  /**
   * Seeds one full variance_finding row (through charge_fact/invoice/audit_run)
   * for a client. `invoiceNumber`/`carrierId`/`criterionId` are exposed as
   * options (86e2v24zz) so tests that need to assert on a specific invoice
   * number, seed under a non-default carrier, or attach a criterion can still
   * use this single insert chain instead of hand-rolling their own.
   */
  async function seedFinding(
    client: pg.PoolClient,
    opts: {
      clientId: string;
      status?: string;
      direction?: string;
      billed?: string;
      expected?: string;
      variance?: string;
      invoiceNumber?: string;
      carrierId?: string;
      criterionId?: string;
    },
  ): Promise<{ id: string; chargeFactId: string; auditRunId: string }> {
    const inv = await client.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [
        opts.clientId,
        opts.carrierId ?? carrierId,
        opts.invoiceNumber ?? `INV-${tag}-${Math.random().toString(36).slice(2)}`,
      ],
    );
    const invoiceId = inv.rows[0].id;

    const run = await client.query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome)
       VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [opts.clientId, invoiceId],
    );
    const auditRunId = run.rows[0].id;

    const cf = await client.query(
      `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency)
       VALUES ($1, $2, '400', 'LINEHAUL', $3, 'USD') RETURNING id`,
      [opts.clientId, invoiceId, opts.billed ?? '1000.0000'],
    );
    const chargeFactId = cf.rows[0].id;

    await client.query(
      `INSERT INTO expected_charge (client_id, audit_run_id, charge_fact_id, category, expected_amount, currency)
       VALUES ($1, $2, $3, 'LINEHAUL', $4, 'USD')`,
      [opts.clientId, auditRunId, chargeFactId, opts.expected ?? '900.0000'],
    );

    const vf = await client.query(
      `INSERT INTO variance_finding
         (client_id, audit_run_id, charge_fact_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
       SELECT $1, $2, $3, COALESCE($4::uuid, c.id), rv.id, $5, $6, 'USD', $7, '{}'::jsonb
       FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
       JOIN rule_version rv ON rv.rule_id = r.id
       WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
      [
        opts.clientId,
        auditRunId,
        chargeFactId,
        opts.criterionId ?? null,
        opts.direction ?? 'OVERCHARGE',
        opts.variance ?? '100.0000',
        opts.status ?? 'open',
      ],
    );
    return { id: vf.rows[0].id, chargeFactId, auditRunId };
  }

  it('AC1: returns seeded rows with invoice/carrier/billed/expected/variance/status', async () => {
    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      await seedFinding(c, { clientId: clientAId });
      return listFindings(c, { clientIds: [clientAId] });
    });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      carrierName: `Carrier-${tag}`,
      billed: '1000.0000',
      expected: '900.0000',
      varianceAmount: '100.0000',
      direction: 'OVERCHARGE',
      status: 'open',
    });
    expect(typeof row?.invoiceNumber).toBe('string');
    expect(typeof row?.createdAt).toBe('object'); // Date, via pg
  });

  it('AC2: client B never sees client A rows (RLS isolation)', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, (c) => seedFinding(c, { clientId: clientAId }));
    // internal: false here is load-bearing -- an internal analyst is
    // deliberately granted cross-client visibility (RLS policy), so this must
    // scope strictly to client B's own membership to actually test isolation.
    const bRows = await withTenantTx({ clientIds: [clientBId], internal: false }, async (c) => {
      return listFindings(c, { clientIds: [clientBId] });
    });
    expect(bRows).toHaveLength(0);
  });

  it('AC3: status filter narrows the result set', async () => {
    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      await seedFinding(c, { clientId: clientAId, status: 'open' });
      await seedFinding(c, { clientId: clientAId, status: 'closed' });
      return listFindings(c, { clientIds: [clientAId], status: 'closed' });
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.status === 'closed')).toBe(true);
  });

  it('AC3: carrier filter narrows the result set to that carrier only', async () => {
    // Cleaned up in afterAll (via extraCarrierIds), not here -- invoice rows
    // created below reference this carrier for the rest of the suite's run,
    // and afterAll already deletes invoice before carrier in the right order.
    const otherCarrier = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const oc = await c.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Other-${tag}`]);
      return oc.rows[0].id as string;
    });
    extraCarrierIds.push(otherCarrier);

    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      await seedFinding(c, { clientId: clientAId });
      // seed a second finding under the other carrier
      await seedFinding(c, {
        clientId: clientAId,
        carrierId: otherCarrier,
        invoiceNumber: `INV-${tag}-other`,
        billed: '500.0000',
        variance: '50.0000',
      });
      return listFindings(c, { clientIds: [clientAId], carrier: `Other-${tag}` });
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.carrierName).toBe(`Other-${tag}`);
  });

  it('does not duplicate a finding when more than one expected_charge row exists for its charge_fact (Review finding)', async () => {
    // expected_charge.charge_fact_id has no uniqueness constraint in the
    // schema, so nothing prevents two rows from existing for one charge_fact
    // -- a plain JOIN would row-multiply the finding. This seeds exactly that
    // (two expected_charge rows, one charge_fact) and asserts a single row.
    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      // seedFinding's own expected_charge insert ('900.0000') becomes the
      // FIRST (earlier) of the two rows via an explicit backdated created_at
      // -- now() alone doesn't reliably order two inserts in the same
      // transaction (it reflects transaction start time, not statement
      // time). This second, explicit insert stays inline (not absorbed into
      // seedFinding) since it's a one-off variation only this test needs.
      // created_at ordering decides which one the LATERAL join picks (the
      // later one, '850').
      const { chargeFactId, auditRunId } = await seedFinding(c, {
        clientId: clientAId,
        invoiceNumber: `INV-${tag}-dup-expected`,
        expected: '900.0000',
        variance: '150.0000',
      });
      await c.query(
        `UPDATE expected_charge SET created_at = now() - interval '1 minute'
         WHERE charge_fact_id = $1 AND expected_amount = '900.0000'`,
        [chargeFactId],
      );
      await c.query(
        `INSERT INTO expected_charge (client_id, audit_run_id, charge_fact_id, category, expected_amount, currency, created_at)
         VALUES ($1, $2, $3, 'LINEHAUL', '850.0000', 'USD', now())`,
        [clientAId, auditRunId, chargeFactId],
      );
      return listFindings(c, { clientIds: [clientAId], carrier: `Carrier-${tag}` });
    });
    const matching = rows.filter((r) => r.invoiceNumber === `INV-${tag}-dup-expected`);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.expected).toBe('850.0000');
  });

  /**
   * 86e2up8c8: the dashboard's "Finding" column needs a human-readable
   * description of the rule that produced the finding. Sourced from
   * criterion_version.description via variance_finding.criterion_id.
   */
  it('86e2up8c8 AC1: includes the rule description for a finding with a criterion attached', async () => {
    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const criterion = await c.query(
        `INSERT INTO criterion (criterion_key, kind) VALUES ($1, 'SCORING') RETURNING id`,
        [`${tag}-criterion`],
      );
      const criterionId = criterion.rows[0].id;
      await c.query(
        `INSERT INTO criterion_version (criterion_id, description) VALUES ($1, $2)`,
        [criterionId, 'Duplicate invoice for the same PRO'],
      );

      await seedFinding(c, {
        clientId: clientAId,
        invoiceNumber: `INV-${tag}-with-criterion`,
        criterionId,
      });
      return listFindings(c, { clientIds: [clientAId], carrier: `Carrier-${tag}` });
    });
    const matching = rows.filter((r) => r.invoiceNumber === `INV-${tag}-with-criterion`);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.ruleDescription).toBe('Duplicate invoice for the same PRO');
  });

  it('86e2up8c8: ruleDescription is null when the finding has no criterion attached (existing rows, no regression)', async () => {
    const noCriterionInvoiceNumber = `INV-${tag}-no-criterion`;
    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      // No criterionId passed -- variance_finding.criterion_id defaults NULL.
      await seedFinding(c, { clientId: clientAId, invoiceNumber: noCriterionInvoiceNumber });
      return listFindings(c, { clientIds: [clientAId], carrier: `Carrier-${tag}` });
    });
    const matching = rows.filter((r) => r.invoiceNumber === noCriterionInvoiceNumber);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.ruleDescription).toBeNull();
  });

  it('86e2up8c8: takes the most-recently-recorded criterion_version when more than one exists', async () => {
    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const criterion = await c.query(
        `INSERT INTO criterion (criterion_key, kind) VALUES ($1, 'SCORING') RETURNING id`,
        [`${tag}-criterion-versioned`],
      );
      const criterionId = criterion.rows[0].id;
      await c.query(
        `INSERT INTO criterion_version (criterion_id, description, recorded_at) VALUES ($1, $2, now() - interval '1 day')`,
        [criterionId, 'Old wording'],
      );
      await c.query(
        `INSERT INTO criterion_version (criterion_id, description, recorded_at) VALUES ($1, $2, now())`,
        [criterionId, 'New wording'],
      );

      await seedFinding(c, {
        clientId: clientAId,
        invoiceNumber: `INV-${tag}-versioned`,
        criterionId,
      });
      return listFindings(c, { clientIds: [clientAId], carrier: `Carrier-${tag}` });
    });
    const matching = rows.filter((r) => r.invoiceNumber === `INV-${tag}-versioned`);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.ruleDescription).toBe('New wording');
  });

  /**
   * 86e2v17p5 DECISION: charge_fact_id is nullable on variance_finding
   * (ambiguous multi-charge attribution or an invoice-level STANDARD
   * finding) -- the query must surface these rows (LEFT JOIN, not INNER),
   * and invoice/carrier must still resolve via audit_run.invoice_id since
   * the charge_fact path is unavailable when charge_fact_id is NULL.
   */
  describe('86e2v17p5: NULL charge_fact_id (invoice-level attribution) surfaces via audit_run', () => {
    it('a variance_finding row with charge_fact_id NULL still appears, with invoice/carrier resolved via audit_run', async () => {
      const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
        const inv = await c.query(
          `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
           VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
          [clientAId, carrierId, `INV-${tag}-null-charge`],
        );
        const run = await c.query(
          `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
          [clientAId, inv.rows[0].id],
        );
        await c.query(
          `INSERT INTO variance_finding (client_id, audit_run_id, charge_fact_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
           SELECT $1, $2, NULL, c.id, rv.id, 'OVERCHARGE', '250.0000', 'USD', 'open', '{}'::jsonb
           FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
           JOIN rule_version rv ON rv.rule_id = r.id
           WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1`,
          [clientAId, run.rows[0].id],
        );
        return listFindings(c, { clientIds: [clientAId], carrier: `Carrier-${tag}` });
      });
      const matching = rows.filter((r) => r.invoiceNumber === `INV-${tag}-null-charge`);
      expect(matching).toHaveLength(1);
      expect(matching[0]?.carrierName).toBe(`Carrier-${tag}`);
      expect(matching[0]?.varianceAmount).toBe('250.0000');
      // billed comes from charge_fact.amount, which has no row to join to --
      // the defined "missing charge reference" treatment (null, not a query
      // error or a fabricated 0), per the standard 86e2uutk8 set for
      // FindingDetail's nullable fields. The frontend's formatMoney(null)
      // already renders this as "—".
      expect(matching[0]?.billed).toBeNull();
    });

    it('client B never sees client A a NULL-charge_fact_id row (RLS isolation still holds under the relaxed JOIN)', async () => {
      await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
        const inv = await c.query(
          `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
           VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
          [clientAId, carrierId, `INV-${tag}-null-charge-rls`],
        );
        const run = await c.query(
          `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
          [clientAId, inv.rows[0].id],
        );
        await c.query(
          `INSERT INTO variance_finding (client_id, audit_run_id, charge_fact_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
           SELECT $1, $2, NULL, c.id, rv.id, 'OVERCHARGE', '250.0000', 'USD', 'open', '{}'::jsonb
           FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
           JOIN rule_version rv ON rv.rule_id = r.id
           WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1`,
          [clientAId, run.rows[0].id],
        );
      });
      const bRows = await withTenantTx({ clientIds: [clientBId], internal: false }, async (c) => {
        return listFindings(c, { clientIds: [clientBId] });
      });
      expect(bRows.find((r) => r.invoiceNumber === `INV-${tag}-null-charge-rls`)).toBeUndefined();
    });
  });

  // 86e2v251e: sort must be correct against the FULL filtered result set,
  // not just the default 50-row page -- these seed 51+ rows to prove it.
  describe('sort (86e2v251e)', () => {
    const sortTag = `lf-sort-${Date.now()}`;
    let sortClientId: string;
    let sortCarrierId: string;

    beforeAll(async () => {
      const owner = await pool.connect();
      try {
        const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('LF-Sort', $1) RETURNING id`, [sortTag]);
        sortClientId = c.rows[0].id;
        const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${sortTag}`]);
        sortCarrierId = carrier.rows[0].id;
      } finally {
        owner.release();
      }
    });

    afterAll(async () => {
      const owner = await pool.connect();
      try {
        await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [sortClientId]);
        await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [sortClientId]);
        await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [sortClientId]);
        await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [sortClientId]);
        await owner.query(`DELETE FROM carrier WHERE id = $1`, [sortCarrierId]);
        await owner.query(`DELETE FROM client WHERE id = $1`, [sortClientId]);
      } finally {
        owner.release();
      }
    });

    /**
     * Bulk-seeds `count` filler variance_finding rows with small, distinct
     * variance amounts (1.00, 2.00, ... count.00) via one multi-row INSERT
     * per table -- a per-row seedFinding() chain (5 sequential round-trips
     * each) would be needlessly slow at 50+ rows. Returns nothing; callers
     * seed their own "interesting" row(s) separately via seedFinding-style
     * inserts so their invoice_number is identifiable in assertions.
     */
    async function seedFillerRows(client: pg.PoolClient, count: number): Promise<void> {
      // Each row needs its own invoice_number, so it gets its own two params
      // ($1/$2 = shared client_id/carrier_id would only work for a single
      // row) -- $3, $5, $7... are the per-row invoice_number placeholders.
      const invoiceValues = Array.from(
        { length: count },
        (_, i) => `($1, $2, '210', $${i + 3}, 'USD', 'test')`,
      ).join(', ');
      const invoiceNumbers = Array.from({ length: count }, (_, i) => `INV-${sortTag}-filler-${i}`);
      const invoices = await client.query<{ id: string }>(
        `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
         VALUES ${invoiceValues}
         RETURNING id`,
        [sortClientId, sortCarrierId, ...invoiceNumbers],
      );
      const invoiceIds = invoices.rows.map((r) => r.id);

      const runValues = invoiceIds.map((_, i) => `($1, $${i + 2}, 'test', 'SCORED')`).join(', ');
      const runs = await client.query<{ id: string }>(
        `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome)
         VALUES ${runValues}
         RETURNING id`,
        [sortClientId, ...invoiceIds],
      );
      const runIds = runs.rows.map((r) => r.id);

      // Small, distinct variance amounts (1.00 .. count.00) -- all comfortably
      // below the "interesting" large-variance row seeded per-test, so sort
      // correctness is unambiguous regardless of direction.
      const vfValues = runIds.map((_, i) => `($1, $${i + 2}, (SELECT id FROM criterion WHERE criterion_key = 'CONTRACT.RATE_VARIANCE'), (SELECT rv.id FROM rule_version rv JOIN rule r ON r.id = rv.rule_id WHERE r.slug = 'contract-rate_variance' ORDER BY rv.recorded_at DESC LIMIT 1), 'OVERCHARGE', ${(i + 1).toFixed(2)}, 'USD', 'open', '{}'::jsonb)`).join(', ');
      await client.query(
        `INSERT INTO variance_finding (client_id, audit_run_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
         VALUES ${vfValues}`,
        [sortClientId, ...runIds],
      );
    }

    it('AC1: sorting by variance surfaces the true largest-variance finding even when 50+ other findings exist', async () => {
      const rows = await withTenantTx({ clientIds: [sortClientId], internal: true }, async (c) => {
        // 55 filler rows with variance 1.00..55.00 -- all rank below the
        // default LIMIT 50 page boundary by created_at (insertion order), so
        // a query that sorted only the first page would never see the
        // interesting row seeded below.
        await seedFillerRows(c, 55);

        // The interesting row: backdated created_at (a day in the past) so
        // it sorts OUTSIDE the default LIMIT 50 page under the old
        // created_at-DESC-then-slice behavior (the 55 filler rows, all
        // created just now, would fill that page first). Its variance
        // (99999.00) is far above every filler row (1.00-55.00), so ORDER BY
        // variance_amount DESC must surface it first regardless of when it
        // was created -- proving sort now operates on the full result set,
        // not just whatever the default page happened to contain.
        const inv = await c.query(
          `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
           VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
          [sortClientId, sortCarrierId, `INV-${sortTag}-BIGGEST`],
        );
        const run = await c.query(
          `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome, created_at)
           VALUES ($1, $2, 'test', 'SCORED', NOW() - INTERVAL '1 day') RETURNING id`,
          [sortClientId, inv.rows[0].id],
        );
        await c.query(
          `INSERT INTO variance_finding (client_id, audit_run_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr, created_at)
           SELECT $1, $2, c.id, rv.id, 'OVERCHARGE', '99999.0000', 'USD', 'open', '{}'::jsonb, NOW() - INTERVAL '1 day'
           FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
           JOIN rule_version rv ON rv.rule_id = r.id
           WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1`,
          [sortClientId, run.rows[0].id],
        );

        return listFindings(c, { clientIds: [sortClientId], sort: 'variance', sortDir: 'desc' });
      });

      // Backdating created_at puts BIGGEST outside the default page when
      // sorted by created_at DESC (the old, wrong behavior) -- but ORDER BY
      // variance_amount DESC must still surface it first regardless.
      expect(rows[0]?.invoiceNumber).toBe(`INV-${sortTag}-BIGGEST`);
      expect(rows[0]?.varianceAmount).toBe('99999.0000');
    });

    it('AC1: sorting by variance ASC surfaces the smallest, even past the default LIMIT 50 window', async () => {
      const rows = await withTenantTx({ clientIds: [sortClientId], internal: true }, async (c) => {
        return listFindings(c, { clientIds: [sortClientId], sort: 'variance', sortDir: 'asc', limit: 5 });
      });
      // Filler rows (1.00..55.00) plus BIGGEST (99999.00) from the previous
      // test -- ascending, the 5 smallest are 1.00..5.00, none of which are
      // BIGGEST or anywhere near the top of a created_at-DESC page.
      // numeric(18,4) round-trips as a 4-decimal string via pg, same as
      // every other variance_amount assertion in this file.
      expect(rows.map((r) => r.varianceAmount)).toEqual(['1.0000', '2.0000', '3.0000', '4.0000', '5.0000']);
    });
  });
});
