import type pg from 'pg';
import { z } from 'zod';

const DIRECTIONS = ['inbound', 'outbound'] as const;
export type DisputeCommDirection = (typeof DIRECTIONS)[number];

const recordSchema = z.object({
  disputeId: z.uuid(),
  direction: z.enum(DIRECTIONS),
  body: z.string().trim().min(1).max(10_000),
  dedupeKey: z.string().trim().min(1).max(255),
}).strict();

export interface RecordDisputeCommunicationResult {
  disputeCommId: string;
  created: boolean;
}

export class RecordDisputeCommunicationError extends Error {
  constructor(readonly code: 'DISPUTE_NOT_FOUND') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'RecordDisputeCommunicationError';
  }
}

/**
 * Records one inbound or outbound dispute communication (P4.C.8) into
 * dispute_comm (0008's append-only log, unused until now -- no writer
 * existed anywhere in this repo before this task). Mirrors
 * recordOutboxMessage's (P4.A.5) idempotent-insert shape exactly:
 * INSERT ... ON CONFLICT (client_id, dedupe_key) DO NOTHING, then a plain
 * SELECT for the existing row when the insert no-ops. That is what makes a
 * retried/duplicate recording of the same real-world communication stable
 * rather than a second append-only row (this task's own "invalid,
 * duplicate, expired, and retry inputs have stable behavior" AC).
 *
 * Looks up the dispute's own client_id (RLS-scoped, `WHERE id = $1` with no
 * separate clientId input) rather than requiring the caller to supply and
 * pre-validate one -- the same shape approveDispute's and
 * updateFindingStatus's own `UPDATE ... WHERE id = $1 RETURNING client_id`
 * queries use. A dispute that doesn't exist, or isn't visible under RLS for
 * the caller's tenant, is indistinguishable here and both map to
 * DISPUTE_NOT_FOUND -- the caller (the API route) turns that into a 404,
 * matching get-dispute-detail.ts's/approve-dispute.ts's own not-found
 * convention for the same ambiguity.
 *
 * No writeAuditEvent call: unlike workflow_outbox_message (a delivery
 * *decision* that is itself part of the workflow lifecycle),
 * dispute_comm's own append-only, RLS-scoped grant (0009/0010) already IS
 * the durable record of the communication -- the same reasoning
 * create-dispute-from-findings.ts's dispute_line inserts already follow
 * (no per-line audit_event, only one for the dispute as a whole).
 */
export async function recordDisputeCommunication(
  client: pg.PoolClient,
  untrusted: z.input<typeof recordSchema>,
): Promise<RecordDisputeCommunicationResult> {
  const input = recordSchema.parse(untrusted);

  const dispute = await client.query<{ client_id: string }>(
    `SELECT client_id FROM dispute WHERE id = $1`,
    [input.disputeId],
  );
  const disputeRow = dispute.rows[0];
  if (!disputeRow) throw new RecordDisputeCommunicationError('DISPUTE_NOT_FOUND');
  const clientId = disputeRow.client_id;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO dispute_comm (client_id, dispute_id, direction, body, dedupe_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (client_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [clientId, input.disputeId, input.direction, input.body, input.dedupeKey],
  );

  if (inserted.rows[0]) {
    return { disputeCommId: inserted.rows[0].id, created: true };
  }

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM dispute_comm WHERE client_id = $1 AND dedupe_key = $2`,
    [clientId, input.dedupeKey],
  );
  return { disputeCommId: existing.rows[0]!.id, created: false };
}
