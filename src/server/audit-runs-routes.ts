import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { runtimeObjectStore } from '../modules/reference-data/object-store-config.js';
import { ingestInvoice, UnparseableEdiError } from '../modules/ingestion/ingest-invoice.js';
import { registerBufferContentTypeParser, requireNonEmptyBuffer, requireSingleClientId } from '../modules/ingestion/raw-upload-route.js';
import { isUuid } from '../shared/request-validation.js';
import {
  replayAuditRun,
  ReplayIntegrityError,
  ReplayNotFoundError,
  ReplayUnavailableError,
} from '../modules/audit-ledger/replay-audit-run.js';

// 86e2xcn18: contract_version_id binds against a uuid column
// (lookupContractRate's SQL, migration 0011) -- a non-UUID value throws
// Postgres error 22P02, which isn't UnparseableEdiError, so it fell through
// to Fastify's default handler and reflected raw Postgres error detail into
// the 500 body. Same boundary-validation convention as findings-routes.ts's
// NUMERIC_STRING check: validate before the value ever reaches a query.
// Standard UUID shape (any RFC 4122 version, including the plain hex the
// gen_random_uuid()-generated ids in this repo already have) -- not
// version-restrictive, since nothing here needs to assert a specific UUID
// version.

/**
 * 86e2v17u9: the first real EDI ingestion entry point -- POST /api/audit-runs
 * takes a raw X12 210/310 body and runs the full parse -> evaluate -> persist
 * chain (all pre-existing, tested at the DB layer, but never previously
 * called from any route).
 *
 * Encapsulated in its own domain module (86e2wb4zg's pattern) rather than
 * folded into findings-routes.ts -- a distinct resource (audit runs, not
 * findings) with its own preHandler instance, even though both instances
 * opt into the shared registerTenantAuthPreHandler logic.
 *
 * Raw-body route: no @fastify/multipart (not installed, and unneeded -- EDI
 * is plain text per the item's own Solution). Registered with
 * addContentTypeParser scoped to THIS plugin instance only, so /health and
 * /api/findings* keep Fastify's default JSON/form parsing untouched.
 */
export async function registerAuditRunsRoutes(auditRunsRoutes: FastifyInstance): Promise<void> {
  registerBufferContentTypeParser(auditRunsRoutes, ['application/edi-x12', 'text/plain']);

  await registerTenantAuthPreHandler(auditRunsRoutes);

  auditRunsRoutes.post('/api/audit-runs', async (request, reply) => {
    const ctx = request.tenantContext!;
    const clientId = requireSingleClientId(ctx);
    if (!clientId) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const rawBytes = requireNonEmptyBuffer(request.body);
    if (!rawBytes) {
      await reply.code(400).send({ error: 'request body must be a non-empty raw EDI payload' });
      return;
    }

    // Greg's DECISION (2026-08-20): accept contract_version_id as an
    // explicit, optional query param -- the caller is expected to already
    // know which contract an invoice belongs to (option b). No body field
    // (the body is the raw EDI text itself, not a JSON envelope) and no
    // header (this isn't identity/content-negotiation, it's a request
    // parameter) -- a query param is the natural fit given the body is
    // already fully occupied by the raw payload.
    const query = request.query as Record<string, string | undefined>;
    const contractVersionId = query.contract_version_id;

    if (contractVersionId !== undefined && !isUuid(contractVersionId)) {
      await reply.code(400).send({ error: 'invalid contract_version_id: must be a well-formed UUID' });
      return;
    }

    try {
      const outcome = await withTenantTx(ctx, async (client) => {
        const store = runtimeObjectStore();
        return ingestInvoice(client, store, {
          clientId,
          rawBytes,
          contentType: request.headers['content-type'],
          contractVersionId,
        });
      });
      await reply.code(201).send({ id: outcome.auditRunId, outcome: outcome.outcome });
    } catch (err) {
      if (err instanceof UnparseableEdiError) {
        await reply.code(422).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  auditRunsRoutes.post('/api/audit-runs/:id/replay', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid audit run id: must be a well-formed UUID' });
      return;
    }
    try {
      const replay = await withTenantTx(request.tenantContext!, (client) => replayAuditRun(client, id));
      return replay;
    } catch (error) {
      if (error instanceof ReplayNotFoundError) {
        await reply.code(404).send({ error: error.message });
        return;
      }
      if (error instanceof ReplayIntegrityError) {
        await reply.code(409).send({ error: error.code });
        return;
      }
      if (error instanceof ReplayUnavailableError) {
        await reply.code(422).send({ error: error.code });
        return;
      }
      throw error;
    }
  });
}
