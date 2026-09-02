import type pg from 'pg';
import { z } from 'zod';
import { writeAuditEvent, deterministicAuditEventId } from '../audit-ledger/write-audit-event.js';
import { normalizeSystemCode } from './export-adapter.js';
import type { ExportRecord, ExportResult } from './export-adapter.js';

const originSchema = z.object({
  clientId: z.uuid(),
  claimId: z.uuid().nullable().default(null),
  paymentGateDecisionId: z.uuid().nullable().default(null),
}).strict();

/** The only two ExportResult variants this module persists -- NOT_CONFIGURED means no adapter ran, so there is nothing to reconcile. */
export type SettledExportResult = Exclude<ExportResult, { status: 'NOT_CONFIGURED' }>;

export class RecordExportAcknowledgementError extends Error {
  constructor(readonly code: 'MISSING_ORIGIN' | 'CLAIM_NOT_FOUND' | 'PAYMENT_GATE_DECISION_NOT_FOUND') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'RecordExportAcknowledgementError';
  }
}

export interface RecordExportAcknowledgementInput {
  clientId: string;
  claimId?: string | null;
  paymentGateDecisionId?: string | null;
  record: Pick<ExportRecord, 'systemCode' | 'dedupeKey'>;
  result: SettledExportResult;
}

export interface RecordExportAcknowledgementResult {
  id: string;
  created: boolean;
}

/**
 * Persist the outcome of one P4.B.8 ExportAdapter attempt (86e2zfhev, P4.B.9).
 * export_acknowledgement (0075) is append-only, so a FAILED attempt always
 * inserts a fresh row (a retry that fails again is a distinct, legitimate
 * attempt -- same reasoning recordPartialRecovery uses for recovery_event).
 * An ACKNOWLEDGED attempt is idempotent on (clientId, systemCode, dedupeKey):
 * a duplicate ACK for an export already recorded returns the existing row
 * instead of inserting a second one, backed by 0075's partial unique index.
 */
export async function recordExportAcknowledgement(
  client: pg.PoolClient,
  untrusted: RecordExportAcknowledgementInput,
): Promise<RecordExportAcknowledgementResult> {
  const origin = originSchema.parse({
    clientId: untrusted.clientId,
    claimId: untrusted.claimId ?? null,
    paymentGateDecisionId: untrusted.paymentGateDecisionId ?? null,
  });
  if (!origin.claimId && !origin.paymentGateDecisionId) {
    throw new RecordExportAcknowledgementError('MISSING_ORIGIN');
  }

  // Confirm the origin record actually belongs to this tenant before
  // linking it -- an FK reference alone doesn't enforce tenant ownership
  // (the referenced row merely has to exist), same gap recordPartialRecovery
  // closes for claim_id via an explicit client_id-scoped lookup.
  if (origin.claimId) {
    const { rows } = await client.query(`SELECT 1 FROM claim WHERE client_id = $1 AND id = $2`, [origin.clientId, origin.claimId]);
    if (rows.length === 0) throw new RecordExportAcknowledgementError('CLAIM_NOT_FOUND');
  }
  if (origin.paymentGateDecisionId) {
    const { rows } = await client.query(
      `SELECT 1 FROM payment_gate_decision WHERE client_id = $1 AND id = $2`,
      [origin.clientId, origin.paymentGateDecisionId],
    );
    if (rows.length === 0) throw new RecordExportAcknowledgementError('PAYMENT_GATE_DECISION_NOT_FOUND');
  }

  const systemCode = normalizeSystemCode(untrusted.record.systemCode);
  const dedupeKey = untrusted.record.dedupeKey;
  const result = untrusted.result;

  const { rows } = result.status === 'ACKNOWLEDGED'
    ? await client.query<{ id: string; created: boolean }>(
      `WITH inserted AS (
         INSERT INTO export_acknowledgement
           (client_id, claim_id, payment_gate_decision_id, system_code, adapter_version, dedupe_key, status, external_reference)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACKNOWLEDGED', $7)
         ON CONFLICT (client_id, system_code, dedupe_key) WHERE status = 'ACKNOWLEDGED' DO NOTHING
         RETURNING id
       )
       SELECT id, true AS created FROM inserted
       UNION ALL
       SELECT id, false AS created FROM export_acknowledgement
       WHERE client_id = $1 AND system_code = $4 AND dedupe_key = $6 AND status = 'ACKNOWLEDGED'
         AND NOT EXISTS (SELECT 1 FROM inserted)`,
      [origin.clientId, origin.claimId, origin.paymentGateDecisionId, systemCode, result.adapterVersion, dedupeKey, result.externalReference],
    )
    : await client.query<{ id: string; created: boolean }>(
      `INSERT INTO export_acknowledgement
         (client_id, claim_id, payment_gate_decision_id, system_code, adapter_version, dedupe_key, status, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'FAILED', $7)
       RETURNING id, true AS created`,
      [origin.clientId, origin.claimId, origin.paymentGateDecisionId, systemCode, result.adapterVersion, dedupeKey, result.reason],
    );

  const row = rows[0]!;

  if (row.created) {
    await writeAuditEvent(client, {
      id: deterministicAuditEventId(origin.clientId, row.id, 'export-acknowledgement.recorded'),
      clientId: origin.clientId,
      entity: 'export_acknowledgement',
      entityId: row.id,
      event: 'export_acknowledgement.recorded',
      actorKind: 'system',
      detail: {
        claimId: origin.claimId,
        paymentGateDecisionId: origin.paymentGateDecisionId,
        systemCode,
        status: result.status,
      },
    });
  }

  return { id: row.id, created: row.created };
}
