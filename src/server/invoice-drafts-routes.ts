import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { LocalDiskObjectStore } from '../modules/reference-data/object-store.js';
import {
  createInvoiceDraft,
  confirmInvoiceDraft,
  DraftNotFoundError,
  DraftAlreadyConfirmedError,
  DraftAlreadyFinalizedError,
  CarrierRequiredError,
  CorrectedInvoiceSchema,
  rejectInvoiceDraft,
  UnextractablePdfError,
} from '../modules/ingestion/invoice-draft.js';
import { objectStoreRoot, registerBufferContentTypeParser, requireNonEmptyBuffer, requireSingleClientId } from '../modules/ingestion/raw-upload-route.js';
import { isUuid } from '../shared/request-validation.js';
import type { ParsedInvoice } from '../modules/ingestion/charge-fact.js';

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
  registerBufferContentTypeParser(routes, ['application/pdf']);
  await registerTenantAuthPreHandler(routes);

  routes.post('/api/invoice-drafts', async (request, reply) => {
    const ctx = request.tenantContext!;
    const clientId = requireSingleClientId(ctx);
    if (!clientId) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const pdfBytes = requireNonEmptyBuffer(request.body);
    if (!pdfBytes) {
      await reply.code(400).send({ error: 'request body must be a non-empty PDF payload' });
      return;
    }

    try {
      const draft = await withTenantTx(ctx, async (client) => {
        const store = new LocalDiskObjectStore(objectStoreRoot());
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
    const ctx = request.tenantContext!;
    const clientId = requireSingleClientId(ctx);
    if (!clientId) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid draft id: must be a well-formed UUID' });
      return;
    }
    if (body.carrierId !== undefined && (typeof body.carrierId !== 'string' || !isUuid(body.carrierId))) {
      await reply.code(400).send({ error: 'invalid carrierId: must be a well-formed UUID' });
      return;
    }
    if (body.contractVersionId !== undefined && (typeof body.contractVersionId !== 'string' || !isUuid(body.contractVersionId))) {
      await reply.code(400).send({ error: 'invalid contractVersionId: must be a well-formed UUID' });
      return;
    }
    const corrected = body.correctedPayload === undefined
      ? undefined
      : CorrectedInvoiceSchema.safeParse(body.correctedPayload);
    if (corrected && !corrected.success) {
      await reply.code(400).send({ error: 'invalid correctedPayload', details: corrected.error.issues });
      return;
    }

    try {
      const result = await withTenantTx(ctx, async (client) =>
        confirmInvoiceDraft(client, {
          clientId,
          draftId: id,
          correctedPayload: corrected?.data
            ? {
                ...corrected.data,
                charges: corrected.data.charges.map((charge) => ({ ...charge, amount: charge.amount })),
              } satisfies ParsedInvoice
            : undefined,
          carrierId: body.carrierId as string | undefined,
          contractVersionId: body.contractVersionId as string | undefined,
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
      if (err instanceof DraftAlreadyFinalizedError) {
        await reply.code(409).send({ error: err.message });
        return;
      }
      if (err instanceof CarrierRequiredError) {
        await reply.code(422).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  routes.post('/api/invoice-drafts/:id/reject', async (request, reply) => {
    const ctx = request.tenantContext!;
    if (!requireSingleClientId(ctx)) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid draft id: must be a well-formed UUID' });
      return;
    }
    try {
      await withTenantTx(ctx, (client) => rejectInvoiceDraft(client, id));
      await reply.code(200).send({ id, status: 'rejected' });
    } catch (err) {
      if (err instanceof DraftNotFoundError) {
        await reply.code(404).send({ error: err.message });
        return;
      }
      if (err instanceof DraftAlreadyFinalizedError) {
        await reply.code(409).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
