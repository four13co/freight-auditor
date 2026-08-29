import type pg from 'pg';
import { z } from 'zod';
import { computeClaimAgingDeadline } from './compute-claim-aging-deadline.js';

const schema = z.object({
  clientId: z.uuid(),
  claimId: z.uuid(),
  agingDays: z.number().int().positive().max(3650).default(30),
}).strict();

export class SetClaimAgingDeadlineError extends Error {
  constructor(readonly code: 'CLAIM_NOT_FOUND') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'SetClaimAgingDeadlineError';
  }
}

export interface SetClaimAgingDeadlineResult {
  claimId: string;
  agingDeadlineAt: string;
}

/**
 * Sets a claim's aging deadline (P5.B.1) from its opened_at plus a
 * configurable number of days (compute-claim-aging-deadline.ts, unchanged
 * logic). Idempotent by nature -- recomputing from the same opened_at and
 * agingDays always yields the same deadline, so a retry overwrites with an
 * identical value rather than drifting.
 */
export async function setClaimAgingDeadline(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<SetClaimAgingDeadlineResult> {
  const input = schema.parse(untrusted);

  const { rows } = await client.query<{ opened_at: string }>(
    `SELECT opened_at FROM claim WHERE client_id = $1 AND id = $2`,
    [input.clientId, input.claimId],
  );
  const claimRow = rows[0];
  if (!claimRow) throw new SetClaimAgingDeadlineError('CLAIM_NOT_FOUND');

  const deadline = computeClaimAgingDeadline({ openedAt: claimRow.opened_at, agingDays: input.agingDays });

  await client.query(`UPDATE claim SET aging_deadline_at = $3 WHERE client_id = $1 AND id = $2`, [
    input.clientId, input.claimId, deadline.toISOString(),
  ]);

  return { claimId: input.claimId, agingDeadlineAt: deadline.toISOString() };
}
