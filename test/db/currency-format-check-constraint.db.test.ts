import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { cleanupTenantFixtures } from './helpers/cleanup-tenant-fixtures.js';

/**
 * 86e2zfjkk (P5.C.6). Format-only guard (3 uppercase letters, not a real
 * ISO-4217 registry check) on every currency char(3) column -- migration
 * 0074. The 14 (table, column) pairs below are every `currency char(3)`
 * column in the schema as of migrations 0007-0026 (confirmed via
 * `grep -rniE "currency\s+char" migrations/*.sql`, re-checked against every
 * migration after 0026 for a rename/drop -- none touches these columns).
 */
const CURRENCY_COLUMNS: Array<{ table: string; constraint: string }> = [
  { table: 'invoice', constraint: 'invoice_currency_format_chk' },
  { table: 'charge_fact', constraint: 'charge_fact_currency_format_chk' },
  { table: 'expected_charge', constraint: 'expected_charge_currency_format_chk' },
  { table: 'charge_finding', constraint: 'charge_finding_currency_format_chk' },
  { table: 'variance_finding', constraint: 'variance_finding_currency_format_chk' },
  { table: 'scorecard', constraint: 'scorecard_currency_format_chk' },
  { table: 'dispute', constraint: 'dispute_currency_format_chk' },
  { table: 'dispute_line', constraint: 'dispute_line_currency_format_chk' },
  { table: 'payment_gate_decision', constraint: 'payment_gate_decision_currency_format_chk' },
  { table: 'claim', constraint: 'claim_currency_format_chk' },
  { table: 'recovery_event', constraint: 'recovery_event_currency_format_chk' },
  { table: 'contract_rate', constraint: 'contract_rate_currency_format_chk' },
  { table: 'charge_alignment', constraint: 'charge_alignment_currency_format_chk' },
  { table: 'rate_cell', constraint: 'rate_cell_currency_format_chk' },
];

describe('currency format CHECK constraint (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `cfc-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('CFC', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    await cleanupTenantFixtures(pool, [clientId]);
    await closePool();
  });

  it('adds a `currency ~ \'^[A-Z]{3}$\'` CHECK constraint on every currency char(3) column', async () => {
    const owner = await pool.connect();
    try {
      for (const { table, constraint } of CURRENCY_COLUMNS) {
        const res = await owner.query(
          `SELECT pg_get_constraintdef(oid) AS def
             FROM pg_constraint
            WHERE conrelid = $1::regclass AND conname = $2`,
          [table, constraint],
        );
        expect(res.rows, `expected ${constraint} on ${table}`).toHaveLength(1);
        expect(res.rows[0].def).toContain("currency ~ '^[A-Z]{3}$'::text");
      }
    } finally {
      owner.release();
    }
  });

  it('rejects a malformed currency value on dispute (lowercase, wrong length, digits)', async () => {
    const owner = await pool.connect();
    try {
      for (const bad of ['usd', 'US', '12A']) {
        await expect(
          owner.query(`INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, 'draft', '100.0000', $2)`, [
            clientId,
            bad,
          ]),
        ).rejects.toMatchObject({ code: '23514' });
      }
    } finally {
      owner.release();
    }
  });

  it('rejects a malformed currency value on claim', async () => {
    const owner = await pool.connect();
    try {
      await expect(
        owner.query(`INSERT INTO claim (client_id, amount_claimed, currency) VALUES ($1, '100.0000', $2)`, [clientId, 'eur']),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      owner.release();
    }
  });

  it('accepts a valid 3-uppercase-letter currency value unchanged (dispute, claim)', async () => {
    const owner = await pool.connect();
    try {
      const dispute = await owner.query(
        `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, 'draft', '100.0000', 'USD') RETURNING id, currency`,
        [clientId],
      );
      expect(dispute.rows[0].currency).toBe('USD');

      const claim = await owner.query(
        `INSERT INTO claim (client_id, amount_claimed, currency) VALUES ($1, '100.0000', 'EUR') RETURNING id, currency`,
        [clientId],
      );
      expect(claim.rows[0].currency).toBe('EUR');
    } finally {
      owner.release();
    }
  });

  it('still allows a NULL currency where the column is nullable (dispute)', async () => {
    const owner = await pool.connect();
    try {
      const res = await owner.query(
        `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, 'draft', '100.0000', NULL) RETURNING id, currency`,
        [clientId],
      );
      expect(res.rows[0].currency).toBeNull();
    } finally {
      owner.release();
    }
  });
});
