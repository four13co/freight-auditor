import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const schema = z.object({ clientId: z.uuid(), sourceDocumentId: z.uuid() }).strict();

/** Below this, an AI-supplied value is treated as not yet trustworthy. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export class DiscoveryTriggerError extends Error {
  constructor(readonly code: 'SOURCE_DOCUMENT_NOT_FOUND' | 'TRIGGER_CONFLICT') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'DiscoveryTriggerError';
  }
}

interface Field { id: string; field_path: string; confidence: string | null; ai_value: unknown }

/**
 * Detects two independent extraction-quality signals on extraction_field
 * rows belonging to one source_document, neither of which has an audit_run
 * (extraction runs before/independent of any audit_run):
 *
 *   LOW_CONFIDENCE     -- the model answered, but below LOW_CONFIDENCE_THRESHOLD,
 *                         and no human_value has resolved it yet.
 *   STRUCTURAL_ANOMALY -- the model produced no value at all (ai_value IS NULL):
 *                         a structural gap distinct from an unsure answer.
 *
 * Idempotent per (client, extraction_field, trigger_type) -- 0045's
 * UNIQUE(client_id, extraction_field_id, trigger_type).
 */
export async function detectExtractionQualityTriggers(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<{ triggerIds: string[]; createdCount: number }> {
  const input = schema.parse(untrusted);
  const doc = await client.query(
    `SELECT 1 FROM source_document WHERE id = $1 AND (client_id = $2 OR client_id IS NULL)`,
    [input.sourceDocumentId, input.clientId],
  );
  if (!doc.rowCount) throw new DiscoveryTriggerError('SOURCE_DOCUMENT_NOT_FOUND');

  const { rows } = await client.query<Field>(
    `SELECT id, field_path, confidence, ai_value FROM extraction_field
      WHERE client_id = $1 AND source_document_id = $2
        AND (
          (ai_value IS NULL)
          OR (human_value IS NULL AND confidence IS NOT NULL AND confidence < $3)
        )
      ORDER BY id`,
    [input.clientId, input.sourceDocumentId, LOW_CONFIDENCE_THRESHOLD],
  );

  const ids: string[] = [];
  let createdCount = 0;
  for (const row of rows) {
    const triggerType = row.ai_value === null ? 'STRUCTURAL_ANOMALY' : 'LOW_CONFIDENCE';
    const detail = { fieldPath: row.field_path, confidence: row.confidence };
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO discovery_trigger
         (client_id, trigger_type, source_kind, extraction_field_id, source_document_id, detail)
       VALUES ($1,$2,'EXTRACTION_FIELD',$3,$4,$5::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
      [input.clientId, triggerType, row.id, input.sourceDocumentId, JSON.stringify(detail)],
    );
    let id = inserted.rows[0]?.id;
    if (id) createdCount++;
    if (!id) {
      id = (
        await client.query<{ id: string }>(
          `SELECT id FROM discovery_trigger
            WHERE client_id = $1 AND extraction_field_id = $2 AND trigger_type = $3`,
          [input.clientId, row.id, triggerType],
        )
      ).rows[0]?.id;
    }
    if (!id) throw new DiscoveryTriggerError('TRIGGER_CONFLICT');
    ids.push(id);
  }

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.sourceDocumentId, 'extraction-quality-discovery'),
    clientId: input.clientId,
    entity: 'discovery_trigger',
    entityId: input.sourceDocumentId,
    event: 'extraction_quality_detected',
    actorKind: 'system',
    detail: { triggerIds: ids, triggerCount: ids.length },
  });
  return { triggerIds: ids, createdCount };
}
