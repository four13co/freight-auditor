import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { runtimeObjectStore } from '../modules/reference-data/object-store-config.js';
import {
  ContractNotFoundError,
  ContractUploadConflictError,
  ContractUploadMetadataSchema,
  ContractVersionUploadMetadataSchema,
  uploadContractDocument,
  uploadContractVersionDocument,
} from '../modules/contracts/upload-contract-document.js';
import { registerBufferContentTypeParser, requireNonEmptyBuffer, requireSingleClientId } from '../modules/ingestion/raw-upload-route.js';
import { isUuid } from '../shared/request-validation.js';
import { FinalizeContractVersionInputSchema, ContractVersionFinalizationError } from '../modules/contracts/finalize-contract-version-schema.js';
import { finalizeContractVersion } from '../modules/contracts/finalize-contract-version.js';

const contentTypes = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

function metadataFromQuery(request: FastifyRequest): Record<string, unknown> {
  const query = request.query as Record<string, unknown>;
  return {
    carrierId: query.carrier_id,
    name: query.name,
    versionLabel: query.version_label,
    validFrom: query.valid_from,
    validTo: query.valid_to,
  };
}

function versionMetadataFromQuery(request: FastifyRequest): Record<string, unknown> {
  const query = request.query as Record<string, unknown>;
  return { versionLabel: query.version_label, validFrom: query.valid_from, validTo: query.valid_to };
}

export async function registerContractsRoutes(routes: FastifyInstance): Promise<void> {
  registerBufferContentTypeParser(routes, contentTypes);
  await registerTenantAuthPreHandler(routes);

  routes.post('/api/contracts', async (request, reply) => {
    const ctx = request.tenantContext!;
    const clientId = requireSingleClientId(ctx);
    if (!clientId) return reply.code(401).send({ error: 'unauthorized' });
    const bytes = requireNonEmptyBuffer(request.body);
    if (!bytes) return reply.code(400).send({ error: 'request body must be a non-empty PDF or XLSX payload' });
    try {
      const metadata = ContractUploadMetadataSchema.parse(metadataFromQuery(request));
      const result = await withTenantTx(ctx, (client) => uploadContractDocument(client, runtimeObjectStore(), {
        clientId, actorUserId: request.actorUserId ?? null, bytes,
        contentType: request.headers['content-type']!, metadata,
      }));
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid contract upload metadata', details: error.issues });
      if (error instanceof ContractUploadConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  routes.post('/api/contracts/:id/versions', async (request, reply) => {
    const ctx = request.tenantContext!;
    const clientId = requireSingleClientId(ctx);
    if (!clientId) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.code(400).send({ error: 'invalid contract id: must be a well-formed UUID' });
    const bytes = requireNonEmptyBuffer(request.body);
    if (!bytes) return reply.code(400).send({ error: 'request body must be a non-empty PDF or XLSX payload' });
    try {
      const metadata = ContractVersionUploadMetadataSchema.parse(versionMetadataFromQuery(request));
      const result = await withTenantTx(ctx, (client) => uploadContractVersionDocument(client, runtimeObjectStore(), {
        clientId, actorUserId: request.actorUserId ?? null, contractId: id, bytes,
        contentType: request.headers['content-type']!, metadata,
      }));
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid contract version upload metadata', details: error.issues });
      if (error instanceof ContractNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ContractUploadConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  routes.post('/api/contract-versions/:id/finalize', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.code(400).send({ error: 'invalid contract version id' });
    const clientId = requireSingleClientId(request.tenantContext!);
    if (!clientId || !request.actorUserId) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const body = FinalizeContractVersionInputSchema.parse(request.body);
      const result = await withTenantTx(request.tenantContext!, (client) => finalizeContractVersion(client, {
        clientId, contractVersionId: id, actorUserId: request.actorUserId!, extractionResponseHash: body.extraction_response_hash,
      }));
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid contract finalization', details: error.issues });
      if (error instanceof ContractVersionFinalizationError) {
        const status = error.code === 'CONTRACT_VERSION_NOT_FOUND' || error.code === 'EXTRACTION_NOT_FOUND' ? 404 : 409;
        return reply.code(status).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });
}
