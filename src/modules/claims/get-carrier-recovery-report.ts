import type pg from 'pg';
import { z } from 'zod';
import { aggregateCarrierRecovery, type CarrierRecoveryBucket } from './aggregate-carrier-recovery.js';

const schema = z.object({
  clientId: z.uuid(),
  carrierId: z.uuid().optional(),
}).strict();

/**
 * Carrier-level recovery reporting (P5.C.1): fetches this tenant's claims
 * (optionally scoped to one carrier via dispute.carrier_id -- 0008/0004's
 * existing claim -> dispute -> carrier join path) plus their full
 * recovery_event history, then hands both to the pure
 * aggregateCarrierRecovery for the actual bucketing/reconciliation math.
 *
 * Scope boundary: this is the backend aggregation only. The reporting UI
 * consuming this (a table/chart per carrier) is P5.C.2/P5.C.3's boundary,
 * not built here. P5.C.4 (reconcile claimed/recovered/outstanding/
 * written-off totals) depends on this item in ClickUp and can build a
 * portfolio-wide (cross-carrier) version once this lands.
 */
export async function getCarrierRecoveryReport(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<CarrierRecoveryBucket[]> {
  const input = schema.parse(untrusted);

  const { rows: claimRows } = await client.query<{
    carrier_id: string | null; claim_id: string; amount_claimed: string; currency: string | null; status: string;
  }>(
    `SELECT d.carrier_id, c.id AS claim_id, c.amount_claimed, c.currency, c.status
       FROM claim c
       LEFT JOIN dispute d ON d.id = c.dispute_id
      WHERE c.client_id = $1
        AND ($2::uuid IS NULL OR d.carrier_id = $2::uuid)`,
    [input.clientId, input.carrierId ?? null],
  );

  if (claimRows.length === 0) return [];

  const claimIds = claimRows.map((r) => r.claim_id);
  const { rows: eventRows } = await client.query<{ claim_id: string; amount_recovered: string; currency: string | null }>(
    `SELECT claim_id, amount_recovered, currency FROM recovery_event WHERE client_id = $1 AND claim_id = ANY($2::uuid[])`,
    [input.clientId, claimIds],
  );

  return aggregateCarrierRecovery(
    claimRows.map((r) => ({ carrierId: r.carrier_id, claimId: r.claim_id, amountClaimed: r.amount_claimed, currency: r.currency, status: r.status })),
    eventRows.map((r) => ({ claimId: r.claim_id, amountRecovered: r.amount_recovered, currency: r.currency })),
  );
}
