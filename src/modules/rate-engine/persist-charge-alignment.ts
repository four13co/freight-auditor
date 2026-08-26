import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { VarianceAttribution } from './attribute-grouped-variance.js';

export async function persistChargeAlignment(client: pg.PoolClient, input: {
  clientId: string; auditRunId: string; attribution: VarianceAttribution;
}): Promise<string> {
  const { attribution: a } = input;
  const idempotencyKey = createHash('sha256').update(JSON.stringify({ level: a.level, key: a.key })).digest('hex');
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO charge_alignment (client_id, audit_run_id, label, level, attribution_key, currency,
       billed_total, expected_total, variance_amount, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (client_id, audit_run_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
    [input.clientId, input.auditRunId, `${a.level}:${a.key}`, a.level, a.key, a.currency,
      a.billedTotal, a.expectedTotal, a.varianceAmount, idempotencyKey],
  );
  let alignmentId = inserted.rows[0]?.id;
  if (!alignmentId) {
    const existing = await client.query<{ id: string; billed_total: string; expected_total: string; variance_amount: string }>(
      `SELECT id, billed_total, expected_total, variance_amount FROM charge_alignment
       WHERE client_id=$1 AND audit_run_id=$2 AND idempotency_key=$3`, [input.clientId, input.auditRunId, idempotencyKey]);
    const row = existing.rows[0];
    if (!row || row.billed_total !== a.billedTotal || row.expected_total !== a.expectedTotal || row.variance_amount !== a.varianceAmount)
      throw new Error(`charge-alignment source conflict: ${a.level}|${a.key}`);
    alignmentId = row.id;
  }
  for (const chargeFactId of a.billedIds) await client.query(
    `INSERT INTO charge_alignment_member (client_id, alignment_id, charge_fact_id)
     VALUES ($1,$2,$3) ON CONFLICT (alignment_id, charge_fact_id) WHERE charge_fact_id IS NOT NULL DO NOTHING`,
    [input.clientId, alignmentId, chargeFactId]);
  for (const expectedChargeId of a.expectedIds) await client.query(
    `INSERT INTO charge_alignment_member (client_id, alignment_id, expected_charge_id)
     VALUES ($1,$2,$3) ON CONFLICT (alignment_id, expected_charge_id) WHERE expected_charge_id IS NOT NULL DO NOTHING`,
    [input.clientId, alignmentId, expectedChargeId]);
  return alignmentId;
}
