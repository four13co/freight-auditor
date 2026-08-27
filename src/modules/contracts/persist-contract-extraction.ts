import type pg from 'pg';
import { z } from 'zod';
import { ContractExtractionSchema, ExtractedContractValueSchema, type ContractExtraction } from './contract-extraction-schema.js';
import { contractExtractionIdempotencyKey } from './validate-contract-extraction-response.js';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const postgresUuid = z.string().uuid();
const inputSchema = z.object({
  clientId: postgresUuid, sourceDocumentId: postgresUuid, actorUserId: postgresUuid.nullable(),
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/), extraction: ContractExtractionSchema,
}).strict();

export class ContractExtractionPersistenceError extends Error {
  constructor(readonly code: 'SOURCE_NOT_FOUND' | 'SOURCE_HASH_MISMATCH' | 'IDEMPOTENCY_KEY_MISMATCH' | 'PARTIAL_CONFLICT') {
    super(code.toLocaleLowerCase('en-US').replace(/_/g, ' ')); this.name = 'ContractExtractionPersistenceError';
  }
}

type ExtractedValue = z.infer<typeof ExtractedContractValueSchema>;
interface PersistenceRow {
  fieldPath: string; value: ExtractedValue;
}

export async function persistContractExtraction(
  client: pg.PoolClient,
  untrustedInput: { clientId: string; sourceDocumentId: string; actorUserId: string | null;
    idempotencyKey: string; extraction: ContractExtraction },
): Promise<{ responseHash: string; fieldCount: number; created: boolean }> {
  const input = inputSchema.parse(untrustedInput);
  const expectedKey = contractExtractionIdempotencyKey(input.extraction);
  if (input.idempotencyKey !== expectedKey) throw new ContractExtractionPersistenceError('IDEMPOTENCY_KEY_MISMATCH');

  const source = (await client.query<{ sha256: string }>(
    `SELECT sha256 FROM source_document WHERE id=$1 AND client_id=$2`, [input.sourceDocumentId, input.clientId],
  )).rows[0];
  if (!source) throw new ContractExtractionPersistenceError('SOURCE_NOT_FOUND');
  if (source.sha256 !== input.extraction.sourceDocumentSha256) throw new ContractExtractionPersistenceError('SOURCE_HASH_MISMATCH');

  const rows = flattenExtraction(input.extraction);
  let insertedCount = 0;
  let storedCount = 0;
  if (rows.length) {
    const result = await client.query<{ inserted_count: string; stored_count: string }>(
      `WITH payload AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS value(
           field_path text, ai_value jsonb, confidence numeric, page_ref text, bbox jsonb,
           extraction_status text, citations jsonb
         )
       ), inserted AS (
         INSERT INTO extraction_field
           (client_id, source_document_id, field_path, ai_value, confidence, page_ref, bbox,
            model_version, prompt_version, extraction_response_hash, extraction_schema_version,
            extraction_status, citations)
         SELECT $2, $3, field_path, ai_value, confidence, page_ref, bbox,
           $4, $5, $6, $7, extraction_status, citations FROM payload
         ON CONFLICT (client_id, source_document_id, extraction_response_hash, field_path)
           WHERE extraction_response_hash IS NOT NULL DO NOTHING RETURNING id
       )
       SELECT (SELECT count(*) FROM inserted)::text inserted_count,
         ((SELECT count(*) FROM inserted) +
          (SELECT count(*) FROM extraction_field WHERE client_id=$2 AND source_document_id=$3
            AND extraction_response_hash=$6))::text stored_count`,
      [JSON.stringify(rows.map(toDatabaseRow)), input.clientId, input.sourceDocumentId,
        input.extraction.model.modelId, input.extraction.model.promptVersion, expectedKey, input.extraction.schemaVersion],
    );
    insertedCount = Number(result.rows[0]!.inserted_count);
    storedCount = Number(result.rows[0]!.stored_count);
    if (storedCount !== rows.length || (insertedCount !== 0 && insertedCount !== rows.length)) {
      throw new ContractExtractionPersistenceError('PARTIAL_CONFLICT');
    }
  }

  const audit = await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.sourceDocumentId, expectedKey, 'contract_extraction.persisted'),
    clientId: input.clientId, entity: 'contract_extraction', entityId: input.sourceDocumentId,
    event: 'persisted', actorKind: input.actorUserId ? 'analyst' : 'ai', actorUserId: input.actorUserId,
    detail: { responseHash: expectedKey, schemaVersion: input.extraction.schemaVersion,
      modelId: input.extraction.model.modelId, promptVersion: input.extraction.model.promptVersion, fieldCount: rows.length },
  });
  return { responseHash: expectedKey, fieldCount: rows.length, created: audit.created };
}

function flattenExtraction(extraction: ContractExtraction): PersistenceRow[] {
  const rows: PersistenceRow[] = extraction.fields.map((field) => ({ fieldPath: field.path, value: field.value }));
  for (const clause of extraction.clauses) rows.push({ fieldPath: `clauses[${JSON.stringify(clause.clauseReference)}].text`, value: clause.text });
  for (const table of extraction.rateTables) {
    const base = `rateTables[${JSON.stringify(table.tableKey)}]`;
    rows.push({ fieldPath: `${base}.title`, value: table.title });
    for (const cell of table.cells) rows.push({ fieldPath: `${base}.cells[${cell.rowIndex},${cell.columnIndex}]`, value: cell.value });
  }
  return rows.sort((left, right) => left.fieldPath.localeCompare(right.fieldPath));
}

function toDatabaseRow(row: PersistenceRow) {
  const pages = [...new Set(row.value.citations.map((citation) => citation.pageNumber))].sort((left, right) => left - right);
  return {
    field_path: row.fieldPath,
    ai_value: { status: row.value.status, rawText: row.value.rawText, normalizedValue: row.value.normalizedValue,
      ...('clarificationQuestion' in row.value ? { clarificationQuestion: row.value.clarificationQuestion } : {}) },
    confidence: row.value.confidence,
    page_ref: pages.length ? pages.join(',') : null,
    bbox: row.value.citations.map((citation) => ({ pageNumber: citation.pageNumber, boundingBox: citation.boundingBox ?? null })),
    extraction_status: row.value.status,
    citations: row.value.citations,
  };
}
