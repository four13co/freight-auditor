import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const schema = z.object({ clientId: z.uuid(), auditRunId: z.uuid() }).strict();

export class SuspiciousPassTriggerError extends Error {
  constructor(readonly code: 'AUDIT_RUN_NOT_FOUND' | 'TRIGGER_CONFLICT') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'SuspiciousPassTriggerError';
  }
}

interface Source {
  id: string;
  charge_index: number;
  marker_code: string;
  missing_fields: string[];
}

/**
 * P3.D.4: surfaces coverage_marker (0019) rows -- "suspicious-pass" gaps on
 * charges that otherwise passed structural validation, plus "missing-data"
 * gaps -- as discovery triggers. Mirrors
 * detect-unknown-charge-code-triggers.ts's shape (P3.D.2): idempotent insert
 * into a dedicated table (suspicious_pass_trigger, 0054), one summary audit
 * event. coverage_marker.audit_run_id is already scoped to this run, so no
 * invoice-id join is needed (unlike the charge_fact-scoped detector).
 */
export async function detectSuspiciousPassTriggers(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<{ triggerIds: string[]; createdCount: number }> {
  const input = schema.parse(untrusted);

  const run = await client.query(`SELECT 1 FROM audit_run WHERE client_id = $1 AND id = $2`, [input.clientId, input.auditRunId]);
  if (!run.rowCount) throw new SuspiciousPassTriggerError('AUDIT_RUN_NOT_FOUND');

  const rows = (await client.query<Source>(
    `SELECT id, charge_index, marker_code, missing_fields FROM coverage_marker
     WHERE client_id = $1 AND audit_run_id = $2 ORDER BY charge_index, marker_code`,
    [input.clientId, input.auditRunId],
  )).rows;

  const ids: string[] = [];
  let createdCount = 0;
  for (const row of rows) {
    const detail = { chargeIndex: row.charge_index, missingFields: row.missing_fields };
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO suspicious_pass_trigger (client_id, audit_run_id, coverage_marker_id, marker_code, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
      [input.clientId, input.auditRunId, row.id, row.marker_code, JSON.stringify(detail)],
    );
    let id = inserted.rows[0]?.id;
    if (id) createdCount++;
    if (!id) {
      id = (await client.query<{ id: string }>(
        `SELECT id FROM suspicious_pass_trigger WHERE client_id = $1 AND coverage_marker_id = $2`,
        [input.clientId, row.id],
      )).rows[0]?.id;
    }
    if (!id) throw new SuspiciousPassTriggerError('TRIGGER_CONFLICT');
    ids.push(id);
  }

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.auditRunId, 'suspicious-pass-discovery'),
    clientId: input.clientId,
    entity: 'suspicious_pass_trigger',
    entityId: input.auditRunId,
    event: 'suspicious_pass_detected',
    actorKind: 'system',
    detail: { triggerIds: ids, triggerCount: ids.length },
  });

  return { triggerIds: ids, createdCount };
}
