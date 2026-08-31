import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import {
  validateClaimableDispute,
  type ClaimableDisputeRow,
} from './validate-claimable-dispute.js';
import { detectDuplicateClaimedFinding } from './detect-duplicate-claimed-finding.js';

const schema = z.object({
  clientId: z.uuid(),
  disputeId: z.uuid(),
  actorUserId: z.uuid().optional(),
});

export { ClaimableDisputeError } from './validate-claimable-dispute.js';

export class DisputeNotFoundError extends Error {
  constructor() {
    super('Dispute not found for this client');
    this.name = 'DisputeNotFoundError';
  }
}

export interface CreateClaimResult {
  claimId: string;
  disputeId: string;
  amountClaimed: string;
  currency: string;
  created: boolean;
}

/**
 * Create a claim from an accepted dispute (P5.A.1): loads the dispute,
 * validates it as claimable (accepted status, positive amount/currency --
 * see validate-claimable-dispute.ts), and opens one claim row against it.
 *
 * Idempotent per dispute via a real UNIQUE(client_id, dispute_id) partial
 * index (migration 0055): INSERT ... ON CONFLICT DO NOTHING, then a
 * fallback SELECT for the winning row if this call lost a concurrent race
 * -- the pattern used elsewhere this session (createWorkflowInstance) once
 * a real constraint exists, replacing the earlier plain SELECT-then-INSERT
 * that #165's review closure found unconstrained.
 *
 * Also prevents the same variance_finding's dollars being claimed twice
 * through two different disputes (P5.A.2, 86e2zfj4w,
 * detect-duplicate-claimed-finding.ts) -- checked after the idempotent-retry
 * short-circuit (a retry never needs re-checking) and before the INSERT, so
 * the conflict is caught before any write.
 */
export async function createClaimFromDispute(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<CreateClaimResult> {
  const input = schema.parse(untrusted);

  const { rows: disputeRows } = await client.query<ClaimableDisputeRow>(
    `SELECT id, status::text AS status, amount_claimed AS "amountClaimed", currency
       FROM dispute
      WHERE client_id = $1 AND id = $2`,
    [input.clientId, input.disputeId],
  );
  const disputeRow = disputeRows[0];
  if (!disputeRow) throw new DisputeNotFoundError();

  const existing = await selectExistingClaim(client, input.clientId, input.disputeId);
  if (existing) return { ...existing, created: false };

  const validated = validateClaimableDispute(disputeRow);

  await detectDuplicateClaimedFinding(client, input.clientId, input.disputeId);

  const { rows: inserted } = await client.query<{ id: string }>(
    `INSERT INTO claim (client_id, dispute_id, amount_claimed, currency, status)
     VALUES ($1, $2, $3, $4, 'open')
     ON CONFLICT (client_id, dispute_id) WHERE dispute_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [input.clientId, validated.disputeId, validated.amountClaimed, validated.currency],
  );

  const insertedRow = inserted[0];
  if (!insertedRow) {
    // Lost the race to a concurrent insert -- read back the winner's row.
    const raced = await selectExistingClaim(client, input.clientId, input.disputeId);
    if (!raced) throw new Error('claim insert conflicted but no row was found on re-read');
    return { ...raced, created: false };
  }
  const claimId = insertedRow.id;

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, claimId, 'claim.created'),
    clientId: input.clientId,
    entity: 'claim',
    entityId: claimId,
    event: 'claim.created',
    actorKind: 'analyst',
    actorUserId: input.actorUserId ?? null,
    detail: { disputeId: validated.disputeId, amountClaimed: validated.amountClaimed, currency: validated.currency },
  });

  return {
    claimId,
    disputeId: validated.disputeId,
    amountClaimed: validated.amountClaimed,
    currency: validated.currency,
    created: true,
  };
}

async function selectExistingClaim(
  client: pg.PoolClient,
  clientId: string,
  disputeId: string,
): Promise<Omit<CreateClaimResult, 'created'> | null> {
  const { rows } = await client.query<{ id: string; amount_claimed: string; currency: string | null }>(
    `SELECT id, amount_claimed, currency FROM claim WHERE client_id = $1 AND dispute_id = $2 LIMIT 1`,
    [clientId, disputeId],
  );
  const row = rows[0];
  if (!row) return null;
  return { claimId: row.id, disputeId, amountClaimed: row.amount_claimed, currency: row.currency ?? '' };
}
