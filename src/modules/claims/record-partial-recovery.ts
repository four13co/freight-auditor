import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import { validatePartialRecovery, type ClaimRow } from './validate-partial-recovery.js';

const schema = z.object({
  clientId: z.uuid(),
  claimId: z.uuid(),
  amountRecovered: z.string().regex(/^\d+(\.\d{1,4})?$/),
  currency: z.string().length(3),
  varianceFindingId: z.uuid().optional(),
}).strict();

export { PartialRecoveryError } from './validate-partial-recovery.js';

export class RecordPartialRecoveryError extends Error {
  constructor(readonly code: 'CLAIM_NOT_FOUND') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'RecordPartialRecoveryError';
  }
}

export interface RecordPartialRecoveryResult {
  recoveryEventId: string;
  cumulativeRecovered: string;
  isFinal: boolean;
}

/**
 * Record one partial recovery event against a claim (P5.A.3).
 * recovery_event is append-only (0010), so every call inserts a new row --
 * this is not idempotent-by-retry the way this session's payment-gate
 * generators are, because a genuine second recovery payment against the
 * same claim is a legitimate second event, not a duplicate of the first.
 * A caller needing retry-safety for a specific payment must dedupe before
 * calling this (out of scope here, matching the pattern that recovery
 * events are keyed by nothing but their own id).
 *
 * Validates against the claim's amount_claimed and the SUM of its prior
 * recovery_event rows, computed fresh inside this transaction (never
 * cached), so concurrent partial recoveries against the same claim are
 * each checked against the true prior total as of their own transaction.
 */
export async function recordPartialRecovery(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<RecordPartialRecoveryResult> {
  const input = schema.parse(untrusted);

  const { rows: claimRows } = await client.query<{ id: string; amount_claimed: string; currency: string | null }>(
    `SELECT id, amount_claimed, currency FROM claim WHERE client_id = $1 AND id = $2`,
    [input.clientId, input.claimId],
  );
  const claimRow = claimRows[0];
  if (!claimRow) throw new RecordPartialRecoveryError('CLAIM_NOT_FOUND');
  const claim: ClaimRow = { id: claimRow.id, amountClaimed: claimRow.amount_claimed, currency: claimRow.currency };

  const { rows: priorRows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_recovered), 0)::text AS total FROM recovery_event WHERE client_id = $1 AND claim_id = $2`,
    [input.clientId, input.claimId],
  );
  const priorTotal = priorRows[0]!.total;

  const validated = validatePartialRecovery(claim, input.amountRecovered, input.currency, priorTotal);

  const { rows: inserted } = await client.query<{ id: string }>(
    `INSERT INTO recovery_event (client_id, claim_id, variance_finding_id, amount_recovered, currency)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.clientId, input.claimId, input.varianceFindingId ?? null, validated.amountRecovered, validated.currency],
  );
  const recoveryEventId = inserted[0]!.id;

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, recoveryEventId, 'recovery-event.recorded'),
    clientId: input.clientId,
    entity: 'recovery_event',
    entityId: recoveryEventId,
    event: 'recovery_event.recorded',
    actorKind: 'analyst',
    detail: {
      claimId: input.claimId,
      amountRecovered: validated.amountRecovered,
      cumulativeRecovered: validated.cumulativeRecovered,
      isFinal: validated.isFinal,
    },
  });

  return { recoveryEventId, cumulativeRecovered: validated.cumulativeRecovered, isFinal: validated.isFinal };
}
