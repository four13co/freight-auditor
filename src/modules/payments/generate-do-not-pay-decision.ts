import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import { composeDoNotPayDecision, type GateFailureRow } from './compose-do-not-pay-decision.js';

const schema = z.object({ clientId: z.uuid(), auditRunId: z.uuid() }).strict();

export { DoNotPayDecisionError } from './compose-do-not-pay-decision.js';

export class GenerateDoNotPayError extends Error {
  constructor(readonly code: 'AUDIT_RUN_NOT_GATE_FAILED' | 'DECISION_CONFLICT') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'GenerateDoNotPayError';
  }
}

export interface DoNotPayDecisionResult {
  decisionId: string;
  rationale: string;
  gateFailureIds: string[];
}

/**
 * Generate a do-not-pay payment_gate_decision for an invoice whose audit run
 * failed the structural gate (P4.B.4). No amount is computed -- a gate
 * failure means the invoice never reached SCORED, and (per persist.ts's own
 * documented behavior) a currency-gate rejection alone writes zero
 * charge_fact rows, so there is no partial amount to withhold; this refuses
 * the whole invoice.
 *
 * Idempotent per (client, audit_run, action): payment_gate_decision is
 * append-only (INSERT+SELECT only), so a retry inserts nothing new and
 * returns the existing decision instead (0048's UNIQUE constraint).
 */
export async function generateDoNotPayDecision(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<DoNotPayDecisionResult> {
  const input = schema.parse(untrusted);

  const run = await client.query<{ invoice_id: string }>(
    `SELECT invoice_id FROM audit_run WHERE client_id = $1 AND id = $2 AND outcome = 'REJECTED_REWORK'`,
    [input.clientId, input.auditRunId],
  );
  if (!run.rowCount) throw new GenerateDoNotPayError('AUDIT_RUN_NOT_GATE_FAILED');
  const invoiceId = run.rows[0]!.invoice_id;

  const { rows: gateFailures } = await client.query<GateFailureRow>(
    `SELECT id, defect, citation FROM gate_failure WHERE client_id = $1 AND audit_run_id = $2`,
    [input.clientId, input.auditRunId],
  );
  const decision = composeDoNotPayDecision(gateFailures);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO payment_gate_decision (client_id, invoice_id, audit_run_id, action, actor_kind, rationale)
     VALUES ($1,$2,$3,'do_not_pay','system',$4)
     ON CONFLICT ON CONSTRAINT payment_gate_decision_run_action_uk DO NOTHING
     RETURNING id`,
    [input.clientId, invoiceId, input.auditRunId, decision.rationale],
  );
  let decisionId = inserted.rows[0]?.id;
  if (!decisionId) {
    decisionId = (
      await client.query<{ id: string }>(
        `SELECT id FROM payment_gate_decision WHERE client_id = $1 AND audit_run_id = $2 AND action = 'do_not_pay'`,
        [input.clientId, input.auditRunId],
      )
    ).rows[0]?.id;
  }
  if (!decisionId) throw new GenerateDoNotPayError('DECISION_CONFLICT');

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.auditRunId, 'do-not-pay-decision'),
    clientId: input.clientId,
    entity: 'payment_gate_decision',
    entityId: decisionId,
    event: 'do_not_pay_generated',
    actorKind: 'system',
    detail: { auditRunId: input.auditRunId, gateFailureIds: decision.gateFailureIds, rationale: decision.rationale },
  });

  return { decisionId, rationale: decision.rationale, gateFailureIds: decision.gateFailureIds };
}
