import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import {
  composeShortPayDecision,
  type ChargeFactRow,
  type AcceptedOverchargeFindingRow,
} from './compose-short-pay-decision.js';

const schema = z.object({
  clientId: z.uuid(),
  auditRunId: z.uuid(),
  shortPayEnabled: z.boolean().default(false),
}).strict();

export { ShortPayDecisionError } from './compose-short-pay-decision.js';

export class GenerateShortPayError extends Error {
  constructor(readonly code: 'AUDIT_RUN_NOT_SCORED') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'GenerateShortPayError';
  }
}

export interface ShortPayDecisionResult {
  decisionId: string | null;
  amountToPay: string | null;
  currency: string | null;
  findingIds: string[];
  created: boolean;
}

/**
 * Generate a 'short_pay' payment_gate_decision for a SCORED audit run
 * (P4.B.3): pays the invoice total minus accepted OVERCHARGE variance (see
 * compose-short-pay-decision.ts). Opt-in per Master Spec §10 -- short-pay
 * is NOT the platform default (that's hold-then-approve, P4.B.2/#167), so
 * shortPayEnabled defaults to false and this generates no decision at all
 * unless the caller explicitly opts a client in.
 *
 * shortPayEnabled is accepted as a PARAMETER, not read internally by this
 * function -- same treatment as generate-hold-decision.ts's holdThenApprove,
 * just defaulting the other direction (§10: short-pay is opt-in,
 * hold-then-approve is the default). (86e367r9x: client_payment_policy,
 * migration 0058, is applied and readable -- an earlier version of this
 * comment claimed it was unmerged/absent, which was stale.)
 *
 * Deliberately NOT auto-wired into persist.ts alongside generateHoldDecision
 * (86e367r9x): its precondition -- accepted OVERCHARGE findings -- can never
 * be true at initial audit-run persist time (variance_finding rows are
 * always freshly 'open' there), so calling it there would lock in a
 * short-pay decision computed against zero accepted disputes. Recomputing
 * short-pay once findings are later accepted/disputed is a separate,
 * not-yet-built trigger point.
 *
 * Idempotent per (client, audit_run, 'short_pay'): payment_gate_decision
 * does have a unique constraint on (client_id, audit_run_id, action)
 * (migration 0052's payment_gate_decision_run_action_uk -- an earlier
 * version of this comment claimed it was unmerged, which was also stale).
 * This still uses a plain SELECT-then-INSERT rather than ON CONFLICT; both
 * are correct inside the caller's single transaction. Writes its own
 * 'short_pay' row and never touches any existing 'hold' row for the same
 * run -- which decision supersedes which is lifecycle sequencing outside
 * this item's boundary.
 */
export async function generateShortPayDecision(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<ShortPayDecisionResult> {
  const input = schema.parse(untrusted);

  if (!input.shortPayEnabled) {
    return { decisionId: null, amountToPay: null, currency: null, findingIds: [], created: false };
  }

  const run = await client.query<{ invoice_id: string }>(
    `SELECT invoice_id FROM audit_run WHERE client_id = $1 AND id = $2 AND outcome = 'SCORED'`,
    [input.clientId, input.auditRunId],
  );
  if (!run.rowCount) throw new GenerateShortPayError('AUDIT_RUN_NOT_SCORED');
  const invoiceId = run.rows[0]!.invoice_id;

  const existing = await client.query<{ id: string; amount: string; currency: string | null }>(
    `SELECT id, amount, currency FROM payment_gate_decision WHERE client_id = $1 AND audit_run_id = $2 AND action = 'short_pay'`,
    [input.clientId, input.auditRunId],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return { decisionId: row.id, amountToPay: row.amount, currency: row.currency, findingIds: [], created: false };
  }

  const { rows: chargeFacts } = await client.query<ChargeFactRow>(
    `SELECT amount, currency FROM charge_fact WHERE client_id = $1 AND invoice_id = $2`,
    [input.clientId, invoiceId],
  );
  const { rows: findings } = await client.query<AcceptedOverchargeFindingRow>(
    `SELECT id, currency, variance_amount AS "varianceAmount"
       FROM variance_finding
      WHERE client_id = $1 AND audit_run_id = $2 AND direction = 'OVERCHARGE' AND status = 'accepted'`,
    [input.clientId, input.auditRunId],
  );

  const decision = composeShortPayDecision(chargeFacts, findings);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO payment_gate_decision (client_id, invoice_id, audit_run_id, action, amount, currency, actor_kind, rationale)
     VALUES ($1,$2,$3,'short_pay',$4,$5,'system',$6) RETURNING id`,
    [
      input.clientId,
      invoiceId,
      input.auditRunId,
      decision.amountToPay,
      decision.currency,
      `Short-paid: withheld ${decision.withheldAmount} ${decision.currency} for accepted overcharge findings.`,
    ],
  );
  const decisionId = inserted.rows[0]!.id;

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.auditRunId, 'short-pay-decision'),
    clientId: input.clientId,
    entity: 'payment_gate_decision',
    entityId: decisionId,
    event: 'short_pay_generated',
    actorKind: 'system',
    detail: {
      auditRunId: input.auditRunId,
      amountToPay: decision.amountToPay,
      withheldAmount: decision.withheldAmount,
      findingIds: decision.findingIds,
    },
  });

  return {
    decisionId,
    amountToPay: decision.amountToPay,
    currency: decision.currency,
    findingIds: decision.findingIds,
    created: true,
  };
}
