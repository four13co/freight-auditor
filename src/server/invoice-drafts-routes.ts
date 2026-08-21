import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withTenantTx, type TenantContext } from '../db/tenant-context.js';
import { resolveAuthorizedTenantContext } from '../modules/findings/tenant-auth.js';
import { LocalDiskObjectStore } from '../modules/reference-data/object-store.js';
import {
  createInvoiceDraft,
  confirmInvoiceDraft,
  DraftNotFoundError,
  DraftAlreadyConfirmedError,
  UnextractablePdfError,
} from '../modules/ingestion/invoice-draft.js';
import type { ParsedInvoice } from '../modules/ingestion/charge-fact.js';

const OBJECT_STORE_ROOT = process.env.OBJECT_STORE_ROOT ?? './.data/object-store';

/**
 * 86e2xb911: PDF invoice upload -> LLM-extracted draft -> human review/
 * correct -> confirm. A new, separate resource from audit-runs-routes.ts
 * (86e2v17u9) -- additive only, per the item's No-gos (does not change the
 * existing EDI path).
 *
 * Same tenant-auth preHandler + raw-body content-type-parser pattern as
 * audit-runs-routes.ts, scoped to this plugin instance only.
 */
export async function registerInvoiceDraftsRoutes(routes: FastifyInstance): Promise<void> {
  routes.addContentTypeParser(
    ['application/pdf'],
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await resolveAuthorizedTenantContext(request);
    if (!ctx) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    (request as FastifyRequest & { tenantContext: TenantContext }).tenantContext = ctx;
  });

  routes.post('/api/invoice-drafts', async (request, reply) => {
    const ctx = (request as FastifyRequest & { tenantContext: TenantContext }).tenantContext;
    const clientId = ctx.clientIds?.[0];
    if (!clientId) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const pdfBytes = request.body;
    if (!Buffer.isBuffer(pdfBytes) || pdfBytes.byteLength === 0) {
      await reply.code(400).send({ error: 'request body must be a non-empty PDF payload' });
      return;
    }

    try {
      const draft = await withTenantTx(ctx, async (client) => {
        const store = new LocalDiskObjectStore(OBJECT_STORE_ROOT);
        return createInvoiceDraft(client, store, {
          clientId,
          pdfBytes,
          contentType: request.headers['content-type'],
        });
      });
      await reply.code(201).send({
        id: draft.id,
        status: draft.status,
        extractedPayload: draft.extractedPayload,
        carrierCandidates: draft.carrierCandidates,
      });
    } catch (err) {
      if (err instanceof UnextractablePdfError) {
        await reply.code(422).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  routes.post('/api/invoice-drafts/:id/confirm', async (request, reply) => {
    const ctx = (request as FastifyRequest & { tenantContext: TenantContext }).tenantContext;
    const clientId = ctx.clientIds?.[0];
    if (!clientId) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      correctedPayload?: ParsedInvoice;
      carrierId?: string;
      contractVersionId?: string;
    };

    try {
      const result = await withTenantTx(ctx, async (client) =>
        confirmInvoiceDraft(client, {
          clientId,
          draftId: id,
          correctedPayload: body.correctedPayload,
          carrierId: body.carrierId,
          contractVersionId: body.contractVersionId,
        }),
      );
      await reply.code(201).send({ auditRunId: result.auditRunId });
    } catch (err) {
      if (err instanceof DraftNotFoundError) {
        await reply.code(404).send({ error: err.message });
        return;
      }
      if (err instanceof DraftAlreadyConfirmedError) {
        await reply.code(409).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
