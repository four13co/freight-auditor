import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerClientAdminAuthPreHandler } from '../modules/identity/client-admin-auth.js';
import { runtimeObjectStore } from '../modules/reference-data/object-store-config.js';
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
import { registerBufferContentTypeParser, requireNonEmptyBuffer, requireSingleClientId } from '../modules/ingestion/raw-upload-route.js';
import { resolvePortalUploadExtractionImpl } from '../modules/ingestion/portal-upload-extraction-stub.js';
import { isUuid } from '../shared/request-validation.js';
import type { ParsedInvoice } from '../modules/ingestion/charge-fact.js';

/**
 * 86e36yj9d: the client portal's own Uploads-section entry point onto the
 * invoice-draft pipeline (86e2xb911, invoice-drafts-routes.ts) -- a
 * separate plugin registration under /api/portal/invoice-drafts, gated by
 * client-admin-auth.ts's registerClientAdminAuthPreHandler, per this task's
 * own Solution ("not the generic registerTenantAuthPreHandler") and Rabbit
 * holes ("the new client_admin-gated upload route(s) belong in their own
 * file/plugin registration, not bolted onto [portal-content-routes.ts]").
 *
 * invoice-drafts-routes.ts's own /api/invoice-drafts routes are left
 * unmodified -- its fullstack e2e specs (invoice-draft-confirm/reject)
 * authenticate as DEV_USER_ID, whose seeded membership role is 'analyst'
 * (seed-dev-tenant.mjs), not 'client_admin'; narrowing that route's own
 * auth would 401 those specs. This file wraps the same domain functions
 * (invoice-draft.ts) with a second, client_admin-only HTTP surface instead,
 * so the two auth contracts ship and are reviewable independently, exactly
 * like client-admin-auth.ts's own module header anticipated.
 */
export async function registerPortalInvoiceUploadRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (routes) => {
    registerBufferContentTypeParser(routes, ['application/pdf']);
    await registerClientAdminAuthPreHandler(routes);

    routes.post('/api/portal/invoice-drafts', async (request, reply) => {
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
          const store = runtimeObjectStore();
          const stubExtractImpl = resolvePortalUploadExtractionImpl();
          const input = { clientId, pdfBytes, contentType: request.headers['content-type'] };
          return stubExtractImpl
            ? createInvoiceDraft(client, store, input, stubExtractImpl)
            : createInvoiceDraft(client, store, input);
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

    routes.post('/api/portal/invoice-drafts/:id/confirm', async (request, reply) => {
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

    routes.post('/api/portal/invoice-drafts/:id/reject', async (request, reply) => {
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
  });
}
