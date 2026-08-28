import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const schema = z.object({ clientId: z.uuid(), auditRunId: z.uuid() }).strict();

export class DiscoveryTriggerError extends Error {
  constructor(readonly code: 'AUDIT_RUN_NOT_FOUND' | 'TRIGGER_CONFLICT') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'DiscoveryTriggerError';
  }
}

interface Marker { id: string; charge_index: number; marker_code: string; missing_fields: string[] }

/**
 * Converts this audit_run's coverage_marker rows (0019: a charge that passed
 * despite missing fields the rubric needed -- "suspicious-pass" evidence) into
 * discovery_trigger rows. coverage_marker is already tenant-scoped,
 * append-only, and unique per (audit_run, charge_index, marker_code), so this
 * boundary adds no new detection logic -- it republishes existing evidence
 * into the shared discovery surface. Idempotent: UNIQUE(client_id,
 * coverage_marker_id) from 0045.
 */
export async function detectSuspiciousPassTriggers(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<{ triggerIds: string[]; createdCount: number }> {
  const input = schema.parse(untrusted);
  const run = await client.query(
    `SELECT 1 FROM audit_run WHERE client_id = $1 AND id = $2`,
    [input.clientId, input.auditRunId],
  );
  if (!run.rowCount) throw new DiscoveryTriggerError('AUDIT_RUN_NOT_FOUND');

  const { rows } = await client.query<Marker>(
    `SELECT id, charge_index, marker_code, missing_fields FROM coverage_marker
      WHERE client_id = $1 AND audit_run_id = $2
      ORDER BY charge_index, marker_code`,
    [input.clientId, input.auditRunId],
  );

  const ids: string[] = [];
  let createdCount = 0;
  for (const row of rows) {
    const detail = { chargeIndex: row.charge_index, markerCode: row.marker_code, missingFields: row.missing_fields };
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO discovery_trigger
         (client_id, trigger_type, source_kind, audit_run_id, coverage_marker_id, detail)
       VALUES ($1,'SUSPICIOUS_PASS_MISSING_DATA','COVERAGE_MARKER',$2,$3,$4::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
      [input.clientId, input.auditRunId, row.id, JSON.stringify(detail)],
    );
    let id = inserted.rows[0]?.id;
    if (id) createdCount++;
    if (!id) {
      id = (
        await client.query<{ id: string }>(
          `SELECT id FROM discovery_trigger WHERE client_id = $1 AND coverage_marker_id = $2`,
          [input.clientId, row.id],
        )
      ).rows[0]?.id;
    }
    if (!id) throw new DiscoveryTriggerError('TRIGGER_CONFLICT');
    ids.push(id);
  }

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.auditRunId, 'suspicious-pass-discovery'),
    clientId: input.clientId,
    entity: 'discovery_trigger',
    entityId: input.auditRunId,
    event: 'suspicious_pass_detected',
    actorKind: 'system',
    detail: { triggerIds: ids, triggerCount: ids.length },
  });
  return { triggerIds: ids, createdCount };
}
