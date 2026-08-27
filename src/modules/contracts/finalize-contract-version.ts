import { createHash } from 'node:crypto';
import type pg from 'pg';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import { ContractVersionFinalizationError } from './finalize-contract-version-schema.js';

interface FieldRow {
  id: string; field_path: string; ai_value: unknown; human_value: unknown; correction_hash: string | null;
  confidence: string; page_ref: string | null; bbox: unknown; model_version: string; prompt_version: string;
  extraction_status: string; citations: unknown; recorded_at: string;
}

export async function finalizeContractVersion(
  client: pg.PoolClient,
  input: { clientId: string; contractVersionId: string; actorUserId: string; extractionResponseHash: string },
): Promise<{ id: string; verificationHash: string; fieldCount: number; created: boolean }> {
  const version = (await client.query<{ source_document_id: string }>(
    `SELECT source_document_id FROM contract_version WHERE id=$1 AND client_id=$2`, [input.contractVersionId, input.clientId],
  )).rows[0];
  if (!version?.source_document_id) throw new ContractVersionFinalizationError('CONTRACT_VERSION_NOT_FOUND');
  const extractionAudit = (await client.query(`SELECT 1 FROM audit_event WHERE client_id=$1 AND entity='contract_extraction'
      AND entity_id=$2 AND event='persisted' AND detail->>'responseHash'=$3 LIMIT 1`,
  [input.clientId, version.source_document_id, input.extractionResponseHash])).rowCount;
  if (!extractionAudit) throw new ContractVersionFinalizationError('EXTRACTION_NOT_FOUND');
  const fields = (await client.query<FieldRow>(`SELECT id,field_path,ai_value,human_value,correction_hash,confidence,page_ref,bbox,
      model_version,prompt_version,extraction_status,citations,recorded_at
    FROM extraction_field WHERE client_id=$1 AND source_document_id=$2 AND extraction_response_hash=$3
    ORDER BY field_path,recorded_at,id`, [input.clientId, version.source_document_id, input.extractionResponseHash])).rows;
  const originals = fields.filter((field) => field.correction_hash === null);
  if (!originals.length) throw new ContractVersionFinalizationError('EXTRACTION_NOT_FOUND');
  const unanswered = (await client.query(`SELECT 1 FROM clarifying_question WHERE client_id=$1 AND source_document_id=$2
      AND extraction_response_hash=$3 AND answer IS NULL LIMIT 1`,
  [input.clientId, version.source_document_id, input.extractionResponseHash])).rowCount;
  if (unanswered) throw new ContractVersionFinalizationError('UNANSWERED_CLARIFICATIONS');

  const resolved = originals.map((original) => {
    const correction = fields.filter((field) => field.field_path === original.field_path && field.correction_hash !== null).at(-1);
    return { fieldPath: original.field_path, originalFieldId: original.id, evidenceFieldId: correction?.id ?? original.id,
      aiValue: original.ai_value, humanValue: correction?.human_value ?? null,
      effectiveValue: correction?.human_value ?? original.ai_value, correctionHash: correction?.correction_hash ?? null,
      confidence: original.confidence, pageRef: original.page_ref, bbox: original.bbox, citations: original.citations,
      modelVersion: original.model_version, promptVersion: original.prompt_version, extractionStatus: original.extraction_status };
  });
  const canonical = stableStringify({ contractVersionId: input.contractVersionId, sourceDocumentId: version.source_document_id,
    extractionResponseHash: input.extractionResponseHash, resolvedFields: resolved });
  const verificationHash = createHash('sha256').update(canonical).digest('hex');
  const inserted = await client.query<{ id: string }>(`INSERT INTO verified_contract_version
      (client_id,contract_version_id,source_document_id,extraction_response_hash,verification_hash,resolved_fields,verified_by)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
    ON CONFLICT (client_id,contract_version_id,extraction_response_hash) DO NOTHING RETURNING id`,
  [input.clientId, input.contractVersionId, version.source_document_id, input.extractionResponseHash,
    verificationHash, JSON.stringify(resolved), input.actorUserId]);
  let id = inserted.rows[0]?.id;
  const created = Boolean(id);
  if (!id) id = (await client.query<{ id: string }>(`SELECT id FROM verified_contract_version WHERE client_id=$1
      AND contract_version_id=$2 AND extraction_response_hash=$3 AND verification_hash=$4
      AND resolved_fields IS NOT DISTINCT FROM $5::jsonb AND verified_by=$6`,
    [input.clientId, input.contractVersionId, input.extractionResponseHash, verificationHash,
      JSON.stringify(resolved), input.actorUserId])).rows[0]?.id;
  if (!id) throw new ContractVersionFinalizationError('FINALIZATION_CONFLICT');
  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.contractVersionId, verificationHash, 'contract_version.verified'),
    clientId: input.clientId, entity: 'contract_version', entityId: input.contractVersionId, event: 'verified',
    actorKind: 'analyst', actorUserId: input.actorUserId,
    detail: { verifiedContractVersionId: id, sourceDocumentId: version.source_document_id,
      extractionResponseHash: input.extractionResponseHash, verificationHash, fieldCount: resolved.length },
  });
  return { id, verificationHash, fieldCount: resolved.length, created };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
