import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { withTenantTx } from '../db/tenant-context.js';
import { registerClientAdminAuthPreHandler } from '../modules/identity/client-admin-auth.js';
import { runtimeObjectStore } from '../modules/reference-data/object-store-config.js';
import {
  ContractUploadConflictError,
  ContractUploadMetadataSchema,
  uploadContractDocument,
} from '../modules/contracts/upload-contract-document.js';
import { registerBufferContentTypeParser, requireNonEmptyBuffer, requireSingleClientId } from '../modules/ingestion/raw-upload-route.js';

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

/**
 * 86e36yrne: the client portal's own Uploads-section entry point for the
 * Contract document type -- same shape as portal-invoice-upload-routes.ts
 * (86e36yj9d): a separate plugin registration under /api/portal/contracts,
 * gated by client-admin-auth.ts's registerClientAdminAuthPreHandler (this
 * task's own Solution: "Gated the same way as the Invoice type"), wrapping
 * the same domain function contracts-routes.ts's internal POST /api/contracts
 * already uses (uploadContractDocument) rather than duplicating it.
 *
 * contracts-routes.ts's own /api/contracts route is left unmodified -- its
 * gating (registerTenantAuthPreHandler) and callers are untouched, exactly
 * like invoice-drafts-routes.ts was left untouched by the Invoice-type task.
 *
 * No AI extraction step exists for contracts (unlike the Invoice type), so
 * unlike portal-upload-extraction-stub.ts there is no extraction seam here:
 * the client supplies carrierId/name/versionLabel/validFrom/validTo
 * directly, exactly as ContractUploadMetadataSchema (upload-contract-
 * document.ts) already requires from the internal route today.
 */
export async function registerPortalContractUploadRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (routes) => {
    registerBufferContentTypeParser(routes, contentTypes);
    await registerClientAdminAuthPreHandler(routes);

    routes.post('/api/portal/contracts', async (request, reply) => {
      const ctx = request.tenantContext!;
      const clientId = requireSingleClientId(ctx);
      if (!clientId) {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }

      const bytes = requireNonEmptyBuffer(request.body);
      if (!bytes) {
        await reply.code(400).send({ error: 'request body must be a non-empty PDF or XLSX payload' });
        return;
      }

      try {
        const metadata = ContractUploadMetadataSchema.parse(metadataFromQuery(request));
        const result = await withTenantTx(ctx, (client) => uploadContractDocument(client, runtimeObjectStore(), {
          clientId,
          actorUserId: request.actorUserId ?? null,
          bytes,
          contentType: request.headers['content-type']!,
          metadata,
        }));
        await reply.code(result.created ? 201 : 200).send(result);
      } catch (err) {
        if (err instanceof ZodError) {
          await reply.code(400).send({ error: 'invalid contract upload metadata', details: err.issues });
          return;
        }
        if (err instanceof ContractUploadConflictError) {
          await reply.code(409).send({ error: err.message });
          return;
        }
        throw err;
      }
    });
  });
}
