import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import {
  validateClaimableDispute,
  type ClaimableDisputeRow,
} from './validate-claimable-dispute.js';

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
 * Idempotent per dispute: a claim row already open/settled against this
 * dispute short-circuits to that existing row (created: false) rather than
 * opening a second one. No unique constraint backs this yet (claim carries
 * no per-dispute uniqueness in migrations/0008), so this is a plain
 * SELECT-then-INSERT inside the caller's transaction, not an
 * ON CONFLICT upsert.
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

  const { rows: existingClaims } = await client.query<{ id: string; amount_claimed: string; currency: string | null }>(
    `SELECT id, amount_claimed, currency FROM claim WHERE client_id = $1 AND dispute_id = $2 LIMIT 1`,
    [input.clientId, input.disputeId],
  );
  const existing = existingClaims[0];
  if (existing) {
    return {
      claimId: existing.id,
      disputeId: input.disputeId,
      amountClaimed: existing.amount_claimed,
      currency: existing.currency ?? '',
      created: false,
    };
  }

  const validated = validateClaimableDispute(disputeRow);

  const { rows: inserted } = await client.query<{ id: string }>(
    `INSERT INTO claim (client_id, dispute_id, amount_claimed, currency, status)
     VALUES ($1, $2, $3, $4, 'open')
     RETURNING id`,
    [input.clientId, validated.disputeId, validated.amountClaimed, validated.currency],
  );
  const claimId = inserted[0]!.id;

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
