import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withTenantTx, type TenantContext } from '../db/tenant-context.js';
import { resolveAuthorizedTenantContext } from '../modules/findings/tenant-auth.js';
import { LocalDiskObjectStore } from '../modules/reference-data/object-store.js';
import { ingestInvoice, UnparseableEdiError } from '../modules/ingestion/ingest-invoice.js';

// Same object-store root convention as onboarding.ts's dev usage -- a fixed,
// configurable local-disk root, defaulting to a repo-relative path so a
// fresh checkout works without extra setup. Prod swaps this for an S3-backed
// ObjectStore behind the same interface (object-store.ts's own doc comment).
const OBJECT_STORE_ROOT = process.env.OBJECT_STORE_ROOT ?? './.data/object-store';

/**
 * 86e2v17u9: the first real EDI ingestion entry point -- POST /api/audit-runs
 * takes a raw X12 210/310 body and runs the full parse -> evaluate -> persist
 * chain (all pre-existing, tested at the DB layer, but never previously
 * called from any route).
 *
 * Encapsulated in its own domain module (86e2wb4zg's pattern) rather than
 * folded into findings-routes.ts -- a distinct resource (audit runs, not
 * findings) with its own preHandler instance, even though both instances
 * share the identical resolveAuthorizedTenantContext logic.
 *
 * Raw-body route: no @fastify/multipart (not installed, and unneeded -- EDI
 * is plain text per the item's own Solution). Registered with
 * addContentTypeParser scoped to THIS plugin instance only, so /health and
 * /api/findings* keep Fastify's default JSON/form parsing untouched.
 */
export async function registerAuditRunsRoutes(auditRunsRoutes: FastifyInstance): Promise<void> {
  auditRunsRoutes.addContentTypeParser(
    ['application/edi-x12', 'text/plain'],
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  auditRunsRoutes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await resolveAuthorizedTenantContext(request);
    if (!ctx) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    (request as FastifyRequest & { tenantContext: TenantContext }).tenantContext = ctx;
  });

  auditRunsRoutes.post('/api/audit-runs', async (request, reply) => {
    const ctx = (request as FastifyRequest & { tenantContext: TenantContext }).tenantContext;
    const clientId = ctx.clientIds?.[0];
    if (!clientId) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const rawBytes = request.body;
    if (!Buffer.isBuffer(rawBytes) || rawBytes.byteLength === 0) {
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

    try {
      const outcome = await withTenantTx(ctx, async (client) => {
        const store = new LocalDiskObjectStore(OBJECT_STORE_ROOT);
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
}
