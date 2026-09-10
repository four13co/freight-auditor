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
import { defaultExtractInvoiceFromText, type ExtractInvoiceFromTextImpl } from '../modules/ingestion/pdf-extract.js';
import { registerBufferContentTypeParser, requireNonEmptyBuffer, requireSingleClientId } from '../modules/ingestion/raw-upload-route.js';
import { isUuid } from '../shared/request-validation.js';
import type { ParsedInvoice } from '../modules/ingestion/charge-fact.js';

/**
 * 86e36yj9d: the client-portal Uploads section's Invoice-type surface --
 * upload a PDF, review the LLM-extracted fields, confirm-or-reject. Deliberately
 * its own resource, NOT a reuse of invoice-drafts-routes.ts's /api/invoice-drafts
 * (registered under the generic registerTenantAuthPreHandler, which grants any
 * membership role -- including client_viewer -- access): this surface must
 * structurally reject client_viewer, so it's gated by
 * registerClientAdminAuthPreHandler instead, inside its own register() scope
 * so scripts/check-analyst-only-gating.mjs's static check recognizes the gate.
 * The underlying business logic (createInvoiceDraft/confirmInvoiceDraft/
 * rejectInvoiceDraft) is reused unchanged from invoice-draft.ts -- only the
 * route/auth layer is new.
 *
 * extractImpl is threaded through from the caller (app.ts's buildApp options)
 * rather than left to createInvoiceDraft's own default -- the same injectable-
 * seam pattern pdf-extract.ts's header comment names (rollbackImpl/runImpl/
 * triggerBuildImpl), so a real-session e2e run (which cannot mock a module
 * import the way a vitest unit/db test can) can still get a deterministic
 * extraction result without ever reaching the live Anthropic API. See
 * src/server/e2e-fake-extraction.ts for that test-only implementation and
 * index.ts for the one place it's wired in (behind an env flag, never
 * reachable from a request).
 */
export function registerPortalUploadsRoutes(
  extractImpl: ExtractInvoiceFromTextImpl = defaultExtractInvoiceFromText,
) {
  return async function portalUploadsRoutes(app: FastifyInstance): Promise<void> {
    await app.register(async (routes) => {
      await registerClientAdminAuthPreHandler(routes);
      registerBufferContentTypeParser(routes, ['application/pdf']);

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
            return createInvoiceDraft(client, store, {
              clientId,
              pdfBytes,
              contentType: request.headers['content-type'],
            }, extractImpl);
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
  };
}
