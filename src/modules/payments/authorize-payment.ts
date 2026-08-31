import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import type { PaymentAuthorizationAction } from './payment-authorization-action.js';

const schema = z.object({
  clientId: z.uuid(),
  auditRunId: z.uuid(),
  action: z.enum(['approve', 'hold']),
  rationale: z.string().trim().min(1).max(2_000).optional(),
  actorUserId: z.uuid(),
}).strict();

export class AuthorizePaymentError extends Error {
  constructor(readonly code: 'AUDIT_RUN_NOT_FOUND') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'AuthorizePaymentError';
  }
}

export interface AuthorizePaymentResult {
  decisionId: string;
  action: PaymentAuthorizationAction;
  created: boolean;
}

/**
 * Record an analyst-authored payment authorization (approve or hold) for an
 * audit run (P4.B.5). actorUserId is REQUIRED (not optional) and always
 * written as actor_kind: 'analyst' -- this is the one write path in the
 * payment_gate_decision table that must never be reachable without a real,
 * authenticated human, which is what "no automatic payment approval"
 * (this task's own Exclusions line) means in code.
 *
 * Idempotent via SELECT-then-INSERT inside the caller's transaction (a
 * correct guarantee against concurrent writes within one request; #163
 * (open, unmerged) adds a UNIQUE (client_id, audit_run_id, action)
 * constraint on payment_gate_decision that would make this airtight across
 * transactions too -- deliberately not duplicated here to avoid two
 * migrations racing to create the same constraint name).
 */
export async function authorizePayment(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<AuthorizePaymentResult> {
  const input = schema.parse(untrusted);

  const run = await client.query<{ invoice_id: string }>(
    `SELECT invoice_id FROM audit_run WHERE client_id = $1 AND id = $2`,
    [input.clientId, input.auditRunId],
  );
  if (!run.rowCount) throw new AuthorizePaymentError('AUDIT_RUN_NOT_FOUND');
  const invoiceId = run.rows[0]!.invoice_id;

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM payment_gate_decision WHERE client_id = $1 AND audit_run_id = $2 AND action = $3`,
    [input.clientId, input.auditRunId, input.action],
  );
  if (existing.rows[0]) {
    return { decisionId: existing.rows[0].id, action: input.action, created: false };
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO payment_gate_decision (client_id, invoice_id, audit_run_id, action, actor_kind, rationale)
     VALUES ($1,$2,$3,$4,'analyst',$5) RETURNING id`,
    [input.clientId, invoiceId, input.auditRunId, input.action, input.rationale ?? null],
  );
  const decisionId = inserted.rows[0]!.id;

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, decisionId, 'payment-authorization'),
    clientId: input.clientId,
    entity: 'payment_gate_decision',
    entityId: decisionId,
    event: 'payment_authorized',
    actorKind: 'analyst',
    actorUserId: input.actorUserId,
    detail: { auditRunId: input.auditRunId, action: input.action, rationale: input.rationale ?? null },
  });

  return { decisionId, action: input.action, created: true };
}
