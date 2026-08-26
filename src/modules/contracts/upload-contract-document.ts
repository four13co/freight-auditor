import type pg from 'pg';
import { z } from 'zod';
import type { ObjectStore } from '../reference-data/object-store.js';
import { storeSourceDocument } from '../reference-data/source-document.js';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
const versionMetadataShape = {
  versionLabel: z.string().trim().min(1).max(100).optional(),
  validFrom: isoDate,
  validTo: isoDate.optional(),
};
const validDateRange = (value: { validFrom: string; validTo?: string }) => !value.validTo || value.validTo > value.validFrom;
export const ContractUploadMetadataSchema = z.object({
  carrierId: z.string().uuid(),
  name: z.string().trim().min(1).max(300),
  ...versionMetadataShape,
}).strict().refine(validDateRange, {
  message: 'validTo must be after validFrom', path: ['validTo'],
});

export const ContractVersionUploadMetadataSchema = z.object(versionMetadataShape).strict().refine(validDateRange, {
  message: 'validTo must be after validFrom', path: ['validTo'],
});
export type ContractUploadMetadata = z.infer<typeof ContractUploadMetadataSchema>;
export type ContractVersionUploadMetadata = z.infer<typeof ContractVersionUploadMetadataSchema>;

export class ContractUploadConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'ContractUploadConflictError'; }
}
export class ContractNotFoundError extends Error {
  constructor() { super('contract not found'); this.name = 'ContractNotFoundError'; }
}

interface UploadInput {
  clientId: string;
  actorUserId: string | null;
  bytes: Buffer;
  contentType: string;
  metadata: ContractUploadMetadata;
}

export interface ContractUploadResult {
  contractId: string;
  contractVersionId: string;
  sourceDocumentId: string;
  sha256: string;
  created: boolean;
}

async function existingUpload(client: pg.PoolClient, clientId: string, sourceDocumentId: string): Promise<ContractUploadResult | null> {
  const result = await client.query<{ contract_id: string; id: string; sha256: string }>(
    `SELECT cv.contract_id, cv.id, sd.sha256 FROM contract_version cv
     JOIN source_document sd ON sd.id = cv.source_document_id
     WHERE cv.client_id = $1 AND cv.source_document_id = $2`,
    [clientId, sourceDocumentId],
  );
  const row = result.rows[0];
  return row ? { contractId: row.contract_id, contractVersionId: row.id, sourceDocumentId, sha256: row.sha256, created: false } : null;
}

async function storeUploadDocument(client: pg.PoolClient, store: ObjectStore, input: Pick<UploadInput, 'clientId' | 'bytes' | 'contentType'>) {
  const source = await storeSourceDocument(client, store, input);
  if (!source.ownedByCaller) throw new ContractUploadConflictError('identical source document is owned by another tenant');
  return source;
}

export async function uploadContractDocument(client: pg.PoolClient, store: ObjectStore, input: UploadInput): Promise<ContractUploadResult> {
  const metadata = ContractUploadMetadataSchema.parse(input.metadata);
  const source = await storeUploadDocument(client, store, input);
  const retry = await existingUpload(client, input.clientId, source.id);
  if (retry) return retry;

  const carrier = await client.query(`SELECT 1 FROM carrier WHERE id = $1`, [metadata.carrierId]);
  if (!carrier.rowCount) throw new ContractUploadConflictError('carrier not found');
  const contract = await client.query<{ id: string }>(
    `INSERT INTO contract (client_id, carrier_id, name) VALUES ($1,$2,$3) RETURNING id`,
    [input.clientId, metadata.carrierId, metadata.name],
  );
  const contractId = contract.rows[0]!.id;
  return insertVersion(client, input, source, contractId, metadata);
}

export async function uploadContractVersionDocument(
  client: pg.PoolClient,
  store: ObjectStore,
  input: Omit<UploadInput, 'metadata'> & { contractId: string; metadata: ContractVersionUploadMetadata },
): Promise<ContractUploadResult> {
  const metadata = ContractVersionUploadMetadataSchema.parse(input.metadata);
  const source = await storeUploadDocument(client, store, input);
  const retry = await existingUpload(client, input.clientId, source.id);
  if (retry) {
    if (retry.contractId !== input.contractId) throw new ContractUploadConflictError('source document already belongs to another contract');
    return retry;
  }
  const found = await client.query(`SELECT 1 FROM contract WHERE id = $1 AND client_id = $2`, [input.contractId, input.clientId]);
  if (!found.rowCount) throw new ContractNotFoundError();
  return insertVersion(client, input, source, input.contractId, metadata);
}

async function insertVersion(
  client: pg.PoolClient,
  input: Omit<UploadInput, 'metadata'>,
  source: { id: string; sha256: string },
  contractId: string,
  metadata: ContractVersionUploadMetadata,
): Promise<ContractUploadResult> {
  const version = await client.query<{ id: string }>(
    `INSERT INTO contract_version (client_id, contract_id, version_label, valid_from, valid_to, source_document_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.clientId, contractId, metadata.versionLabel ?? null, metadata.validFrom, metadata.validTo ?? null, source.id],
  );
  const contractVersionId = version.rows[0]!.id;
  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, contractVersionId, 'contract_version.uploaded'),
    clientId: input.clientId,
    entity: 'contract_version', entityId: contractVersionId, event: 'uploaded',
    actorKind: input.actorUserId ? 'analyst' : 'system', actorUserId: input.actorUserId,
    detail: { contractId, sourceDocumentId: source.id, sha256: source.sha256 },
  });
  return { contractId, contractVersionId, sourceDocumentId: source.id, sha256: source.sha256, created: true };
}
