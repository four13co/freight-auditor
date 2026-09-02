import type pg from 'pg';
import { Decimal } from 'decimal.js';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

export interface DisputeTransitionResult {
  /** false when the dispute doesn't exist, isn't visible under RLS, or isn't currently in the required from-state -- caller maps this to 404/409 as appropriate. */
  found: boolean;
}

export class DisputeTransitionError extends Error {
  constructor(readonly code: 'ACCEPTED_AMOUNT_EXCEEDS_CLAIMED') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'DisputeTransitionError';
  }
}

/** A carrier can respond to a dispute once it has been sent (or is already marked in_progress). */
const RESPONDABLE_STATUSES = ['sent', 'in_progress'];
/** Any of the three carrier-response outcomes can be wrapped up as closed. */
const RESOLVED_STATUSES = ['accepted', 'rejected', 'partial'];

interface DisputeRow {
  id: string;
  client_id: string;
  status: string;
  amount_claimed: string | null;
}

/**
 * Reads the dispute's current row for a from-state check, without locking
 * it -- each transition's own guarded UPDATE re-checks the SAME from-set
 * afterward, so a concurrent transition landing between this SELECT and
 * that UPDATE is still caught safely (the UPDATE simply matches nothing,
 * and the caller reports found: false). Split into its own SELECT (rather
 * than approve-dispute.ts's single-UPDATE guard) because
 * partiallyAcceptDispute also needs amount_claimed to validate against
 * before deciding whether to write anything at all.
 */
async function selectRespondableDispute(
  client: pg.PoolClient,
  disputeId: string,
  fromStatuses: readonly string[],
): Promise<DisputeRow | null> {
  const { rows } = await client.query<DisputeRow>(
    `SELECT id, client_id, status, amount_claimed FROM dispute WHERE id = $1`,
    [disputeId],
  );
  const row = rows[0];
  if (!row || !fromStatuses.includes(row.status)) return null;
  return row;
}

async function writeTransitionAuditEvent(
  client: pg.PoolClient,
  row: { id: string; client_id: string },
  fromStatus: string,
  toStatus: string,
  event: string,
  actorUserId: string,
  extraDetail: Record<string, unknown> = {},
): Promise<void> {
  await writeAuditEvent(client, {
    id: deterministicAuditEventId(row.client_id, row.id, event),
    clientId: row.client_id,
    entity: 'dispute',
    entityId: row.id,
    event,
    actorKind: 'analyst',
    actorUserId,
    detail: { fromStatus, toStatus, ...extraDetail },
  });
}

/** Carrier accepts the dispute in full: sent/in_progress -> accepted. */
export async function acceptDispute(
  client: pg.PoolClient,
  disputeId: string,
  actorUserId: string,
): Promise<DisputeTransitionResult> {
  const disputeRow = await selectRespondableDispute(client, disputeId, RESPONDABLE_STATUSES);
  if (!disputeRow) return { found: false };

  const result = await client.query<{ id: string; client_id: string }>(
    `UPDATE dispute SET status = 'accepted' WHERE id = $1 AND status = ANY($2::dispute_status[]) RETURNING id, client_id`,
    [disputeId, RESPONDABLE_STATUSES],
  );
  const row = result.rows[0];
  if (!row) return { found: false };

  await writeTransitionAuditEvent(client, row, disputeRow.status, 'accepted', 'dispute.accepted', actorUserId);
  return { found: true };
}

/** Carrier rejects the dispute outright: sent/in_progress -> rejected. */
export async function rejectDispute(
  client: pg.PoolClient,
  disputeId: string,
  actorUserId: string,
): Promise<DisputeTransitionResult> {
  const disputeRow = await selectRespondableDispute(client, disputeId, RESPONDABLE_STATUSES);
  if (!disputeRow) return { found: false };

  const result = await client.query<{ id: string; client_id: string }>(
    `UPDATE dispute SET status = 'rejected' WHERE id = $1 AND status = ANY($2::dispute_status[]) RETURNING id, client_id`,
    [disputeId, RESPONDABLE_STATUSES],
  );
  const row = result.rows[0];
  if (!row) return { found: false };

  await writeTransitionAuditEvent(client, row, disputeRow.status, 'rejected', 'dispute.rejected', actorUserId);
  return { found: true };
}

/**
 * Carrier agrees to pay part of the disputed amount: sent/in_progress ->
 * partial, recording accepted_amount (0069) in the dispute's own currency
 * -- a partial acceptance is a fraction of the SAME claimed amount, never
 * a currency conversion, so no separate currency input is accepted or
 * needed. Throws DisputeTransitionError rather than returning found:false
 * when acceptedAmount exceeds amount_claimed -- that is a genuine caller
 * validation error, distinct from "dispute not found/not respondable", and
 * nothing is written to the row or the audit ledger in that case.
 */
export async function partiallyAcceptDispute(
  client: pg.PoolClient,
  disputeId: string,
  actorUserId: string,
  acceptedAmount: string,
): Promise<DisputeTransitionResult> {
  const disputeRow = await selectRespondableDispute(client, disputeId, RESPONDABLE_STATUSES);
  if (!disputeRow) return { found: false };

  if (disputeRow.amount_claimed !== null && new Decimal(acceptedAmount).greaterThan(new Decimal(disputeRow.amount_claimed))) {
    throw new DisputeTransitionError('ACCEPTED_AMOUNT_EXCEEDS_CLAIMED');
  }

  const result = await client.query<{ id: string; client_id: string }>(
    `UPDATE dispute SET status = 'partial', accepted_amount = $2 WHERE id = $1 AND status = ANY($3::dispute_status[]) RETURNING id, client_id`,
    [disputeId, acceptedAmount, RESPONDABLE_STATUSES],
  );
  const row = result.rows[0];
  if (!row) return { found: false };

  await writeTransitionAuditEvent(client, row, disputeRow.status, 'partial', 'dispute.partially_accepted', actorUserId, { acceptedAmount });
  return { found: true };
}

/** Wraps up a resolved dispute: accepted/rejected/partial -> closed. */
export async function closeDispute(
  client: pg.PoolClient,
  disputeId: string,
  actorUserId: string,
): Promise<DisputeTransitionResult> {
  const disputeRow = await selectRespondableDispute(client, disputeId, RESOLVED_STATUSES);
  if (!disputeRow) return { found: false };

  const result = await client.query<{ id: string; client_id: string }>(
    `UPDATE dispute SET status = 'closed' WHERE id = $1 AND status = ANY($2::dispute_status[]) RETURNING id, client_id`,
    [disputeId, RESOLVED_STATUSES],
  );
  const row = result.rows[0];
  if (!row) return { found: false };

  await writeTransitionAuditEvent(client, row, disputeRow.status, 'closed', 'dispute.closed', actorUserId);
  return { found: true };
}
