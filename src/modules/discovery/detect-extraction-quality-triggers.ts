import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const schema = z.object({ clientId: z.uuid(), sourceDocumentId: z.uuid(), lowConfidenceThreshold: z.number().finite().min(0).max(1).default(0.5) }).strict();

export class ExtractionQualityTriggerError extends Error {
  constructor(readonly code: 'SOURCE_NOT_FOUND' | 'TRIGGER_CONFLICT') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'ExtractionQualityTriggerError';
  }
}

type TriggerType = 'LOW_CONFIDENCE' | 'STRUCTURAL_ANOMALY';

interface Source {
  id: string;
  field_path: string;
  extraction_status: string;
  confidence: string;
}

/**
 * P3.D.3: classifies each contract-extraction field that has never been
 * human-corrected into LOW_CONFIDENCE (model answered, confidence below
 * threshold) or STRUCTURAL_ANOMALY (model could not resolve the field at
 * all -- NOT_FOUND/AMBIGUOUS). Mirrors detect-unknown-charge-code-triggers.ts
 * (P3.D.2): idempotent insert into a dedicated table
 * (extraction_quality_trigger, 0061), one summary audit event.
 *
 * "Corrected" is determined per (source_document_id, field_path): once any
 * row for that field carries a human_value, every row for that field is
 * excluded, matching persist-extraction-field-correction.ts's append-only
 * correction shape (a correction is a new row, not an update).
 */
export async function detectExtractionQualityTriggers(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<{ triggerIds: string[]; createdCount: number }> {
  const input = schema.parse(untrusted);

  const source = await client.query('SELECT 1 FROM source_document WHERE client_id = $1 AND id = $2', [input.clientId, input.sourceDocumentId]);
  if (!source.rowCount) throw new ExtractionQualityTriggerError('SOURCE_NOT_FOUND');

  const rows = (await client.query<Source>(
    `SELECT id, field_path, extraction_status, confidence FROM extraction_field
     WHERE client_id = $1 AND source_document_id = $2
       AND extraction_response_hash IS NOT NULL AND correction_hash IS NULL
       AND field_path NOT IN (
         SELECT field_path FROM extraction_field
         WHERE client_id = $1 AND source_document_id = $2 AND human_value IS NOT NULL
       )
     ORDER BY field_path`,
    [input.clientId, input.sourceDocumentId],
  )).rows;

  const ids: string[] = [];
  let createdCount = 0;
  for (const row of rows) {
    const confidence = Number(row.confidence);
    let triggerType: TriggerType | null = null;
    if (row.extraction_status === 'FOUND' && confidence < input.lowConfidenceThreshold) triggerType = 'LOW_CONFIDENCE';
    else if (row.extraction_status === 'NOT_FOUND' || row.extraction_status === 'AMBIGUOUS') triggerType = 'STRUCTURAL_ANOMALY';
    if (!triggerType) continue;

    const detail = { extractionStatus: row.extraction_status, confidence, fieldPath: row.field_path };
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO extraction_quality_trigger (client_id, source_document_id, extraction_field_id, trigger_type, field_path, confidence, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
      [input.clientId, input.sourceDocumentId, row.id, triggerType, row.field_path, confidence, JSON.stringify(detail)],
    );
    let id = inserted.rows[0]?.id;
    if (id) createdCount++;
    if (!id) {
      id = (await client.query<{ id: string }>(
        `SELECT id FROM extraction_quality_trigger WHERE client_id = $1 AND extraction_field_id = $2 AND trigger_type = $3`,
        [input.clientId, row.id, triggerType],
      )).rows[0]?.id;
    }
    if (!id) throw new ExtractionQualityTriggerError('TRIGGER_CONFLICT');
    ids.push(id);
  }

  // Unlike an audit_run (created once, evaluated once), a source_document can
  // legitimately be scanned multiple times as extraction batches land over
  // time -- so the id folds in the resulting trigger-id set: an unchanged
  // result set retries idempotently (same id, same detail), a genuinely
  // different one (new fields discovered) gets its own event instead of
  // colliding with a prior summary's immutable content.
  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.sourceDocumentId, 'extraction-quality-discovery', [...ids].sort().join(',')),
    clientId: input.clientId,
    entity: 'extraction_quality_trigger',
    entityId: input.sourceDocumentId,
    event: 'extraction_quality_detected',
    actorKind: 'system',
    detail: { triggerIds: ids, triggerCount: ids.length },
  });

  return { triggerIds: ids, createdCount };
}
