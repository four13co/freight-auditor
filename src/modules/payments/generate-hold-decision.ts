import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const schema = z.object({
  clientId: z.uuid(),
  auditRunId: z.uuid(),
  holdThenApprove: z.boolean().default(true),
}).strict();

export class GenerateHoldDecisionError extends Error {
  constructor(readonly code: 'AUDIT_RUN_NOT_SCORED') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'GenerateHoldDecisionError';
  }
}

export interface HoldDecisionResult {
  decisionId: string | null;
  created: boolean;
}

/**
 * Generate a default 'hold' payment_gate_decision for an audit run that has
 * reached SCORED (P4.B.2) -- the platform default is hold-then-approve
 * (Master Spec §10), so a payable invoice is held pending an analyst's
 * explicit authorizePayment('approve') (P4.B.5/#164) rather than being paid
 * automatically. No amount is computed here; this only records the gate
 * state, mirroring generate-do-not-pay-decision.ts's split between gate
 * classification and any later amount computation.
 *
 * holdThenApprove defaults to true and is accepted as a PARAMETER rather
 * than read internally -- the caller resolves the client's policy (or
 * accepts the true default) and passes it in; this function never reads
 * client_payment_policy itself. (86e367r9x: client_payment_policy, migration
 * 0058, is applied and upsertPaymentPolicy already works against it -- an
 * earlier version of this comment claimed the table "does not exist on this
 * branch," which was stale even before this function's only real caller,
 * persist.ts, was wired up.) holdThenApprove: false means the client has
 * opted out of the default hold, so this generates no decision at all
 * (short-pay/opt-out enforcement for that path is P4.B.3's boundary, not
 * this one's).
 *
 * Idempotent per (client, audit_run, 'hold'): payment_gate_decision does
 * have a unique constraint on (client_id, audit_run_id, action) (migration
 * 0052's payment_gate_decision_run_action_uk -- an earlier version of this
 * comment claimed it was unmerged, which was also stale). This still uses a
 * plain SELECT-then-INSERT rather than ON CONFLICT; both are correct inside
 * the caller's single transaction, and switching to ON CONFLICT is a pure
 * style change outside this item's scope.
 */
export async function generateHoldDecision(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<HoldDecisionResult> {
  const input = schema.parse(untrusted);

  if (!input.holdThenApprove) {
    return { decisionId: null, created: false };
  }

  const run = await client.query<{ invoice_id: string }>(
    `SELECT invoice_id FROM audit_run WHERE client_id = $1 AND id = $2 AND outcome = 'SCORED'`,
    [input.clientId, input.auditRunId],
  );
  if (!run.rowCount) throw new GenerateHoldDecisionError('AUDIT_RUN_NOT_SCORED');
  const invoiceId = run.rows[0]!.invoice_id;

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM payment_gate_decision WHERE client_id = $1 AND audit_run_id = $2 AND action = 'hold'`,
    [input.clientId, input.auditRunId],
  );
  if (existing.rows[0]) {
    return { decisionId: existing.rows[0].id, created: false };
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO payment_gate_decision (client_id, invoice_id, audit_run_id, action, actor_kind, rationale)
     VALUES ($1,$2,$3,'hold','system',$4) RETURNING id`,
    [input.clientId, invoiceId, input.auditRunId, 'Held by default pending analyst payment authorization (hold-then-approve).'],
  );
  const decisionId = inserted.rows[0]!.id;

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.auditRunId, 'hold-decision'),
    clientId: input.clientId,
    entity: 'payment_gate_decision',
    entityId: decisionId,
    event: 'hold_generated',
    actorKind: 'system',
    detail: { auditRunId: input.auditRunId },
  });

  return { decisionId, created: true };
}
