import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { AzureAnalyzeResult } from './azure-document-intelligence.js';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue),
]));
const uuid = z.string().uuid();
const inputSchema = z.object({
  clientId: uuid,
  sourceDocumentId: uuid,
  actorUserId: uuid.nullable(),
  result: z.object({
    provider: z.literal('azure-document-intelligence'),
    apiVersion: z.string().min(1), modelId: z.string().min(1),
    operationLocation: z.string().url(), rawResponse: jsonValue,
  }).strict(),
}).strict();

export class RawDocumentAnalysisConflictError extends Error {
  constructor() { super('operation location is already bound to different immutable analysis evidence'); this.name = 'RawDocumentAnalysisConflictError'; }
}

export interface PersistRawDocumentAnalysisInput {
  clientId: string;
  sourceDocumentId: string;
  actorUserId: string | null;
  result: AzureAnalyzeResult;
}

export async function persistRawDocumentAnalysis(
  client: pg.PoolClient,
  untrustedInput: PersistRawDocumentAnalysisInput,
): Promise<{ id: string; responseHash: string; created: boolean }> {
  const input = inputSchema.parse(untrustedInput) as PersistRawDocumentAnalysisInput;
  const canonical = stableStringify(input.result.rawResponse);
  const responseHash = createHash('sha256').update(canonical).digest('hex');
  const result = await client.query<{ id: string; created: boolean }>(
    `WITH inserted AS (
       INSERT INTO raw_document_analysis
         (client_id, source_document_id, provider, api_version, model_id, operation_location, response_hash, raw_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (client_id, provider, operation_location) DO NOTHING RETURNING id
     )
     SELECT id, true created FROM inserted
     UNION ALL
     SELECT id, false created FROM raw_document_analysis
      WHERE client_id=$1 AND provider=$3 AND operation_location=$6
        AND source_document_id=$2 AND api_version=$4 AND model_id=$5
        AND response_hash=$7 AND raw_response=$8::jsonb
        AND NOT EXISTS (SELECT 1 FROM inserted)`,
    [input.clientId, input.sourceDocumentId, input.result.provider, input.result.apiVersion,
      input.result.modelId, input.result.operationLocation, responseHash, canonical],
  );
  const row = result.rows[0];
  if (!row) throw new RawDocumentAnalysisConflictError();
  if (row.created) {
    await writeAuditEvent(client, {
      id: deterministicAuditEventId(input.clientId, row.id, 'raw_document_analysis.recorded'),
      clientId: input.clientId, entity: 'raw_document_analysis', entityId: row.id,
      event: 'recorded', actorKind: input.actorUserId ? 'analyst' : 'system', actorUserId: input.actorUserId,
      detail: { sourceDocumentId: input.sourceDocumentId, provider: input.result.provider,
        apiVersion: input.result.apiVersion, modelId: input.result.modelId, responseHash },
    });
  }
  return { id: row.id, responseHash, created: row.created };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
