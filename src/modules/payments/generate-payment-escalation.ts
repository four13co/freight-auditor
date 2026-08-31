import type pg from 'pg';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const DEFAULT_GRACE_PERIOD_DAYS = 7;

export type GeneratePaymentEscalationErrorCode =
  | 'NO_HOLD_DECISION' | 'ALREADY_APPROVED' | 'GRACE_PERIOD_NOT_ELAPSED';

export class GeneratePaymentEscalationError extends Error {
  constructor(readonly code: GeneratePaymentEscalationErrorCode) {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'GeneratePaymentEscalationError';
  }
}

export interface GeneratePaymentEscalationResult {
  auditRunId: string;
  auditEventId: string;
  created: boolean;
}

interface HoldRow {
  recorded_at: Date;
}

/**
 * Records a payment_gate.escalated audit event for an audit run whose
 * default 'hold' decision (P4.B.2/#196) remains un-approved past a grace
 * period since the hold was recorded (P4.B.7, 86e2zfhbw).
 *
 * "Keep expired approvals held" is the load-bearing half of this item: this
 * function never mutates the hold row and never writes an 'approve' row --
 * payment_gate_decision is append-only-granted (SELECT+INSERT only,
 * migration 0010), so there is no UPDATE path available even if the design
 * wanted one. The hold stays exactly as-is; this only layers an audit-event
 * marker on top, the same way generateClaimEscalation (P5.B.3/#187) layers
 * claim.escalated on top of an unresolved claim without touching claim.status.
 * No new decision or automatic approval is ever created, matching this
 * item's own Exclusions line ("no automatic payment approval").
 *
 * Idempotent via writeAuditEvent's deterministic-id + internal ON CONFLICT
 * DO NOTHING, same pattern as generateClaimEscalation/generateClaimFollowUp.
 */
export async function generatePaymentEscalation(
  client: pg.PoolClient,
  clientId: string,
  auditRunId: string,
  now: Date = new Date(),
  gracePeriodDays: number = DEFAULT_GRACE_PERIOD_DAYS,
): Promise<GeneratePaymentEscalationResult> {
  const holdResult = await client.query<HoldRow>(
    `SELECT recorded_at FROM payment_gate_decision
     WHERE client_id = $1 AND audit_run_id = $2 AND action = 'hold'
     ORDER BY recorded_at DESC LIMIT 1`,
    [clientId, auditRunId],
  );
  const hold = holdResult.rows[0];
  if (!hold) throw new GeneratePaymentEscalationError('NO_HOLD_DECISION');

  const approveResult = await client.query(
    `SELECT 1 FROM payment_gate_decision WHERE client_id = $1 AND audit_run_id = $2 AND action = 'approve'`,
    [clientId, auditRunId],
  );
  if (approveResult.rowCount) throw new GeneratePaymentEscalationError('ALREADY_APPROVED');

  const graceDeadline = new Date(hold.recorded_at);
  graceDeadline.setUTCDate(graceDeadline.getUTCDate() + gracePeriodDays);
  if (graceDeadline.getTime() > now.getTime()) throw new GeneratePaymentEscalationError('GRACE_PERIOD_NOT_ELAPSED');

  const auditEventId = deterministicAuditEventId(clientId, auditRunId, 'payment_gate.escalated');
  const { created } = await writeAuditEvent(client, {
    id: auditEventId,
    clientId,
    entity: 'payment_gate_decision',
    entityId: auditRunId,
    event: 'payment_gate.escalated',
    actorKind: 'system',
    detail: { auditRunId, holdRecordedAt: hold.recorded_at.toISOString(), gracePeriodDays },
  });

  return { auditRunId, auditEventId, created };
}
