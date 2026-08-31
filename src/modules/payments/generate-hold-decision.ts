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
 * than read from client_payment_policy (P4.B.1/#161, still unmerged, and
 * that table does not exist on this branch's Development base) -- the
 * caller resolves the client's policy (or accepts the true default) and
 * passes it in. Once #161 merges, the caller reads client_payment_policy
 * and passes hold_then_approve through; this function's contract does not
 * change. holdThenApprove: false means the client has opted out of the
 * default hold, so this generates no decision at all (short-pay/opt-out
 * enforcement for that path is P4.B.3's boundary, not this one's).
 *
 * Idempotent per (client, audit_run, 'hold'): payment_gate_decision has no
 * unique constraint on Development yet (#195's payment_gate_decision_run_
 * action_uk is unmerged), so this is a plain SELECT-then-INSERT inside the
 * caller's transaction rather than an ON CONFLICT reference to a constraint
 * that doesn't exist on this base. Once #195 merges, this can tighten to
 * ON CONFLICT; not done here to avoid a merge-order coupling this item
 * doesn't otherwise have.
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
