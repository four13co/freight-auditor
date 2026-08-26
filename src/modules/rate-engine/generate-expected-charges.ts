import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type pg from 'pg';

export type ExpectedChargeCalculation =
  | { kind: 'FLAT'; amount: string }
  | { kind: 'RATE_TIMES_BASIS'; rate: string; basis: string };

export interface ExpectedChargeSpec {
  /** Stable identity of the rate-cell/application within this audit run. */
  sourceKey: string;
  category: string;
  currency: string;
  chargeFactId?: string | null;
  clauseId?: string | null;
  rateCellId?: string | null;
  sourceDocumentId?: string | null;
  calculation: ExpectedChargeCalculation;
}

export interface GeneratedExpectedCharge {
  idempotencyKey: string;
  sourceKey: string;
  category: string;
  currency: string;
  expectedAmount: string;
  chargeFactId: string | null;
  clauseId: string | null;
  rateCellId: string | null;
  sourceDocumentId: string | null;
  calculation: Readonly<Record<string, string>>;
}

const decimal = (value: string, field: string): Decimal => {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw new Error(`${field} must be a decimal`);
  }
  if (!parsed.isFinite() || parsed.isNegative()) throw new Error(`${field} must be a non-negative finite decimal`);
  return parsed;
};

/** Pure, deterministic expected-side charge generation. No billed-side matching occurs here. */
export function generateExpectedCharges(specs: readonly ExpectedChargeSpec[]): GeneratedExpectedCharge[] {
  const seen = new Set<string>();
  const generated = specs.map((spec) => {
    const sourceKey = spec.sourceKey.trim();
    const category = spec.category.trim().toUpperCase();
    const currency = spec.currency.trim().toUpperCase();
    if (!sourceKey) throw new Error('sourceKey is required');
    if (!category) throw new Error('category is required');
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`invalid currency for ${sourceKey}`);
    if (seen.has(sourceKey)) throw new Error(`duplicate expected-charge sourceKey: ${sourceKey}`);
    seen.add(sourceKey);

    let amount: Decimal;
    let calculation: Record<string, string>;
    if (spec.calculation.kind === 'FLAT') {
      const flatAmount = decimal(spec.calculation.amount, `${sourceKey}.amount`);
      amount = flatAmount;
      calculation = { kind: 'FLAT', amount: flatAmount.toFixed(4) };
    } else {
      const rate = decimal(spec.calculation.rate, `${sourceKey}.rate`);
      const basis = decimal(spec.calculation.basis, `${sourceKey}.basis`);
      amount = rate.mul(basis);
      calculation = { kind: 'RATE_TIMES_BASIS', rate: rate.toFixed(4), basis: basis.toFixed(4) };
    }
    const expectedAmount = amount.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
    const identity = JSON.stringify({ sourceKey });
    return {
      idempotencyKey: createHash('sha256').update(identity).digest('hex'),
      sourceKey,
      category,
      currency,
      expectedAmount,
      chargeFactId: spec.chargeFactId ?? null,
      clauseId: spec.clauseId ?? null,
      rateCellId: spec.rateCellId ?? null,
      sourceDocumentId: spec.sourceDocumentId ?? null,
      calculation,
    };
  });
  return generated.sort((a, b) => a.category.localeCompare(b.category) || a.sourceKey.localeCompare(b.sourceKey));
}

export interface PersistExpectedChargesInput {
  clientId: string;
  auditRunId: string;
  charges: readonly GeneratedExpectedCharge[];
}

/** Inserts immutable evidence; an exact retry resolves to the original rows. */
export async function persistExpectedCharges(
  client: pg.PoolClient,
  input: PersistExpectedChargesInput,
): Promise<string[]> {
  const ids: string[] = [];
  for (const charge of input.charges) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO expected_charge
         (client_id, audit_run_id, charge_fact_id, category, expected_amount, currency,
          idempotency_key, source_key, calculation, clause_id, rate_cell_id, source_document_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (client_id, audit_run_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING RETURNING id`,
      [input.clientId, input.auditRunId, charge.chargeFactId, charge.category, charge.expectedAmount,
        charge.currency, charge.idempotencyKey, charge.sourceKey, JSON.stringify(charge.calculation), charge.clauseId,
        charge.rateCellId, charge.sourceDocumentId],
    );
    if (inserted.rows[0]) {
      ids.push(inserted.rows[0].id);
      continue;
    }
    const existing = await client.query<{
      id: string; category: string; currency: string; expected_amount: string; source_key: string;
      calculation: Record<string, string>; charge_fact_id: string | null; clause_id: string | null;
      rate_cell_id: string | null; source_document_id: string | null;
    }>(
      `SELECT id, category, currency, expected_amount, source_key, calculation, charge_fact_id, clause_id, rate_cell_id, source_document_id
       FROM expected_charge
       WHERE client_id = $1 AND audit_run_id = $2 AND idempotency_key = $3`,
      [input.clientId, input.auditRunId, charge.idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) throw new Error('expected-charge idempotency conflict could not be resolved');
    const exactRetry = row.category === charge.category && row.currency === charge.currency
      && new Decimal(row.expected_amount).toFixed(4) === charge.expectedAmount && row.source_key === charge.sourceKey
      && JSON.stringify(row.calculation) === JSON.stringify(charge.calculation)
      && row.charge_fact_id === charge.chargeFactId && row.clause_id === charge.clauseId
      && row.rate_cell_id === charge.rateCellId && row.source_document_id === charge.sourceDocumentId;
    if (!exactRetry) throw new Error(`expected-charge source conflict: ${charge.sourceKey}`);
    ids.push(row.id);
  }
  return ids;
}
