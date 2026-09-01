import { createHash } from 'node:crypto';
import type pg from 'pg';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import {
  ExtractionFieldCorrectionConflictError,
  ExtractionFieldCorrectionInputSchema,
  ExtractionFieldNotFoundError,
  type ExtractionFieldCorrectionInput,
} from './extraction-field-correction-schema.js';

interface OriginalField {
  id: string; source_document_id: string; field_path: string; ai_value: unknown; confidence: string;
  page_ref: string | null; bbox: unknown; model_version: string; prompt_version: string;
  extraction_response_hash: string; extraction_schema_version: string; extraction_status: string; citations: unknown;
}

export async function persistExtractionFieldCorrection(
  client: pg.PoolClient,
  input: { clientId: string; fieldId: string; actorUserId: string; correction: ExtractionFieldCorrectionInput },
): Promise<{ id: string; correctionHash: string; created: boolean }> {
  const correction = ExtractionFieldCorrectionInputSchema.parse(input.correction);
  const original = (await client.query<OriginalField>(`SELECT id,source_document_id,field_path,ai_value,confidence,page_ref,bbox,
      model_version,prompt_version,extraction_response_hash,extraction_schema_version,extraction_status,citations
    FROM extraction_field WHERE id=$1 AND client_id=$2 AND extraction_response_hash IS NOT NULL AND correction_hash IS NULL`,
    [input.fieldId, input.clientId])).rows[0];
  if (!original) throw new ExtractionFieldNotFoundError();
  const correctionHash = createHash('sha256').update(stableStringify({
    fieldId: original.id, humanValue: correction.human_value, answerSource: correction.answer_source,
  })).digest('hex');

  const inserted = await client.query<{ id: string }>(`INSERT INTO extraction_field
    (client_id,source_document_id,field_path,ai_value,human_value,confidence,page_ref,bbox,model_version,prompt_version,
     extraction_response_hash,extraction_schema_version,extraction_status,citations,correction_hash,correction_source,corrected_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::answer_source,$17)
    ON CONFLICT (client_id,source_document_id,extraction_response_hash,field_path,correction_hash)
      WHERE correction_hash IS NOT NULL DO NOTHING RETURNING id`,
  [input.clientId, original.source_document_id, original.field_path, original.ai_value, JSON.stringify(correction.human_value),
    original.confidence, original.page_ref, JSON.stringify(original.bbox), original.model_version, original.prompt_version,
    original.extraction_response_hash, original.extraction_schema_version, original.extraction_status, JSON.stringify(original.citations),
    correctionHash, correction.answer_source, input.actorUserId]);
  let id = inserted.rows[0]?.id;
  const created = Boolean(id);
  if (!id) id = (await client.query<{ id: string }>(`SELECT id FROM extraction_field WHERE client_id=$1
      AND source_document_id=$2 AND extraction_response_hash=$3 AND field_path=$4 AND correction_hash=$5
      AND ai_value IS NOT DISTINCT FROM $6::jsonb AND human_value IS NOT DISTINCT FROM $7::jsonb
      AND correction_source=$8::answer_source AND corrected_by=$9`,
    [input.clientId, original.source_document_id, original.extraction_response_hash, original.field_path, correctionHash,
      original.ai_value, JSON.stringify(correction.human_value), correction.answer_source, input.actorUserId])).rows[0]?.id;
  if (!id) throw new ExtractionFieldCorrectionConflictError();

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, original.id, correctionHash, 'extraction_field.corrected'),
    clientId: input.clientId, entity: 'extraction_field', entityId: id, event: 'corrected',
    actorKind: 'analyst', actorUserId: input.actorUserId,
    detail: { originalFieldId: original.id, sourceDocumentId: original.source_document_id,
      fieldPath: original.field_path, correctionHash, answerSource: correction.answer_source },
  });
  return { id, correctionHash, created };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
